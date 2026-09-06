import type { CodeyClientScope } from "./codey-client-ticket"

import { verifyCodeyClientTicket } from "./codey-client-ticket"

const USAGE_PATHS = new Set([
  "/usage",
  "/token-usage",
  "/token-usage/daily",
  "/token-usage/events",
])
const HISTORY_DETAIL_PATTERN =
  /^\/session-history\/(active|archived)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export interface CodeyBrowserHandlerOptions {
  allowedOrigin: string
  fetchApp: (request: Request) => Promise<Response> | Response
  getHistoryApiKeys: () => Array<string>
  getUsageApiKeys: () => Array<string>
  nodeId: string
  now?: () => number
  signingKey: string
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary")
  const values = new Set(
    (current ? current.split(",") : [])
      .map((item) => item.trim())
      .filter(Boolean),
  )
  values.add(value)
  headers.set("vary", [...values].join(", "))
}

function applySecurityHeaders(headers: Headers): void {
  headers.set("cache-control", "no-store")
  headers.set("referrer-policy", "no-referrer")
  headers.set("x-content-type-options", "nosniff")
  headers.set("x-frame-options", "DENY")
}

function applyCorsHeaders(
  headers: Headers,
  origin: string,
  allowedOrigin: string,
): void {
  if (!origin || origin !== allowedOrigin) return
  headers.set("access-control-allow-origin", allowedOrigin)
  appendVary(headers, "Origin")
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  origin: string,
  allowedOrigin: string,
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  })
  applySecurityHeaders(headers)
  applyCorsHeaders(headers, origin, allowedOrigin)
  return new Response(JSON.stringify(body), { headers, status })
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? ""
  return authorization.startsWith("Bearer ") ?
      authorization.slice(7).trim()
    : ""
}

function requestScope(pathname: string): CodeyClientScope | null {
  if (USAGE_PATHS.has(pathname)) return "usage"
  if (
    pathname === "/session-history"
    || HISTORY_DETAIL_PATTERN.test(pathname)
  ) {
    return "history"
  }
  return null
}

function selectInternalApiKey(
  scope: CodeyClientScope,
  options: CodeyBrowserHandlerOptions,
): string {
  return (
    (scope === "history" ?
      options.getHistoryApiKeys()[0]
    : options.getUsageApiKeys()[0]) ?? ""
  )
}

export function createCodeyBrowserHandler(
  options: CodeyBrowserHandlerOptions,
): (request: Request) => Promise<Response> {
  const allowedOrigin = options.allowedOrigin.trim()
  const nodeId = options.nodeId.trim()
  const signingKey = options.signingKey.trim()

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const origin = (request.headers.get("origin") ?? "").trim()
    if (origin && origin !== allowedOrigin) {
      return jsonResponse(
        403,
        { error: "Origin is not allowed" },
        origin,
        allowedOrigin,
      )
    }

    if (request.method === "OPTIONS") {
      const headers = new Headers({
        "access-control-allow-headers": "authorization",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-max-age": "600",
      })
      applySecurityHeaders(headers)
      applyCorsHeaders(headers, origin, allowedOrigin)
      if (
        request.headers.get("access-control-request-private-network") === "true"
      ) {
        headers.set("access-control-allow-private-network", "true")
      }
      return new Response(null, { headers, status: 204 })
    }

    if (
      url.pathname === "/healthz"
      && ["GET", "HEAD"].includes(request.method)
    ) {
      return jsonResponse(
        200,
        {
          nodeId,
          ok: true,
          service: "copilot-api-codey-https",
        },
        origin,
        allowedOrigin,
      )
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonResponse(
        405,
        { error: "Method not allowed" },
        origin,
        allowedOrigin,
      )
    }

    const scope = requestScope(url.pathname)
    if (!scope) {
      return jsonResponse(404, { error: "Not found" }, origin, allowedOrigin)
    }
    try {
      verifyCodeyClientTicket({
        nodeId,
        now: options.now?.(),
        requiredScope: scope,
        signingKey,
        token: bearerToken(request),
      })
    } catch {
      return jsonResponse(
        401,
        { error: "Client ticket is invalid or expired" },
        origin,
        allowedOrigin,
      )
    }

    const headers = new Headers(request.headers)
    headers.delete("x-api-key")
    const internalApiKey = selectInternalApiKey(scope, options)
    if (internalApiKey) {
      headers.set("authorization", `Bearer ${internalApiKey}`)
    } else {
      headers.delete("authorization")
    }

    try {
      const appResponse = await options.fetchApp(
        new Request(request.url, {
          headers,
          method: request.method,
        }),
      )
      const responseHeaders = new Headers(appResponse.headers)
      applySecurityHeaders(responseHeaders)
      applyCorsHeaders(responseHeaders, origin, allowedOrigin)
      return new Response(appResponse.body, {
        headers: responseHeaders,
        status: appResponse.status,
        statusText: appResponse.statusText,
      })
    } catch (error) {
      console.error("Codey browser request failed", error)
      return jsonResponse(
        502,
        { error: "Node request failed" },
        origin,
        allowedOrigin,
      )
    }
  }
}
