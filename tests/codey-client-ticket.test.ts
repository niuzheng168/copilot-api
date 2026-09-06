import { createHmac } from "node:crypto"
import { describe, expect, it } from "bun:test"

import { verifyCodeyClientTicket } from "~/lib/codey-client-ticket"

const signingKey = "a".repeat(64)
const now = Date.UTC(2026, 8, 4, 13, 30, 0)

function ticket(
  overrides: Partial<
    Record<"aud" | "exp" | "iat" | "scope" | "sub" | "v", unknown>
  > = {},
): string {
  const issuedAt = Math.floor(now / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      aud: "zhn-a100",
      exp: issuedAt + 600,
      iat: issuedAt,
      scope: ["usage", "history"],
      sub: "zhn@microsoft.com",
      v: 1,
      ...overrides,
    }),
  ).toString("base64url")
  const signature = createHmac("sha256", signingKey)
    .update(payload)
    .digest("base64url")
  return `${payload}.${signature}`
}

describe("verifyCodeyClientTicket", () => {
  it("accepts a valid scoped ticket", () => {
    expect(
      verifyCodeyClientTicket({
        nodeId: "zhn-a100",
        now,
        requiredScope: "usage",
        signingKey,
        token: ticket(),
      }),
    ).toMatchObject({
      nodeId: "zhn-a100",
      principalId: "zhn@microsoft.com",
      scopes: ["history", "usage"],
    })
  })

  it("rejects a ticket for another node", () => {
    expect(() =>
      verifyCodeyClientTicket({
        nodeId: "jpe3",
        now,
        requiredScope: "usage",
        signingKey,
        token: ticket(),
      }),
    ).toThrow()
  })

  it("rejects an expired ticket", () => {
    const issuedAt = Math.floor(now / 1000)
    expect(() =>
      verifyCodeyClientTicket({
        nodeId: "zhn-a100",
        now,
        requiredScope: "usage",
        signingKey,
        token: ticket({ exp: issuedAt - 1 }),
      }),
    ).toThrow()
  })

  it("rejects a missing scope", () => {
    expect(() =>
      verifyCodeyClientTicket({
        nodeId: "zhn-a100",
        now,
        requiredScope: "history",
        signingKey,
        token: ticket({ scope: ["usage"] }),
      }),
    ).toThrow()
  })

  it("rejects a modified signature", () => {
    expect(() =>
      verifyCodeyClientTicket({
        nodeId: "zhn-a100",
        now,
        requiredScope: "usage",
        signingKey,
        token: `${ticket()}x`,
      }),
    ).toThrow()
  })
})
