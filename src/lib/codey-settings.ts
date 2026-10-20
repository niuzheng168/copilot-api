import { createHash, randomBytes } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import type { AppConfig, ModelConfig } from "./config-store"

const PREFIX = "codey-extra-"
const MAX_BYTES = 1024 * 1024

/** Internal aliases belong to the node settings file, never editable gateway mappings. */
export function isCodeyProxyModelAlias(model: string): boolean {
  return model.startsWith(PREFIX)
}
const modelId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\\\p{Cc}]+$/u)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value))
const proxySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u),
    enabled: z.boolean().default(true),
    endpoint: z
      .string()
      .trim()
      .max(2048)
      .transform((value) => value.replace(/\/+$/u, ""))
      .refine((value) => {
        try {
          const url = new URL(value)
          return (
            !url.username
            && !url.password
            && !url.search
            && !url.hash
            && (url.protocol === "https:"
              || (url.protocol === "http:"
                && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
          )
        } catch {
          return false
        }
      }),
    key: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .regex(/^[^\r\n]+$/u),
    models: z.array(modelId).min(1).max(200),
  })
  .strict()
const documentSchema = z
  .object({
    additionalCopilotProxies: z.array(proxySchema).max(32).default([]),
  })
  .passthrough()

type Document = z.infer<typeof documentSchema>

export class CodeySettingsError extends Error {
  readonly status: 400 | 409 | 503

  constructor(message: string, status: 400 | 409 | 503 = 400) {
    super(message)
    this.status = status
  }
}

function validate(input: unknown): Document {
  const parsed = documentSchema.safeParse(input)
  // Never include parser input or issue values: either may contain a key.
  if (!parsed.success)
    throw new CodeySettingsError("Invalid Codey proxy settings.")
  const ids = new Set<string>()
  const models = new Set<string>()
  for (const proxy of parsed.data.additionalCopilotProxies) {
    if (ids.has(proxy.id))
      throw new CodeySettingsError("Proxy IDs must be unique.")
    ids.add(proxy.id)
    if (new Set(proxy.models).size !== proxy.models.length) {
      throw new CodeySettingsError("A proxy cannot list the same model twice.")
    }
    if (!proxy.enabled) continue
    for (const model of proxy.models) {
      if (models.has(model))
        throw new CodeySettingsError(
          "Each model may use only one enabled proxy.",
        )
      if (isCodeyProxyModelAlias(model))
        throw new CodeySettingsError(
          "Internal proxy routes cannot be configured as model IDs.",
        )
      models.add(model)
    }
  }
  return parsed.data
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  // Do not rewrite permissions on an arbitrary existing parent selected via
  // CODEY_SETTINGS_FILE. The secret-bearing file itself receives a private ACL.
  if (
    process.platform !== "win32"
    && (fs.statSync(directory).mode & 0o022) !== 0
  ) {
    throw new CodeySettingsError(
      "The Codey settings directory must not be writable by other users.",
      503,
    )
  }
}

function privateFile(file: string): void {
  if (process.platform !== "win32") return
  // The fixed script accepts a literal path on stdin, never a key or shell code.
  // Apply an owner/SYSTEM ACL before writing any key bytes into the empty file.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$target = [Console]::In.ReadToEnd()
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($owner, (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.File]::SetAccessControl($target, $acl)
`
  execFileSync(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: file,
      windowsHide: true,
      timeout: 10_000,
      stdio: ["pipe", "ignore", "ignore"],
    },
  )
}

const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex")

/** Node-local settings owner. The gateway consumes this file directly, not SQLite. */
export function createCodeySettings(
  dependencies: {
    environment?: NodeJS.ProcessEnv
    home?: () => string
    secureDirectory?: (directory: string) => void
  } = {},
) {
  const environment = dependencies.environment ?? process.env
  const home = dependencies.home ?? os.homedir
  const secureDirectory = dependencies.secureDirectory ?? privateDirectory
  let cached:
    | { signature: string; document: Document; revision: string }
    | undefined
  const requestSnapshot = new AsyncLocalStorage<
    ReturnType<typeof readFromDisk>
  >()

  function enabled() {
    return (
      environment.CODEY_MANAGED === "true"
      || Boolean(environment.CODEY_SETTINGS_FILE)
    )
  }

  function filename() {
    const file =
      environment.CODEY_SETTINGS_FILE
      || path.join(home(), ".config/codey/settings.json")
    if (!path.isAbsolute(file))
      throw new CodeySettingsError("CODEY_SETTINGS_FILE must be absolute.", 503)
    return file
  }

  function readFromDisk() {
    if (!enabled())
      return { document: validate({}), revision: digest("disabled") }
    const file = filename()
    try {
      const stat = fs.lstatSync(file, { bigint: true })
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.size > BigInt(MAX_BYTES)
      ) {
        throw new CodeySettingsError(
          "Codey settings must be a regular file no larger than 1 MiB.",
          503,
        )
      }
      if (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) {
        throw new CodeySettingsError(
          "Codey settings contains keys; restrict its permissions to 0600.",
          503,
        )
      }
      const signature = `${file}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`
      if (cached?.signature === signature) return cached
      const bytes = fs.readFileSync(file)
      if (bytes.length > MAX_BYTES)
        throw new CodeySettingsError("Codey settings file is too large.", 503)
      let input: unknown
      try {
        input = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""))
      } catch {
        throw new CodeySettingsError(
          "Codey settings contains invalid JSON; repair the file before sending model requests.",
          503,
        )
      }
      const document = validate(input)
      cached = { signature, document, revision: digest(bytes) }
      return cached
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cached = undefined
        return { document: validate({}), revision: digest("missing") }
      }
      if (error instanceof CodeySettingsError) throw error
      throw new CodeySettingsError(
        "Cannot read the node's Codey settings file.",
        503,
      )
    }
  }

  function read() {
    return requestSnapshot.getStore() ?? readFromDisk()
  }

  function status() {
    const state = read()
    return {
      enabled: enabled(),
      settingsFile: filename(),
      revision: state.revision,
      additionalCopilotProxies: state.document.additionalCopilotProxies.map(
        ({ key, ...proxy }) => ({
          ...proxy,
          models: [...proxy.models],
          keyConfigured: Boolean(key),
        }),
      ),
    }
  }

  function save(input: unknown) {
    if (!enabled())
      throw new CodeySettingsError(
        "Codey settings are not enabled on this node.",
        503,
      )
    const request = z
      .object({
        revision: z.string().length(64),
        additionalCopilotProxies: z
          .array(z.record(z.string(), z.unknown()))
          .max(32),
      })
      .strict()
      .safeParse(input)
    if (!request.success)
      throw new CodeySettingsError("Invalid settings update.")
    const before = readFromDisk()
    if (request.data.revision !== before.revision) {
      throw new CodeySettingsError(
        "The settings file changed; reload it before saving.",
        409,
      )
    }
    const previous = new Map(
      before.document.additionalCopilotProxies.map((proxy) => [
        proxy.id,
        proxy,
      ]),
    )
    const proxies = request.data.additionalCopilotProxies.map((proxy) => ({
      ...proxy,
      key:
        proxy.key === undefined || proxy.key === "" ?
          previous.get(String(proxy.id))?.key
        : proxy.key,
    }))
    const next = validate({
      ...before.document,
      additionalCopilotProxies: proxies,
    })
    const serialized = `${JSON.stringify(next, null, 2)}\n`
    if (Buffer.byteLength(serialized) > MAX_BYTES)
      throw new CodeySettingsError("Codey settings file would exceed 1 MiB.")
    const file = filename()
    const directory = path.dirname(file)
    secureDirectory(directory)
    const temporary = path.join(
      directory,
      `.settings-${randomBytes(12).toString("hex")}.tmp`,
    )
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600)
      privateFile(temporary)
      fs.writeFileSync(descriptor, serialized)
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      if (readFromDisk().revision !== before.revision)
        throw new CodeySettingsError(
          "The settings file changed; reload it before saving.",
          409,
        )
      fs.renameSync(temporary, file)
      cached = undefined
      return status()
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }

  function proxies() {
    return read().document.additionalCopilotProxies.filter(
      (proxy) => proxy.enabled,
    )
  }

  function overlay(base: AppConfig): AppConfig {
    const active = proxies()
    if (!active.length) return base
    const providers = { ...base.providers }
    const modelMappings = { ...base.modelMappings }
    for (const proxy of active) {
      const provider = `${PREFIX}${proxy.id}`
      if (Object.hasOwn(providers, provider)) {
        throw new CodeySettingsError(
          "An additional proxy ID conflicts with an existing gateway provider.",
          503,
        )
      }
      const models: Record<string, ModelConfig> = {}
      for (const model of proxy.models) {
        models[model] = {
          type:
            /(^|\/)claude[-/]/iu.test(model) ? "anthropic" : "openai-responses",
        }
        modelMappings[model] = `${provider}/${model}`
      }
      providers[provider] = {
        enabled: true,
        type: "openai-responses",
        baseUrl: proxy.endpoint,
        authType: "authorization",
        apiKey: proxy.key,
        models,
        agentsModels: [...proxy.models],
      }
    }
    // Derived routes never go back into either settings.json or gateway config.json.
    return { ...base, providers, modelMappings }
  }

  return {
    isEnabled: enabled,
    status,
    save,
    overlay,
    withSnapshot<T>(operation: () => T): T {
      return requestSnapshot.run(readFromDisk(), operation)
    },
    selectedModels(provider: string): Array<string> | undefined {
      const models = proxies().find(
        (proxy) => provider === `${PREFIX}${proxy.id}`,
      )?.models
      return models ? [...models] : undefined
    },
  }
}

export const codeySettings = createCodeySettings()
