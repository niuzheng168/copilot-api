import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createAuthMiddleware } from "~/lib/request-auth"
import { configRoutes } from "~/routes/admin/config/route"

let directory: string
const original = process.env.CODEY_SETTINGS_FILE
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "codey-settings-route-"))
  process.env.CODEY_SETTINGS_FILE = path.join(directory, "settings.json")
})
afterEach(() => {
  if (original === undefined) delete process.env.CODEY_SETTINGS_FILE
  else process.env.CODEY_SETTINGS_FILE = original
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw Error("Unsafe cleanup")
  fs.rmSync(directory, { recursive: true, force: true })
})
function app() {
  const server = new Hono()
  server.use(
    "/admin/*",
    createAuthMiddleware({
      getApiKeys: () => ["private-admin-test"],
      allowWhenNoApiKeys: false,
    }),
  )
  server.route("/admin/config", configRoutes)
  return server
}
const endpoint = "/admin/config/codey-settings"
const headers = {
  Authorization: "Bearer private-admin-test",
  "Content-Type": "application/json",
}

test("file-backed settings require the admin scope", async () => {
  for (const key of ["", "model-api-key"]) {
    const response = await app().request(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
    })
    expect(response.status).toBe(401)
  }
})

test("GET and PUT are redacted and revisions reject concurrent bulk edits", async () => {
  const server = app()
  const initial = (await (
    await server.request(endpoint, { headers })
  ).json()) as { revision: string }
  const update = {
    revision: initial.revision,
    additionalCopilotProxies: [
      {
        id: "additional",
        enabled: true,
        endpoint: "https://proxy.example",
        key: "private-proxy-test",
        models: ["claude-opus-5.5"],
      },
    ],
  }
  const saved = await server.request(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify(update),
  })
  expect(saved.status).toBe(200)
  expect(await saved.text()).not.toContain("private-proxy-test")
  expect(fs.readFileSync(process.env.CODEY_SETTINGS_FILE!, "utf8")).toContain(
    "private-proxy-test",
  )
  const stale = await server.request(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify(update),
  })
  expect(stale.status).toBe(409)
}, 15_000)

test("malformed documents and requests return bounded secret-free errors", async () => {
  const invalid = await app().request(endpoint, {
    method: "PUT",
    headers,
    body: '{"key":"private-key",bad',
  })
  expect(invalid.status).toBe(400)
  expect(await invalid.text()).not.toContain("private-key")
  fs.writeFileSync(
    process.env.CODEY_SETTINGS_FILE!,
    '{"key":"private-key",bad',
    { mode: 0o600 },
  )
  const corrupt = await app().request(endpoint, { headers })
  expect(corrupt.status).toBe(503)
  expect(await corrupt.text()).not.toContain("private-key")
})
