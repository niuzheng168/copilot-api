import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import { writeFileAtomically } from "./atomic-file"
import {
  codeyManagedModelPolicyDirectory,
  readCodeyManagedModelPolicy,
} from "./codey-model-policy"

export function migrateCodeyManagedCodexModelFiles(): string | null {
  if (process.env.CODEY_MANAGED !== "true") return null
  const policy = readCodeyManagedModelPolicy()
  if (!policy) return null
  const home = path.resolve(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  )
  const configFile = path.join(home, "config.toml")
  const modelsFile = path.join(home, "models.json")
  if (!fs.existsSync(configFile) || !fs.existsSync(modelsFile)) return null

  const catalog = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as {
    models?: Array<Record<string, unknown>>
    [key: string]: unknown
  }
  if (!Array.isArray(catalog.models)) {
    throw new Error("Codey Codex model catalog has an unsupported shape")
  }
  const packagedCatalog = JSON.parse(
    fs.readFileSync(
      path.join(codeyManagedModelPolicyDirectory(), policy.catalogFile),
      "utf8",
    ),
  ) as { models?: Array<Record<string, unknown>> }
  const managedSlugs = policy.selectableModels ?? [policy.activeModel]
  const retiredSlugs = policy.retiredModels ?? []
  const managedModels = managedSlugs.map((slug) => {
    const model = packagedCatalog.models?.find((entry) => entry.slug === slug)
    if (!model)
      throw new Error(`Codey package lacks model metadata for ${slug}`)
    return structuredClone(model)
  })
  const managedIndex = catalog.models.findIndex(
    (model) =>
      typeof model.slug === "string"
      && (managedSlugs.includes(model.slug)
        || retiredSlugs.includes(model.slug)
        || Object.hasOwn(policy.aliases, model.slug)),
  )
  if (managedIndex < 0) return null
  const custom = catalog.models.filter(
    (model) =>
      typeof model.slug !== "string"
      || (!managedSlugs.includes(model.slug)
        && !retiredSlugs.includes(model.slug)
        && !Object.hasOwn(policy.aliases, model.slug)),
  )
  custom.splice(Math.max(0, managedIndex), 0, ...managedModels)
  const catalogChanged = !isDeepStrictEqual(catalog.models, custom)
  if (!catalogChanged) return null

  writeFileAtomically(
    modelsFile,
    `${JSON.stringify({ ...catalog, models: custom }, null, 2)}\n`,
  )
  return policy.activeModel
}
