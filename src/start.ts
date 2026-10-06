#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import { readFileSync } from "node:fs"
import { serve, type ServerHandler } from "srvx"

import { runProviderSetup } from "./auth"
import { createCodeyBrowserHandler } from "./lib/codey-browser-handler"
import { resolveCodeyHttpsConfig } from "./lib/codey-https-config"
import { migrateCodeyManagedCodexModelFiles } from "./lib/codey-model-migration"
import { isGitHubCopilotEnabled } from "./lib/github-copilot-provider"
import { listEnabledProviders, mergeConfigWithDefaults } from "./lib/config"
import { setupCopilotRuntime } from "~/lib/copilot-runtime"
import {
  GITHUB_TOKEN_ENV,
  readGitHubToken,
  readGitHubTokenFromEnv,
} from "./lib/credential-store"
import { startModelsDevCache } from "./lib/models-dev-cache"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import {
  getConfiguredApiKeys,
  getConfiguredSessionHistoryApiKeys,
  getMissingApiKeysMessage,
} from "./lib/request-auth"
import {
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  resolveServerBinding,
} from "./lib/server-host"
import { state } from "./lib/state"

interface RunServerOptions {
  host: string
  port: number
  verbose: boolean
  githubToken?: string
  showToken: boolean
  proxyEnv: boolean
  headless?: boolean
}

type GitHubTokenSource = "cli" | "env" | "file"

// The environment is preferred over the token file so the token never has to
// travel through the process list; --github-token stays first for callers that
// opt in explicitly.
async function resolveGitHubToken(
  cliToken: string | undefined,
): Promise<{ token: string; source: GitHubTokenSource } | null> {
  if (cliToken) return { token: cliToken, source: "cli" }

  const envToken = readGitHubTokenFromEnv()
  if (envToken) return { token: envToken, source: "env" }

  const fileToken = await readGitHubToken()
  if (fileToken) return { token: fileToken, source: "file" }

  return null
}

async function setupCopilotMode(
  githubToken: string,
  source: GitHubTokenSource,
): Promise<void> {
  state.githubTokenSource = source
  consola.info(
    source === "cli" ? "Using provided GitHub token"
    : source === "env" ?
      `Using GitHub token from the ${GITHUB_TOKEN_ENV} environment variable`
    : "Using GitHub token from local file",
  )

  await setupCopilotRuntime(githubToken)
}

async function setupProviderMode(): Promise<void> {
  const enabledProviders = listEnabledProviders()

  if (enabledProviders.length > 0) {
    consola.info(`Using enabled providers: ${enabledProviders.join(", ")}`)
    return
  }

  if (!isGitHubCopilotEnabled()) {
    throw new Error(
      "No enabled providers found. Enable GitHub Copilot with `copilot-api provider enable github-copilot`, or enable another configured provider.",
    )
  }

  consola.info("No enabled providers found. Setting one up...")
  await runProviderSetup()

  if (state.githubToken && isGitHubCopilotEnabled()) {
    // The setup flow persisted the token with the credential store.
    await setupCopilotMode(state.githubToken, "file")
    return
  }

  const providersAfterSetup = listEnabledProviders()
  if (providersAfterSetup.length === 0) {
    throw new Error(
      "Failed to configure any provider. Run `copilot-api auth login` to set one up.",
    )
  }
  consola.info(`Configured providers: ${providersAfterSetup.join(", ")}`)
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  consola.options.throttle = 0

  mergeConfigWithDefaults()
  const migratedModel = migrateCodeyManagedCodexModelFiles()
  if (migratedModel) {
    consola.info(`Migrated Codey Codex model configuration to ${migratedModel}`)
  }

  const configuredApiKeys = getConfiguredApiKeys()
  const binding = resolveServerBinding(
    options.host,
    configuredApiKeys.length > 0,
  )

  const missingApiKeysMessage = getMissingApiKeysMessage()
  if (missingApiKeysMessage) {
    consola.info(missingApiKeysMessage)
  }

  await initOpencodeVersion()

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  state.verbose = options.verbose
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()
  if (process.env.CODEY_MANAGED !== "true") {
    await startModelsDevCache()
  }

  const serverUrl = formatServerUrl(binding.clientHostname, options.port)

  const resolvedGitHubToken =
    isGitHubCopilotEnabled() ?
      await resolveGitHubToken(options.githubToken)
    : null
  if (resolvedGitHubToken && isGitHubCopilotEnabled()) {
    await setupCopilotMode(
      resolvedGitHubToken.token,
      resolvedGitHubToken.source,
    )
  } else if (options.headless && listEnabledProviders().length === 0) {
    // A fresh Codey machine must expose authenticated Usage/History before its
    // owner completes provider login. Never prompt inside a systemd service,
    // invent credentials, or change the normal interactive startup behavior.
    consola.warn(
      "No provider is configured. Codey services are available; model requests require `copilot-api auth login`.",
    )
  } else {
    await setupProviderMode()
  }

  consola.box(
    `🌐 Dashboard Viewer: ${serverUrl}/usage-viewer?endpoint=${serverUrl}/usage`,
  )

  const { createServer } = await import("./server")
  const server = createServer({ networkExposed: binding.networkExposed })

  serve({
    fetch: server.fetch as ServerHandler,
    hostname: binding.hostname,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })

  const codeyHttps = resolveCodeyHttpsConfig()
  if (codeyHttps) {
    const signingKey = readFileSync(codeyHttps.signingKeyFile, "utf8").trim()
    if (signingKey.length < 32) {
      throw new Error(
        "COPILOT_API_CODEY_SIGNING_KEY_FILE must contain at least 32 characters",
      )
    }
    const codeyHandler = createCodeyBrowserHandler({
      allowedOrigin: codeyHttps.allowedOrigin,
      fetchApp: (request) => server.fetch(request),
      getHistoryApiKeys: getConfiguredSessionHistoryApiKeys,
      getUsageApiKeys: getConfiguredApiKeys,
      nodeId: codeyHttps.nodeId,
      signingKey,
    })
    serve({
      fetch: codeyHandler as ServerHandler,
      hostname: codeyHttps.host,
      port: codeyHttps.port,
      tls: {
        cert: codeyHttps.certPath,
        key: codeyHttps.keyPath,
      },
      bun: {
        idleTimeout: 0,
      },
    })
    consola.box(
      `🔒 Codey HTTPS: https://${codeyHttps.nodeId}:${codeyHttps.port}`,
    )
  }
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    host: {
      type: "string",
      default: process.env.HOST?.trim() || DEFAULT_SERVER_HOST,
      description: "Host to listen on",
    },
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    headless: {
      type: "boolean",
      default: false,
      description:
        "Start without an interactive provider setup; model requests still require provider authentication",
    },
  },
  run({ args }) {
    return runServer({
      host: args.host,
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      githubToken: args["github-token"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      headless: args.headless,
    })
  },
})
