import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { migrateCodeyManagedCodexModelFiles } from "~/lib/codey-model-migration"
import { parseProviderModelAlias } from "~/lib/provider-model"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []
const originalCodeyManaged = process.env.CODEY_MANAGED
const originalCodexHome = process.env.CODEX_HOME
const originalModelPolicyFile = process.env.CODEY_MODEL_POLICY_FILE

function evaluate(
  managed: boolean,
  modelMappings: Record<string, string> = {},
  requestedModel = "gpt-6-astra",
): { mappings: Record<string, string>; resolved: string } {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codey-model-compatibility-"),
  )
  tempDirs.push(directory)
  fs.writeFileSync(
    path.join(directory, "config.json"),
    JSON.stringify({
      auth: { adminApiKey: "test-admin-key" },
      modelMappings,
    }),
  )
  const policyFile = path.join(directory, "codey-model-policy.json")
  fs.writeFileSync(
    policyFile,
    JSON.stringify({
      schema: 1,
      activeModel: "gpt-6.1-sol",
      aliases: { "gpt-6-astra": "gpt-6.1-sol" },
      contextWindow: 922_000,
      autoCompactTokenLimit: 762_000,
      catalogFile: "a100-models.json",
    }),
  )
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
const config = await import("./src/lib/config");
config.mergeConfigWithDefaults();
console.log(JSON.stringify({
  mappings: config.getModelMappings(),
  resolved: config.resolveMappedModel(${JSON.stringify(requestedModel)}),
}));
`,
    ],
    cwd,
    env: {
      ...process.env,
      CODEY_MANAGED: String(managed),
      CODEY_MODEL_POLICY_FILE: policyFile,
      COPILOT_API_HOME: directory,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr))
  }
  return JSON.parse(decoder.decode(result.stdout).trim()) as {
    mappings: Record<string, string>
    resolved: string
  }
}

afterEach(() => {
  if (originalCodeyManaged === undefined) {
    Reflect.deleteProperty(process.env, "CODEY_MANAGED")
  } else {
    process.env.CODEY_MANAGED = originalCodeyManaged
  }
  if (originalCodexHome === undefined) {
    Reflect.deleteProperty(process.env, "CODEX_HOME")
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  if (originalModelPolicyFile === undefined) {
    Reflect.deleteProperty(process.env, "CODEY_MODEL_POLICY_FILE")
  } else {
    process.env.CODEY_MODEL_POLICY_FILE = originalModelPolicyFile
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

test("Codey-managed gateways never apply the retired Astra-to-Sol mapping", () => {
  expect(evaluate(true)).toEqual({
    mappings: {},
    resolved: "gpt-6-astra",
  })
})

test("standalone gateways do not acquire Codey's compatibility policy", () => {
  expect(evaluate(false)).toEqual({
    mappings: {},
    resolved: "gpt-6-astra",
  })
})

test("managed model selections are honored even when an owner mapping is persisted", () => {
  expect(evaluate(true, { "gpt-6-astra": "provider/private-astra" })).toEqual({
    mappings: {},
    resolved: "gpt-6-astra",
  })
  expect(
    evaluate(true, { "gpt-6.1-sol": "gpt-6-astra" }, "gpt-6.1-sol"),
  ).toEqual({ mappings: {}, resolved: "gpt-6.1-sol" })
  expect(
    evaluate(true, { "owner/custom": "gpt-6.1-sol" }, "owner/custom"),
  ).toEqual({ mappings: {}, resolved: "owner/custom" })
})

test("standalone gateways retain explicitly configured model mappings", () => {
  expect(evaluate(false, { "gpt-6-astra": "provider/private-astra" })).toEqual({
    mappings: { "gpt-6-astra": "provider/private-astra" },
    resolved: "provider/private-astra",
  })
})

test("managed gateways normalize the retired Astra namespace without selecting another model", () => {
  const result = evaluate(true, {}, "codex/gpt-6-astra")
  expect(result).toEqual({
    mappings: {},
    resolved: "gpt-6-astra",
  })
  expect(parseProviderModelAlias(result.resolved)).toBeNull()
  expect(parseProviderModelAlias("codex/gpt-6-astra")).toEqual({
    provider: "codex",
    model: "gpt-6-astra",
  })
})

function prepareSelectableCatalog(model = "gpt-6.1-sol"): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codey-selectable-models-"),
  )
  tempDirs.push(directory)
  process.env.CODEY_MANAGED = "true"
  process.env.CODEX_HOME = directory
  process.env.CODEY_MODEL_POLICY_FILE = path.join(
    directory,
    "codey-model-policy.json",
  )
  fs.writeFileSync(
    process.env.CODEY_MODEL_POLICY_FILE,
    JSON.stringify({
      schema: 1,
      activeModel: "gpt-6.1-sol",
      selectableModels: ["gpt-6.1-sol", "gpt-6-astra"],
      retiredModels: ["codex/gpt-6-astra"],
      aliases: {},
      contextWindow: 922_000,
      autoCompactTokenLimit: 762_000,
      catalogFile: "a100-models.json",
    }),
  )
  fs.writeFileSync(
    path.join(directory, "a100-models.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-6.1-sol", context_window: 922_000 },
        { slug: "gpt-6-astra", context_window: 872_000 },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(directory, "config.toml"),
    `model = "${model}"\ncustom = "keep"\n`,
  )
  fs.writeFileSync(
    path.join(directory, "models.json"),
    JSON.stringify({
      marker: "keep",
      models: [
        { slug: "gpt-6.1-sol", context_window: 922_000 },
        { slug: "owner/custom", display_name: "Owner custom model" },
      ],
    }),
  )
  return directory
}

test("managed startup adds selectable metadata without changing the chosen model", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-astra", "owner/custom"]) {
    const directory = prepareSelectableCatalog(model)
    const configFile = path.join(directory, "config.toml")
    const before = fs.readFileSync(configFile, "utf8")

    expect(migrateCodeyManagedCodexModelFiles()).toBe("gpt-6.1-sol")
    expect(fs.readFileSync(configFile, "utf8")).toBe(before)
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, "models.json"), "utf8")),
    ).toEqual({
      marker: "keep",
      models: [
        { slug: "gpt-6.1-sol", context_window: 922_000 },
        { slug: "gpt-6-astra", context_window: 872_000 },
        { slug: "owner/custom", display_name: "Owner custom model" },
      ],
    })
    expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
  }
})

test("selectable catalog synchronization leaves standalone and custom-only configurations untouched", () => {
  const directory = prepareSelectableCatalog("owner/custom")
  const modelsFile = path.join(directory, "models.json")
  fs.writeFileSync(
    modelsFile,
    JSON.stringify({ models: [{ slug: "owner/custom" }] }),
  )
  const before = fs.readFileSync(modelsFile, "utf8")
  expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
  expect(fs.readFileSync(modelsFile, "utf8")).toBe(before)

  process.env.CODEY_MANAGED = "false"
  expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
})

test("selectable catalog synchronization skips missing policy or Codex files", () => {
  const directory = prepareSelectableCatalog()
  fs.unlinkSync(path.join(directory, "models.json"))
  expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
  fs.unlinkSync(process.env.CODEY_MODEL_POLICY_FILE!)
  expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
})

test("selectable model policy requires the default and rejects empty or retired model IDs", () => {
  for (const selectableModels of [
    "not-an-array",
    ["gpt-6.1-sol", "gpt-6.1-sol"],
    ["codex/gpt-6-astra"],
    ["gpt-6.1-sol", ""],
    ["gpt-6.1-sol", "codex/gpt-6-astra"],
    ["gpt-6.1-sol", 42],
  ]) {
    const directory = prepareSelectableCatalog()
    const policyFile = path.join(directory, "codey-model-policy.json")
    const policy = JSON.parse(fs.readFileSync(policyFile, "utf8")) as Record<
      string,
      unknown
    >
    fs.writeFileSync(
      policyFile,
      JSON.stringify({ ...policy, selectableModels }),
    )
    expect(() => migrateCodeyManagedCodexModelFiles()).toThrow(
      "Invalid Codey managed model policy",
    )
  }
})

test("retired catalog IDs must be unique and cannot retire a selectable or default model", () => {
  for (const retiredModels of [
    "not-an-array",
    ["codex/gpt-6-astra", "codex/gpt-6-astra"],
    ["gpt-6.1-sol"],
    ["gpt-6-astra"],
    [""],
    [42],
  ]) {
    const directory = prepareSelectableCatalog()
    const policyFile = path.join(directory, "codey-model-policy.json")
    const policy = JSON.parse(fs.readFileSync(policyFile, "utf8")) as Record<
      string,
      unknown
    >
    fs.writeFileSync(policyFile, JSON.stringify({ ...policy, retiredModels }))
    expect(() => migrateCodeyManagedCodexModelFiles()).toThrow(
      "Invalid Codey managed model policy",
    )
  }
})

test("managed startup rejects missing selectable metadata before writing Codex files", () => {
  const directory = prepareSelectableCatalog()
  const modelsFile = path.join(directory, "models.json")
  const before = fs.readFileSync(modelsFile, "utf8")
  fs.writeFileSync(
    path.join(directory, "a100-models.json"),
    JSON.stringify({
      models: [{ slug: "gpt-6.1-sol", context_window: 922_000 }],
    }),
  )

  expect(() => migrateCodeyManagedCodexModelFiles()).toThrow(
    "Codey package lacks model metadata for gpt-6-astra",
  )
  expect(fs.readFileSync(modelsFile, "utf8")).toBe(before)
})

test("managed startup rejects an unsupported local catalog shape", () => {
  const directory = prepareSelectableCatalog()
  fs.writeFileSync(
    path.join(directory, "models.json"),
    JSON.stringify({ models: {} }),
  )
  expect(() => migrateCodeyManagedCodexModelFiles()).toThrow(
    "Codey Codex model catalog has an unsupported shape",
  )
})

test("managed startup removes the obsolete catalog route without replacing the user's model", () => {
  const directory = prepareSelectableCatalog("gpt-6-astra")
  fs.writeFileSync(
    path.join(directory, "config.toml"),
    'model = "gpt-6-astra"\ncustom = "keep"\n'
      + '[model_providers.fixture]\nmodel = "gpt-6-astra"\n',
  )
  fs.writeFileSync(
    path.join(directory, "models.json"),
    JSON.stringify({
      marker: "keep",
      models: [
        { slug: "codex/gpt-6-astra", display_name: "Legacy qualified Astra" },
        { slug: "owner/custom", display_name: "Owner custom model" },
      ],
    }),
  )
  const configBefore = fs.readFileSync(
    path.join(directory, "config.toml"),
    "utf8",
  )

  expect(migrateCodeyManagedCodexModelFiles()).toBe("gpt-6.1-sol")

  const config = fs.readFileSync(path.join(directory, "config.toml"), "utf8")
  expect(config).toBe(configBefore)
  expect(config).toContain('model = "gpt-6-astra"')
  expect(config).toContain('[model_providers.fixture]\nmodel = "gpt-6-astra"')
  const catalog = JSON.parse(
    fs.readFileSync(path.join(directory, "models.json"), "utf8"),
  ) as {
    marker: string
    models: Array<{ slug: string; context_window?: number }>
  }
  expect(catalog.marker).toBe("keep")
  expect(catalog.models.map((model) => model.slug)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "owner/custom",
  ])
  expect(catalog.models[0]?.context_window).toBe(922_000)
  expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
})

test("a future package default never replaces an explicitly selected model", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codey-future-model-"),
  )
  tempDirs.push(directory)
  process.env.CODEY_MANAGED = "true"
  process.env.CODEX_HOME = directory
  process.env.CODEY_MODEL_POLICY_FILE = path.join(
    directory,
    "codey-model-policy.json",
  )
  fs.writeFileSync(
    process.env.CODEY_MODEL_POLICY_FILE,
    JSON.stringify({
      schema: 1,
      activeModel: "gpt-7-future",
      aliases: { "gpt-6.1-sol": "gpt-7-future" },
      contextWindow: 1_234_000,
      autoCompactTokenLimit: 1_100_000,
      catalogFile: "future-models.json",
    }),
  )
  fs.writeFileSync(
    path.join(directory, "future-models.json"),
    JSON.stringify({
      models: [{ slug: "gpt-7-future", context_window: 1_234_000 }],
    }),
  )
  fs.writeFileSync(
    path.join(directory, "config.toml"),
    'model = "gpt-6.1-sol"\n',
  )
  fs.writeFileSync(
    path.join(directory, "models.json"),
    JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }] }),
  )

  expect(migrateCodeyManagedCodexModelFiles()).toBe("gpt-7-future")
  expect(fs.readFileSync(path.join(directory, "config.toml"), "utf8")).toBe(
    'model = "gpt-6.1-sol"\n',
  )
  const futureCatalog = JSON.parse(
    fs.readFileSync(path.join(directory, "models.json"), "utf8"),
  ) as { models: Array<{ slug: string }> }
  expect(futureCatalog.models[0]?.slug).toBe("gpt-7-future")
})
