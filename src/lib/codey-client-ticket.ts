import { createHmac, timingSafeEqual } from "node:crypto"

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u
const PRINCIPAL_PATTERN = /^[A-Za-z0-9._:@-]{1,256}$/u
const ALLOWED_SCOPES = new Set(["usage", "history"])

export type CodeyClientScope = "history" | "usage"

export interface VerifyCodeyClientTicketOptions {
  nodeId: string
  requiredScope: CodeyClientScope
  signingKey: string
  token: string
  now?: number
}

export interface VerifiedCodeyClientTicket {
  expiresAt: number
  issuedAt: number
  nodeId: string
  principalId: string
  scopes: Array<CodeyClientScope>
}

function signature(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url")
}

function safeEqual(left: string, right: string): boolean {
  const leftValue = Buffer.from(left)
  const rightValue = Buffer.from(right)
  return (
    leftValue.length === rightValue.length
    && timingSafeEqual(leftValue, rightValue)
  )
}

function normalizeScopes(value: unknown): Array<CodeyClientScope> {
  if (!Array.isArray(value)) {
    throw new Error("Codey client ticket scopes are invalid")
  }
  const scopes = [
    ...new Set(
      value.filter(
        (scope): scope is CodeyClientScope =>
          typeof scope === "string" && ALLOWED_SCOPES.has(scope),
      ),
    ),
  ].sort()
  if (scopes.length === 0 || scopes.length !== value.length) {
    throw new Error("Codey client ticket scopes are invalid")
  }
  return scopes
}

export function verifyCodeyClientTicket(
  options: VerifyCodeyClientTicketOptions,
): VerifiedCodeyClientTicket {
  const signingKey = options.signingKey.trim()
  const token = options.token.trim()
  const nodeId = options.nodeId.trim()
  if (signingKey.length < 32 || !NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("Codey client ticket authentication is not configured")
  }
  if (token.length === 0 || token.length > 4096) {
    throw new Error("Codey client ticket is malformed")
  }

  const separator = token.indexOf(".")
  if (separator <= 0 || separator !== token.lastIndexOf(".")) {
    throw new Error("Codey client ticket is malformed")
  }
  const encodedPayload = token.slice(0, separator)
  const providedSignature = token.slice(separator + 1)
  if (!safeEqual(providedSignature, signature(signingKey, encodedPayload))) {
    throw new Error("Codey client ticket signature is invalid")
  }

  let payload: Record<string, unknown>
  try {
    const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8")
    const parsed: unknown = JSON.parse(decoded)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid payload")
    }
    payload = parsed as Record<string, unknown>
  } catch {
    throw new Error("Codey client ticket payload is invalid")
  }

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000)
  const principalId = typeof payload.sub === "string" ? payload.sub : ""
  if (
    payload.v !== 1
    || payload.aud !== nodeId
    || !PRINCIPAL_PATTERN.test(principalId)
    || !Number.isInteger(payload.iat)
    || !Number.isInteger(payload.exp)
  ) {
    throw new Error("Codey client ticket is expired or invalid")
  }
  const issuedAt = payload.iat as number
  const expiresAt = payload.exp as number
  if (
    issuedAt > nowSeconds + 30
    || expiresAt <= nowSeconds
    || expiresAt - issuedAt > 3600
  ) {
    throw new Error("Codey client ticket is expired or invalid")
  }

  const scopes = normalizeScopes(payload.scope)
  if (!scopes.includes(options.requiredScope)) {
    throw new Error("Codey client ticket scope is insufficient")
  }
  return {
    expiresAt: expiresAt * 1000,
    issuedAt: issuedAt * 1000,
    nodeId,
    principalId,
    scopes,
  }
}
