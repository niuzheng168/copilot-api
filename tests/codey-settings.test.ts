import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createCodeySettings } from "~/lib/codey-settings"

let directory: string
let file: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "codey-settings-test-"))
  file = path.join(directory, "codey/settings.json")
})
afterEach(() => {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error("Unsafe test cleanup")
  fs.rmSync(directory, { recursive: true, force: true })
})

const proxy = (overrides: Record<string, unknown> = {}) => ({
  id: "extra",
  enabled: true,
  endpoint: "http://127.0.0.1:4155",
  key: "private-test-key",
  models: ["claude-opus-5.5"],
  ...overrides,
})
const store = () =>
  createCodeySettings({ environment: { CODEY_SETTINGS_FILE: file } })
function write(value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
}
const readDisk = () =>
  JSON.parse(fs.readFileSync(file, "utf8")) as {
    anotherSetting?: unknown
    marker?: string
    additionalCopilotProxies: Array<{ key: string }>
  }

test("ordinary Copilot has no Codey overlay and managed nodes resolve the documented path", () => {
  const base = { modelMappings: { original: "original-model" } }
  expect(createCodeySettings({ environment: {} }).overlay(base)).toBe(base)
  const managed = createCodeySettings({
    environment: { CODEY_MANAGED: "true" },
    home: () => directory,
  })
  expect(managed.status().settingsFile).toBe(
    path.join(directory, ".config/codey/settings.json"),
  )
  expect(managed.status().additionalCopilotProxies).toEqual([])
  expect(() =>
    createCodeySettings({
      environment: { CODEY_SETTINGS_FILE: "relative.json" },
    }).status(),
  ).toThrow("absolute")
})

test("save is private, redacted, revisioned, and preserves unrelated node settings", () => {
  file = path.join(directory, "codey-配置/settings.json")
  write({ anotherSetting: { retained: true } })
  const settings = store()
  const before = settings.status()
  const saved = settings.save({
    revision: before.revision,
    additionalCopilotProxies: [proxy()],
  })
  expect(saved.revision).not.toBe(before.revision)
  expect(JSON.stringify(saved)).not.toContain("private-test-key")
  expect(saved.additionalCopilotProxies[0].keyConfigured).toBe(true)
  const disk = readDisk()
  expect(disk.anotherSetting).toEqual({ retained: true })
  expect(disk.additionalCopilotProxies[0].key).toBe("private-test-key")
  if (process.platform !== "win32")
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(() =>
    settings.save({ revision: before.revision, additionalCopilotProxies: [] }),
  ).toThrow("changed")
  const updated = settings.save({
    revision: saved.revision,
    additionalCopilotProxies: [proxy({ key: "" })],
  })
  expect(readDisk().additionalCopilotProxies[0].key).toBe("private-test-key")
  const { key: _key, ...withoutKey } = proxy()
  settings.save({
    revision: updated.revision,
    additionalCopilotProxies: [withoutKey],
  })
  expect(readDisk().additionalCopilotProxies[0].key).toBe("private-test-key")
}, 20_000)

test("overlay routes only selected models without mutating the original gateway configuration", () => {
  write({
    additionalCopilotProxies: [
      proxy({ models: ["claude-opus-5.5", "gpt-6.1-sol"] }),
    ],
  })
  const settings = store()
  const base = {
    auth: { apiKeys: ["original"] },
    modelMappings: { other: "existing" },
    providers: {},
  }
  const snapshot = JSON.stringify(base)
  const configured = settings.overlay(base)
  expect(configured.modelMappings).toEqual({
    other: "existing",
    "claude-opus-5.5": "codey-extra-extra/claude-opus-5.5",
    "gpt-6.1-sol": "codey-extra-extra/gpt-6.1-sol",
  })
  expect(
    configured.providers?.["codey-extra-extra"].models?.["claude-opus-5.5"]
      .type,
  ).toBe("anthropic")
  expect(
    configured.providers?.["codey-extra-extra"].models?.["gpt-6.1-sol"].type,
  ).toBe("openai-responses")
  expect(JSON.stringify(base)).toBe(snapshot)
  expect(settings.selectedModels("codey-extra-extra")).toEqual([
    "claude-opus-5.5",
    "gpt-6.1-sol",
  ])
  expect(settings.selectedModels("other")).toBeUndefined()
  expect(() =>
    settings.overlay({ providers: { "codey-extra-extra": {} } }),
  ).toThrow("conflicts")
})

test("direct atomic file replacement, disable, and removal hot-load without restarting", () => {
  const settings = store()
  const initial = settings.status().revision
  write({ additionalCopilotProxies: [proxy()] })
  expect(settings.status().revision).not.toBe(initial)
  expect(settings.status()).toEqual(settings.status())
  const replacement = `${file}.next`
  fs.writeFileSync(
    replacement,
    JSON.stringify({ additionalCopilotProxies: [proxy({ enabled: false })] }),
    { mode: 0o600 },
  )
  fs.renameSync(replacement, file)
  const base = { modelMappings: { "claude-opus-5.5": "original" } }
  expect(settings.overlay(base)).toBe(base)
  fs.unlinkSync(file)
  expect(settings.status().revision).toBe(initial)
})

test("malformed bulk edits fail closed and never expose key-bearing JSON errors", () => {
  write({ additionalCopilotProxies: [proxy()] })
  const settings = store()
  settings.status()
  fs.writeFileSync(file, '{"key":"private-test-key",broken')
  expect(() => settings.overlay({})).toThrow("invalid JSON")
  try {
    settings.status()
  } catch (error) {
    expect(String(error)).not.toContain("private-test-key")
  }
  fs.writeFileSync(file, " ".repeat(1024 * 1024 + 1))
  expect(() => settings.status()).toThrow("1 MiB")
  fs.unlinkSync(file)
  fs.mkdirSync(file)
  expect(() => settings.status()).toThrow("regular file")
})

test("validation rejects ambiguity, endpoint credential leakage, prototype keys, and unbounded input", () => {
  const invalid = [
    [proxy(), proxy()],
    [proxy(), proxy({ id: "second" })],
    [proxy({ models: ["claude-opus-5.5", "claude-opus-5.5"] })],
    [proxy({ models: ["codey-extra-other/model"] })],
    [proxy({ models: ["__proto__"] })],
    [proxy({ models: ["with space"] })],
    [proxy({ endpoint: "http://external.example" })],
    [proxy({ endpoint: "https://user:password@example.com" })],
    [proxy({ endpoint: "https://example.com/?key=secret" })],
    [proxy({ endpoint: "not-a-url" })],
    [proxy({ key: "with\nnewline" })],
    [proxy({ key: "" })],
    [proxy({ id: "../escape" })],
    [proxy({ unexpected: true })],
    Array.from({ length: 33 }, (_, index) =>
      proxy({ id: `p${index}`, enabled: false }),
    ),
  ]
  for (const proxies of invalid) {
    write({ additionalCopilotProxies: proxies })
    expect(() => store().status()).toThrow()
  }
  write({
    additionalCopilotProxies: [
      proxy(),
      proxy({ id: "disabled", enabled: false }),
    ],
  })
  expect(store().status().additionalCopilotProxies.length).toBe(2)
  for (const endpoint of [
    "https://proxy.example/",
    "http://localhost:4155",
    "http://[::1]:4155",
  ]) {
    write({ additionalCopilotProxies: [proxy({ endpoint })] })
    expect(store().status().additionalCopilotProxies[0].endpoint).toBe(
      endpoint.replace(/\/$/u, ""),
    )
  }
})

test("save rejects unversioned input and cannot enable a standalone gateway accidentally", () => {
  expect(() => store().save({ additionalCopilotProxies: [] })).toThrow(
    "Invalid",
  )
  const disabled = createCodeySettings({ environment: {} })
  expect(() =>
    disabled.save({
      revision: disabled.status().revision,
      additionalCopilotProxies: [],
    }),
  ).toThrow("not enabled")
})

test("concurrent external edits are not overwritten while preparing a save", () => {
  write({ marker: "before" })
  const settings = createCodeySettings({
    environment: { CODEY_SETTINGS_FILE: file },
    secureDirectory: () => write({ marker: "external-change" }),
  })
  expect(() =>
    settings.save({
      revision: settings.status().revision,
      additionalCopilotProxies: [proxy()],
    }),
  ).toThrow("changed")
  expect(readDisk().marker).toBe("external-change")
  expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"])
})

test("in-flight inference keeps one routing snapshot while later requests hot-load edits", async () => {
  write({ additionalCopilotProxies: [proxy()] })
  const settings = store()
  await settings.withSnapshot(async () => {
    expect(settings.overlay({}).modelMappings?.["claude-opus-5.5"]).toBe(
      "codey-extra-extra/claude-opus-5.5",
    )
    write({ additionalCopilotProxies: [proxy({ id: "replacement" })] })
    await Promise.resolve()
    expect(settings.overlay({}).modelMappings?.["claude-opus-5.5"]).toBe(
      "codey-extra-extra/claude-opus-5.5",
    )
  })
  expect(settings.overlay({}).modelMappings?.["claude-opus-5.5"]).toBe(
    "codey-extra-replacement/claude-opus-5.5",
  )
})
