import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { migrateCodeyManagedCodexModelFiles } from "~/lib/codey-model-migration"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []
const originalCodeyManaged = process.env.CODEY_MANAGED
const originalCodexHome = process.env.CODEX_HOME
const originalModelPolicyFile = process.env.CODEY_MODEL_POLICY_FILE

function evaluate(
  managed: boolean,
  modelMappings: Record<string, string> = {},
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
  resolved: config.resolveMappedModel("gpt-6-astra"),
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

test("Codey-managed gateways retain the retired Astra ID as a compatibility alias", () => {
  expect(evaluate(true)).toEqual({
    mappings: {
      "codex-auto-review": "codex/codex-auto-review",
      "gpt-reserve": "codex/gpt-reserve",
      "gpt-6-astra": "gpt-6.1-sol",
    },
    resolved: "gpt-6.1-sol",
  })
})

test("standalone gateways do not acquire Codey's compatibility policy", () => {
  expect(evaluate(false)).toEqual({
    mappings: {
      "codex-auto-review": "codex/codex-auto-review",
      "gpt-reserve": "codex/gpt-reserve",
    },
    resolved: "gpt-6-astra",
  })
})

test("an explicit owner mapping overrides Codey's built-in successor", () => {
  expect(evaluate(true, { "gpt-6-astra": "provider/private-astra" })).toEqual({
    mappings: {
      "codex-auto-review": "codex/codex-auto-review",
      "gpt-reserve": "codex/gpt-reserve",
      "gpt-6-astra": "provider/private-astra",
    },
    resolved: "provider/private-astra",
  })
})

test("managed startup migrates the active Codex files and preserves custom models", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codey-codex-home-"))
  tempDirs.push(directory)
  process.env.CODEY_MANAGED = "true"
  process.env.CODEX_HOME = directory
  const policyFile = path.join(directory, "codey-model-policy.json")
  process.env.CODEY_MODEL_POLICY_FILE = policyFile
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
  fs.writeFileSync(
    path.join(directory, "a100-models.json"),
    JSON.stringify({
      models: [{ slug: "gpt-6.1-sol", context_window: 922_000 }],
    }),
  )
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
        { slug: "gpt-6-astra", display_name: "Retired" },
        { slug: "owner/custom", display_name: "Owner custom model" },
      ],
    }),
  )

  expect(migrateCodeyManagedCodexModelFiles()).toBe("gpt-6.1-sol")

  const config = fs.readFileSync(path.join(directory, "config.toml"), "utf8")
  expect(config).toContain('model = "gpt-6.1-sol"')
  expect(config).toContain("model_context_window = 922000")
  expect(config).toContain("model_auto_compact_token_limit = 762000")
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
    "owner/custom",
  ])
  expect(catalog.models[0]?.context_window).toBe(922_000)
  expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
})

test("a future package can declare a new successor without changing migration code", () => {
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
  expect(
    fs.readFileSync(path.join(directory, "config.toml"), "utf8"),
  ).toContain('model = "gpt-7-future"')
  const futureCatalog = JSON.parse(
    fs.readFileSync(path.join(directory, "models.json"), "utf8"),
  ) as { models: Array<{ slug: string }> }
  expect(futureCatalog.models[0]?.slug).toBe("gpt-7-future")
})

function gpt62Fixture(selected: string, catalogUpdated = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codey-gpt62-"))
  tempDirs.push(directory)
  process.env.CODEY_MANAGED = "true"
  process.env.CODEX_HOME = directory
  const policyFile = path.join(directory, "codey-model-policy.json")
  process.env.CODEY_MODEL_POLICY_FILE = policyFile
  const policy = {
    schema: 1,
    activeModel: "gpt-6.2-sol",
    selectableModels: ["gpt-6.2-sol", "gpt-6.2-astra"],
    retiredModels: ["gpt-6.1-sol", "gpt-6-astra", "codex/gpt-6-astra"],
    replacements: {
      "gpt-6.1-sol": "gpt-6.2-sol",
      "gpt-6-astra": "gpt-6.2-astra",
      "codex/gpt-6-astra": "gpt-6.2-astra",
    },
    aliases: {},
    contextWindow: 872_000,
    autoCompactTokenLimit: 722_000,
    catalogFile: "a100-models.json",
  }
  const models = policy.selectableModels.map((slug) => ({
    slug,
    context_window: 872_000,
  }))
  const configFile = path.join(directory, "config.toml")
  const modelsFile = path.join(directory, "models.json")
  const before =
    `model = '${selected}' # selected\r\n`
    + "model_context_window = 922000\r\n"
    + "model_auto_compact_token_limit = 123456\r\n"
    + "model_reasoning_effort = 'high'\r\n"
    + `[model_providers.custom]\r\nmodel = '${selected}'\r\n`
  fs.writeFileSync(policyFile, JSON.stringify(policy))
  fs.writeFileSync(
    path.join(directory, policy.catalogFile),
    JSON.stringify({ models }),
  )
  fs.writeFileSync(configFile, before)
  fs.writeFileSync(
    modelsFile,
    JSON.stringify({
      marker: "keep",
      models: [
        ...(catalogUpdated ? models : (
          policy.retiredModels.map((slug) => ({ slug }))
        )),
        { slug: "owner/custom", label: "Keep" },
      ],
    }),
  )
  return { configFile, modelsFile, policyFile, policy, before }
}

for (const catalogUpdated of [false, true]) {
  test.each([
    ["gpt-6.1-sol", "gpt-6.2-sol"],
    ["gpt-6-astra", "gpt-6.2-astra"],
    ["codex/gpt-6-astra", "gpt-6.2-astra"],
  ])(
    `upgrades %s at startup (catalog already refreshed: ${catalogUpdated})`,
    (selected, target) => {
      const f = gpt62Fixture(selected, catalogUpdated)
      expect(migrateCodeyManagedCodexModelFiles()).toBe(target)
      const expected = f.before
        .replace(`model = '${selected}'`, `model = '${target}'`)
        .replace("922000", "872000")
      expect(fs.readFileSync(f.configFile, "utf8")).toBe(expected)
      expect(JSON.parse(fs.readFileSync(f.modelsFile, "utf8"))).toEqual({
        marker: "keep",
        models: [
          { slug: "gpt-6.2-sol", context_window: 872_000 },
          { slug: "gpt-6.2-astra", context_window: 872_000 },
          { slug: "owner/custom", label: "Keep" },
        ],
      })
      expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
      expect(fs.readFileSync(f.configFile, "utf8")).toBe(expected)
      expect(JSON.parse(fs.readFileSync(f.policyFile, "utf8"))).toMatchObject({
        aliases: {},
      })
    },
  )
}

test.each(["owner/custom", "gpt-6.2-sol", "gpt-6.2-astra"])(
  "startup leaves an explicit %s selection and settings unchanged",
  (selected) => {
    const f = gpt62Fixture(selected)
    const modelsBefore = fs.readFileSync(f.modelsFile, "utf8")
    expect(migrateCodeyManagedCodexModelFiles()).toBeNull()
    expect(fs.readFileSync(f.configFile, "utf8")).toBe(f.before)
    expect(fs.readFileSync(f.modelsFile, "utf8")).toBe(modelsBefore)
  },
)

test("startup migrates the old managed compaction limit but keeps a custom context limit", () => {
  const f = gpt62Fixture("gpt-6.1-sol", true)
  const before = f.before.replace("922000", "12345").replace("123456", "762000")
  fs.writeFileSync(f.configFile, before)
  expect(migrateCodeyManagedCodexModelFiles()).toBe("gpt-6.2-sol")
  expect(fs.readFileSync(f.configFile, "utf8")).toBe(
    before.replace("gpt-6.1-sol", "gpt-6.2-sol").replace("762000", "722000"),
  )
})

test.each([
  { replacements: null },
  { replacements: [] },
  { replacements: { "gpt-6-astra": "owner/custom" } },
])(
  "rejects an invalid replacement policy before changing files: %j",
  ({ replacements }) => {
    const f = gpt62Fixture("gpt-6-astra")
    fs.writeFileSync(
      f.policyFile,
      JSON.stringify({ ...f.policy, replacements }),
    )
    expect(() => migrateCodeyManagedCodexModelFiles()).toThrow(
      "Invalid Codey managed model policy",
    )
    expect(fs.readFileSync(f.configFile, "utf8")).toBe(f.before)
  },
)
