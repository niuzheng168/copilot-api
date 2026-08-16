import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeConfigToDisk } from "~/lib/config-store"
import { PATHS } from "~/lib/paths"

const originalAppDir = PATHS.APP_DIR
const originalConfigPath = PATHS.CONFIG_PATH
const tempDirs: Array<string> = []

function useTempConfigPath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-io-"))
  tempDirs.push(tempDir)
  PATHS.APP_DIR = tempDir
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  return PATHS.CONFIG_PATH
}

afterEach(() => {
  PATHS.APP_DIR = originalAppDir
  PATHS.CONFIG_PATH = originalConfigPath
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

test("writeConfigToDisk atomically replaces the editable config", () => {
  const configPath = useTempConfigPath()
  fs.writeFileSync(configPath, '{"auth":{"apiKeys":["old"]}}\n', "utf8")

  writeConfigToDisk({
    auth: {
      apiKeys: ["new"],
    },
    providers: {
      example: {
        apiKey: "provider-key",
        baseUrl: "https://provider.example",
      },
    },
  })

  expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
    auth: {
      apiKeys: ["new"],
    },
    providers: {
      example: {
        apiKey: "provider-key",
        baseUrl: "https://provider.example",
      },
    },
  })
  expect(fs.readdirSync(path.dirname(configPath))).toEqual(["config.json"])
})
