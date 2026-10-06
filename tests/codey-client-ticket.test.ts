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
      aud: "linux-gpu",
      exp: issuedAt + 600,
      iat: issuedAt,
      scope: ["usage", "history"],
      sub: "operator@example.test",
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
        nodeId: "linux-gpu",
        now,
        requiredScope: "usage",
        signingKey,
        token: ticket(),
      }),
    ).toMatchObject({
      nodeId: "linux-gpu",
      principalId: "operator@example.test",
      scopes: ["history", "usage"],
    })
  })

  it("rejects a ticket for another node", () => {
    expect(() =>
      verifyCodeyClientTicket({
        nodeId: "node-east-2",
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
        nodeId: "linux-gpu",
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
        nodeId: "linux-gpu",
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
        nodeId: "linux-gpu",
        now,
        requiredScope: "usage",
        signingKey,
        token: `${ticket()}x`,
      }),
    ).toThrow()
  })
})
