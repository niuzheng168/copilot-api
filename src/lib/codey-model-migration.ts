import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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

  const source = fs.readFileSync(configFile, "utf8")
  const table = source.search(/^\s*\[/m)
  const rootEnd = table < 0 ? source.length : table
  const root = source.slice(0, rootEnd)
  const selection = /^([ \t]*model[ \t]*=[ \t]*)(["'])([^"'\r\n]+)\2/m
  const selected = root.match(selection)?.[3]
  const replacements = policy.replacements ?? {}
  if (
    !selected
    || (!Object.hasOwn(replacements, selected)
      && !Object.hasOwn(policy.aliases, selected))
  ) {
    return null
  }
  const replacingSelection = Object.hasOwn(replacements, selected)
  const target =
    replacingSelection ? replacements[selected] : policy.aliases[selected]

  const replace = (text: string, name: string, value: string): string => {
    const pattern = new RegExp(`^(\\s*${name}\\s*=\\s*)[^\\r\\n#]+`, "m")
    return pattern.test(text) ?
        text.replace(pattern, `$1${value}`)
      : `${name} = ${value}\n${text}`
  }
  let migratedRoot = root.replace(
    selection,
    (_, prefix: string, quote: string) => `${prefix}${quote}${target}${quote}`,
  )
  if (replacingSelection) {
    // Older package updaters refresh the catalog but leave config.toml alone.
    // Complete that upgrade at startup, without creating runtime aliases or
    // overwriting owner-adjusted context limits, effort or provider tables.
    migratedRoot = migratedRoot
      .replace(
        /^([ \t]*model_context_window[ \t]*=[ \t]*)(922000|872000)(?=[ \t]*(?:#|\r?$))/m,
        (_, prefix: string) => `${prefix}${policy.contextWindow}`,
      )
      .replace(
        /^([ \t]*model_auto_compact_token_limit[ \t]*=[ \t]*)(762000|722000)(?=[ \t]*(?:#|\r?$))/m,
        (_, prefix: string) => `${prefix}${policy.autoCompactTokenLimit}`,
      )
  } else {
    migratedRoot = replace(
      migratedRoot,
      "model_context_window",
      String(policy.contextWindow),
    )
    migratedRoot = replace(
      migratedRoot,
      "model_auto_compact_token_limit",
      String(policy.autoCompactTokenLimit),
    )
  }

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
  const managedModels = managedSlugs.map((slug) => {
    const model = packagedCatalog.models?.find((entry) => entry.slug === slug)
    if (!model) throw new Error("Codey package lacks active model metadata")
    return structuredClone(model)
  })
  const isManaged = (slug: unknown): boolean =>
    typeof slug === "string"
    && (managedSlugs.includes(slug)
      || (policy.retiredModels ?? []).includes(slug)
      || Object.hasOwn(policy.aliases, slug))
  const managedIndex = catalog.models.findIndex((model) =>
    isManaged(model.slug),
  )
  const custom = catalog.models.filter((model) => !isManaged(model.slug))
  custom.splice(Math.max(0, managedIndex), 0, ...managedModels)

  // Publish metadata before selecting the replacement model.
  writeFileAtomically(
    modelsFile,
    `${JSON.stringify({ ...catalog, models: custom }, null, 2)}\n`,
  )
  writeFileAtomically(configFile, migratedRoot + source.slice(rootEnd))
  return target
}
