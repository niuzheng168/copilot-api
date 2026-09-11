import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function configDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codey-defaults-"))
  tempDirs.push(directory)
  return directory
}

function evaluate(directory: string, managed: boolean, script: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd,
    env: {
      ...process.env,
      CODEY_MANAGED: String(managed),
      COPILOT_API_HOME: directory,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr))
  }
  return JSON.parse(decoder.decode(result.stdout).trim()) as {
    defaultValue: boolean
    effective: boolean
  }
}

const probe = `
const config = await import("./src/lib/config");
config.mergeConfigWithDefaults();
console.log(JSON.stringify({
  defaultValue: config.defaultConfig.useResponsesApiWebSocket,
  effective: config.isResponsesApiWebSocketEnabled(),
}));
`

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("Codey gateway defaults", () => {
  for (const managed of [true, false]) {
    test(`fresh config uses the matching default (Codey=${managed})`, () => {
      const directory = configDirectory()
      expect(evaluate(directory, managed, probe)).toEqual({
        defaultValue: !managed,
        effective: !managed,
      })
      const stored = JSON.parse(
        fs.readFileSync(path.join(directory, "config.json"), "utf8"),
      ) as { useResponsesApiWebSocket: boolean }
      expect(stored.useResponsesApiWebSocket).toBe(!managed)
    })

    test(`omitted setting falls back without persisting an override (Codey=${managed})`, () => {
      const directory = configDirectory()
      const file = path.join(directory, "config.json")
      const existing = {
        auth: {
          apiKeys: ["fixture-model-key"],
          adminApiKey: "fixture-admin-key",
          sessionHistoryApiKey: "fixture-history-key",
        },
        providers: {
          fixture: { enabled: false, baseUrl: "https://provider.example" },
        },
      }
      fs.writeFileSync(file, JSON.stringify(existing))
      expect(evaluate(directory, managed, probe)).toEqual({
        defaultValue: !managed,
        effective: !managed,
      })
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
        useResponsesApiWebSocket?: boolean
        auth: unknown
        providers: unknown
      }
      expect(stored.useResponsesApiWebSocket).toBeUndefined()
      expect(stored.auth).toEqual(existing.auth)
      expect(stored.providers).toEqual(existing.providers)
    })

    for (const enabled of [true, false]) {
      test(`explicit ${enabled} overrides the default (Codey=${managed})`, () => {
        const directory = configDirectory()
        const file = path.join(directory, "config.json")
        fs.writeFileSync(
          file,
          JSON.stringify({ useResponsesApiWebSocket: enabled }),
        )
        expect(evaluate(directory, managed, probe)).toEqual({
          defaultValue: !managed,
          effective: enabled,
        })
        const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
          useResponsesApiWebSocket: boolean
        }
        expect(stored.useResponsesApiWebSocket).toBe(enabled)
      })
    }
  }

  test("removing an explicit override and reloading restores the Codey default", () => {
    const directory = configDirectory()
    fs.writeFileSync(
      path.join(directory, "config.json"),
      '{"useResponsesApiWebSocket":true}',
    )
    const result = evaluate(
      directory,
      true,
      `
const config = await import("./src/lib/config");
if (!config.isResponsesApiWebSocketEnabled()) throw new Error("Override lost");
const editable = config.readEditableConfigFromDisk();
delete editable.useResponsesApiWebSocket;
config.writeConfigToDisk(editable);
config.reloadConfig();
console.log(JSON.stringify({
  defaultValue: config.defaultConfig.useResponsesApiWebSocket,
  effective: config.isResponsesApiWebSocketEnabled(),
}));
`,
    )
    expect(result).toEqual({ defaultValue: false, effective: false })
  })
})
