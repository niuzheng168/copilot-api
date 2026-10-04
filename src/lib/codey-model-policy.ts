import fs from "node:fs"
import path from "node:path"

export type CodeyManagedModelPolicy = {
  schema: 1
  activeModel: string
  aliases: Record<string, string>
  contextWindow: number
  autoCompactTokenLimit: number
  catalogFile: string
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

export function readCodeyManagedModelPolicy(): CodeyManagedModelPolicy | null {
  if (process.env.CODEY_MANAGED !== "true") return null
  const file = path.resolve(
    process.env.CODEY_MODEL_POLICY_FILE
      ?? path.join(
        process.cwd(),
        "onboarding/templates/codey-model-policy.json",
      ),
  )
  if (!fs.existsSync(file)) return null
  const policy = JSON.parse(
    fs.readFileSync(file, "utf8"),
  ) as Partial<CodeyManagedModelPolicy>
  if (
    policy.schema !== 1
    || typeof policy.activeModel !== "string"
    || !policy.activeModel
    || !policy.aliases
    || typeof policy.aliases !== "object"
    || Array.isArray(policy.aliases)
    || !positiveInteger(policy.contextWindow)
    || !positiveInteger(policy.autoCompactTokenLimit)
    || typeof policy.catalogFile !== "string"
    || !/^[a-zA-Z0-9._-]+\.json$/.test(policy.catalogFile)
    || Object.entries(policy.aliases).some(
      ([source, target]) =>
        !source || typeof target !== "string" || target !== policy.activeModel,
    )
  ) {
    throw new Error("Invalid Codey managed model policy")
  }
  return policy as CodeyManagedModelPolicy
}

export function codeyManagedModelPolicyDirectory(): string {
  return path.dirname(
    path.resolve(
      process.env.CODEY_MODEL_POLICY_FILE
        ?? path.join(
          process.cwd(),
          "onboarding/templates/codey-model-policy.json",
        ),
    ),
  )
}
