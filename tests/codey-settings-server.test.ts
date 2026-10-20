import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { invalidateConfigCache } from "~/lib/config-store"
import { closeUsageStore } from "~/lib/token-usage"
import { createServer } from "~/server"

const originalPaths = { ...PATHS }
const originalSettings = process.env.CODEY_SETTINGS_FILE
const originalDatabase = process.env.COPILOT_API_SQLITE_DB_PATH
const originalFetch = globalThis.fetch
let directory: string
let settingsFile: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "codey-settings-server-"))
  PATHS.APP_DIR = directory
  PATHS.CONFIG_PATH = path.join(directory, "gateway.json")
  PATHS.GITHUB_TOKEN_PATH = path.join(directory, "github-token")
  PATHS.CODEX_CREDENTIAL_PATH = path.join(directory, "codex.json")
  PATHS.XAI_CREDENTIAL_PATH = path.join(directory, "xai.json")
  process.env.COPILOT_API_SQLITE_DB_PATH = path.join(directory, "usage.sqlite")
  settingsFile = path.join(directory, "settings.json")
  process.env.CODEY_SETTINGS_FILE = settingsFile
  fs.writeFileSync(
    PATHS.CONFIG_PATH,
    JSON.stringify({
      auth: { apiKeys: ["model-test-key"], adminApiKey: "admin-test-key" },
      providers: { "github-copilot": { enabled: false } },
      claudeAutoModel: "",
    }),
    { mode: 0o600 },
  )
  invalidateConfigCache()
})
afterEach(async () => {
  await closeUsageStore()
  Object.assign(PATHS, originalPaths)
  if (originalSettings === undefined) delete process.env.CODEY_SETTINGS_FILE
  else process.env.CODEY_SETTINGS_FILE = originalSettings
  if (originalDatabase === undefined)
    delete process.env.COPILOT_API_SQLITE_DB_PATH
  else process.env.COPILOT_API_SQLITE_DB_PATH = originalDatabase
  globalThis.fetch = originalFetch
  invalidateConfigCache()
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw Error("Unsafe cleanup")
  try {
    fs.rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    // Bun/Windows can retain SQLite mappings until process exit even after
    // closeUsageStore. Keep only this private, synthetic fixture in that case.
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error
  }
})

test("corrupt node settings cannot disable auth and never fall back for inference", async () => {
  fs.writeFileSync(settingsFile, '{"key":"private-secret",bad', { mode: 0o600 })
  const server = createServer()
  const rejected = await server.request("/models", {
    headers: { Authorization: "Bearer wrong-key" },
  })
  expect(rejected.status).toBe(401)
  const blocked = await server.request("/models", {
    headers: { Authorization: "Bearer model-test-key" },
  })
  expect(blocked.status).toBe(503)
  expect(await blocked.text()).not.toContain("private-secret")
  const admin = await server.request("/admin/config/codey-settings", {
    headers: { Authorization: "Bearer admin-test-key" },
  })
  expect(admin.status).toBe(503)
  expect(await admin.text()).toContain("invalid JSON")
  expect((await server.request("/")).status).toBe(200)
})

test("the real Messages route uses the selected proxy key and exact upstream model", async () => {
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      additionalCopilotProxies: [
        {
          id: "selected",
          endpoint: "https://selected.example",
          key: "selected-proxy-key",
          models: ["claude-opus-5.5"],
        },
      ],
    }),
    { mode: 0o600 },
  )
  const upstreamRequests: Array<{ url: string; model: string }> = []
  globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
    const endpoint =
      typeof url === "string" ? url
      : url instanceof URL ? url.toString()
      : url.url
    expect(endpoint).toBe("https://selected.example/v1/messages")
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer selected-proxy-key",
    )
    if (typeof options?.body !== "string")
      throw new Error("Expected a serialized Messages payload")
    const body = JSON.parse(options.body) as { model: string }
    upstreamRequests.push({ url: endpoint, model: body.model })
    return Promise.resolve(
      Response.json({
        id: "msg-test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5.5",
        content: [{ type: "text", text: "PROXY_OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
  }) as typeof fetch
  const response = await createServer().request("/v1/messages", {
    method: "POST",
    headers: {
      Authorization: "Bearer model-test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-5.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "Return PROXY_OK" }],
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("PROXY_OK")
  expect(upstreamRequests).toEqual([
    { url: "https://selected.example/v1/messages", model: "claude-opus-5.5" },
  ])
})

test("legacy model mapping edits cannot persist derived settings-file routes", async () => {
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      additionalCopilotProxies: [
        {
          id: "selected",
          endpoint: "https://selected.example",
          key: "proxy-test-key",
          models: ["claude-opus-5.5"],
        },
      ],
    }),
    { mode: 0o600 },
  )
  const before = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
  const server = createServer()
  const headers = {
    Authorization: "Bearer admin-test-key",
    "Content-Type": "application/json",
  }
  const current = await server.request("/admin/config/model-mappings", {
    headers,
  })
  expect(await current.text()).not.toContain("codey-extra-selected")
  const rejected = await server.request("/admin/config/model-mappings", {
    method: "POST",
    headers,
    body: JSON.stringify({
      modelMappings: {
        "claude-opus-5.5": "codey-extra-selected/claude-opus-5.5",
      },
    }),
  })
  expect(rejected.status).toBe(400)
  expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toBe(before)
})
