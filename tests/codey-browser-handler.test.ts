import { createHmac } from "node:crypto"
import { describe, expect, it } from "bun:test"

import { createCodeyBrowserHandler } from "~/lib/codey-browser-handler"

const allowedOrigin =
  "https://codey.ambitiouspond-a4ecfeb2.japaneast.azurecontainerapps.io"
const signingKey = "b".repeat(64)
const now = Date.UTC(2026, 8, 4, 13, 30, 0)

function ticket(scopes = ["usage", "history"]): string {
  const issuedAt = Math.floor(now / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      aud: "zhn-a100",
      exp: issuedAt + 600,
      iat: issuedAt,
      scope: scopes,
      sub: "zhn@microsoft.com",
      v: 1,
    }),
  ).toString("base64url")
  const signature = createHmac("sha256", signingKey)
    .update(payload)
    .digest("base64url")
  return `${payload}.${signature}`
}

function createHandler(
  fetchApp: (request: Request) => Promise<Response> | Response,
) {
  return createCodeyBrowserHandler({
    allowedOrigin,
    fetchApp,
    getHistoryApiKeys: () => ["history-secret"],
    getUsageApiKeys: () => ["usage-secret"],
    nodeId: "zhn-a100",
    now: () => now,
    signingKey,
  })
}

function request(path: string, tokenValue = ticket()): Request {
  return new Request(`https://zhn-a100.example.test${path}`, {
    headers: {
      authorization: `Bearer ${tokenValue}`,
      origin: allowedOrigin,
    },
  })
}

describe("createCodeyBrowserHandler", () => {
  it("serves an unauthenticated health response", async () => {
    const handler = createHandler(() => new Response("unused"))
    const response = await handler(
      new Request("https://zhn-a100.example.test/healthz", {
        headers: { origin: allowedOrigin },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      allowedOrigin,
    )
    expect(await response.json()).toMatchObject({
      nodeId: "zhn-a100",
      ok: true,
    })
  })

  it("proxies usage with the internal API key", async () => {
    let receivedAuthorization = ""
    const handler = createHandler((upstreamRequest) => {
      receivedAuthorization = upstreamRequest.headers.get("authorization") ?? ""
      return Response.json({ ok: true })
    })
    const response = await handler(request("/token-usage?period=day"))
    expect(response.status).toBe(200)
    expect(receivedAuthorization).toBe("Bearer usage-secret")
    expect(response.headers.get("access-control-allow-origin")).toBe(
      allowedOrigin,
    )
  })

  it("proxies history with the internal history key", async () => {
    let receivedAuthorization = ""
    const handler = createHandler((upstreamRequest) => {
      receivedAuthorization = upstreamRequest.headers.get("authorization") ?? ""
      return Response.json({ items: [] })
    })
    const response = await handler(request("/session-history?state=all"))
    expect(response.status).toBe(200)
    expect(receivedAuthorization).toBe("Bearer history-secret")
  })

  it("handles private-network CORS preflight", async () => {
    const handler = createHandler(() => new Response("unused"))
    const response = await handler(
      new Request("https://zhn-a100.example.test/usage", {
        headers: {
          "access-control-request-private-network": "true",
          origin: allowedOrigin,
        },
        method: "OPTIONS",
      }),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    )
  })

  it("rejects another origin", async () => {
    const handler = createHandler(() => Response.json({ ok: true }))
    const response = await handler(
      new Request("https://zhn-a100.example.test/usage", {
        headers: {
          authorization: `Bearer ${ticket()}`,
          origin: "https://example.com",
        },
      }),
    )
    expect(response.status).toBe(403)
  })

  it("rejects an invalid ticket", async () => {
    const handler = createHandler(() => Response.json({ ok: true }))
    expect((await handler(request("/usage", "invalid"))).status).toBe(401)
  })

  it("rejects non-read-only paths", async () => {
    const handler = createHandler(() => Response.json({ ok: true }))
    expect((await handler(request("/v1/models"))).status).toBe(404)
  })

  it("rejects write methods", async () => {
    const handler = createHandler(() => Response.json({ ok: true }))
    const original = request("/usage")
    const response = await handler(
      new Request(original, {
        method: "POST",
      }),
    )
    expect(response.status).toBe(405)
  })
})
