import { describe, expect, it } from "bun:test"

import { resolveCodeyHttpsConfig } from "~/lib/codey-https-config"

const validEnvironment = {
  COPILOT_API_CODEY_ALLOWED_ORIGIN: "https://codey.example.test",
  COPILOT_API_CODEY_HTTPS_PORT: "8443",
  COPILOT_API_CODEY_NODE_ID: "zhn-a100",
  COPILOT_API_CODEY_SIGNING_KEY_FILE: "/config/signing.key",
  COPILOT_API_CODEY_TLS_CERT: "/config/tls.crt",
  COPILOT_API_CODEY_TLS_KEY: "/config/tls.key",
}

describe("resolveCodeyHttpsConfig", () => {
  it("returns null when Codey HTTPS is not configured", () => {
    expect(resolveCodeyHttpsConfig({})).toBeNull()
  })

  it("parses a complete configuration", () => {
    expect(resolveCodeyHttpsConfig(validEnvironment)).toEqual({
      allowedOrigin: "https://codey.example.test",
      certPath: "/config/tls.crt",
      host: "0.0.0.0",
      keyPath: "/config/tls.key",
      nodeId: "zhn-a100",
      port: 8443,
      signingKeyFile: "/config/signing.key",
    })
  })

  it("uses an explicit HTTPS host", () => {
    expect(
      resolveCodeyHttpsConfig({
        ...validEnvironment,
        COPILOT_API_CODEY_HTTPS_HOST: "10.0.0.7",
      })?.host,
    ).toBe("10.0.0.7")
  })

  it("rejects partial configuration", () => {
    expect(() =>
      resolveCodeyHttpsConfig({
        COPILOT_API_CODEY_HTTPS_PORT: "8443",
      }),
    ).toThrow()
  })

  it("rejects a non-origin CORS URL", () => {
    expect(() =>
      resolveCodeyHttpsConfig({
        ...validEnvironment,
        COPILOT_API_CODEY_ALLOWED_ORIGIN: "https://codey.example.test/path",
      }),
    ).toThrow()
  })
})
