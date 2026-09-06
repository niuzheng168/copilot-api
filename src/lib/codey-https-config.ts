const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u

export interface CodeyHttpsConfig {
  allowedOrigin: string
  certPath: string
  host: string
  keyPath: string
  nodeId: string
  port: number
  signingKeyFile: string
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim() ?? ""
  if (!value) {
    throw new Error(`${name} is required when Codey HTTPS is enabled`)
  }
  return value
}

export function resolveCodeyHttpsConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CodeyHttpsConfig | null {
  const names = [
    "COPILOT_API_CODEY_HTTPS_PORT",
    "COPILOT_API_CODEY_TLS_CERT",
    "COPILOT_API_CODEY_TLS_KEY",
    "COPILOT_API_CODEY_NODE_ID",
    "COPILOT_API_CODEY_ALLOWED_ORIGIN",
    "COPILOT_API_CODEY_SIGNING_KEY_FILE",
  ]
  if (!names.some((name) => Boolean(environment[name]?.trim()))) {
    return null
  }

  const portValue = required(environment, "COPILOT_API_CODEY_HTTPS_PORT")
  const port = Number(portValue)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      "COPILOT_API_CODEY_HTTPS_PORT must be an integer between 1 and 65535",
    )
  }

  const nodeId = required(environment, "COPILOT_API_CODEY_NODE_ID")
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("COPILOT_API_CODEY_NODE_ID is invalid")
  }

  const allowedOrigin = required(
    environment,
    "COPILOT_API_CODEY_ALLOWED_ORIGIN",
  )
  let origin: URL
  try {
    origin = new URL(allowedOrigin)
  } catch {
    throw new Error("COPILOT_API_CODEY_ALLOWED_ORIGIN must be a valid URL")
  }
  if (
    origin.protocol !== "https:"
    || origin.origin !== allowedOrigin
    || origin.username
    || origin.password
  ) {
    throw new Error(
      "COPILOT_API_CODEY_ALLOWED_ORIGIN must be an HTTPS origin without a path",
    )
  }

  return {
    allowedOrigin,
    certPath: required(environment, "COPILOT_API_CODEY_TLS_CERT"),
    host:
      environment.COPILOT_API_CODEY_HTTPS_HOST?.trim()
      || environment.HOST?.trim()
      || "0.0.0.0",
    keyPath: required(environment, "COPILOT_API_CODEY_TLS_KEY"),
    nodeId,
    port,
    signingKeyFile: required(environment, "COPILOT_API_CODEY_SIGNING_KEY_FILE"),
  }
}
