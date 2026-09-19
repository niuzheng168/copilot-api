import { afterEach, expect, mock, test } from "bun:test"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotModelsHeaders,
  copilotWebSocketHeaders,
  getOauthAppConfig,
  GITHUB_CLIENT_ID,
  githubHeaders,
  githubUserHeaders,
  isDirectGitHubAuth,
  isOpencodeOauthApp,
  prepareForCompact,
  prepareInteractionHeaders,
  prepareMessageProxyHeaders,
} from "~/lib/api-config"
import { COMPACT_REQUEST } from "~/lib/compact"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import { setupCopilotToken, stopCopilotRefreshLoop } from "~/lib/token"

const savedMode = process.env.COPILOT_API_AUTH_MODE
const savedApp = process.env.COPILOT_API_OAUTH_APP
const savedEnterprise = process.env.COPILOT_API_ENTERPRISE_URL
const savedState = { ...state }

afterEach(() => {
  stopCopilotRefreshLoop()
  for (const [name, value] of [
    ["COPILOT_API_AUTH_MODE", savedMode],
    ["COPILOT_API_OAUTH_APP", savedApp],
    ["COPILOT_API_ENTERPRISE_URL", savedEnterprise],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  Object.assign(state, savedState)
})

function directMode(): void {
  process.env.COPILOT_API_AUTH_MODE = "direct"
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL
  state.githubToken = "fixture-gh-oauth"
  state.copilotToken = "fixture-gh-oauth"
  state.accountType = "enterprise"
  state.copilotApiUrl = "https://api.enterprise.githubcopilot.com"
}

test("direct OAuth is separate from the device-login OAuth app selection", () => {
  directMode()
  expect(isDirectGitHubAuth()).toBe(true)
  expect(isOpencodeOauthApp()).toBe(false)
  expect(getOauthAppConfig().clientId).toBe(GITHUB_CLIENT_ID)
  expect(copilotBaseUrl(state)).toBe("https://api.githubcopilot.com")
  process.env.COPILOT_API_ENTERPRISE_URL = "enterprise.invalid"
  expect(copilotBaseUrl(state)).toBe("https://copilot-api.enterprise.invalid")
  delete process.env.COPILOT_API_AUTH_MODE
  expect(isDirectGitHubAuth()).toBe(false)
  process.env.COPILOT_API_OAUTH_APP = "opencode"
  expect(isDirectGitHubAuth()).toBe(true)
})

test("a gh token is used directly without the VS Code token-exchange or refresh loop", async () => {
  directMode()
  state.copilotToken = undefined
  const exchange = mock(() => {
    throw new Error("Must not exchange a gh token")
  })
  const usage = mock(() => {
    throw new Error("Token setup does not require another usage request")
  })
  await setupCopilotToken({ getCopilotToken: exchange, getCopilotUsage: usage })
  expect(state.copilotToken as string | undefined).toBe("fixture-gh-oauth")
  expect(exchange).not.toHaveBeenCalled()
  expect(usage).not.toHaveBeenCalled()
  state.githubToken = undefined
  expect(setupCopilotToken()).rejects.toThrow(
    "Direct GitHub OAuth token not found",
  )
})

test("direct GitHub headers do not impersonate OpenCode or an editor client", () => {
  directMode()
  for (const headers of [
    githubHeaders(state),
    githubUserHeaders(state),
    copilotModelsHeaders(state),
    copilotHeaders(state),
  ]) {
    expect(headers.Authorization).toBe("Bearer fixture-gh-oauth")
    expect(headers["User-Agent"]).toBe("codey-gh-auth")
    expect(headers["editor-version"]).toBeUndefined()
    expect(headers["copilot-integration-id"]).toBeUndefined()
    expect(JSON.stringify(headers)).not.toContain("opencode/")
  }
})

test("direct HTTP/WebSocket, affinity, vision and compaction use the same OAuth path", () => {
  directMode()
  const headers = requestContext.run(
    {
      traceId: "fixture",
      startTime: 0,
      userAgent: "opencode/fixture-inbound",
      sessionAffinity: "fixture-session",
      parentSessionId: "fixture-parent",
    },
    () => copilotHeaders(state, "fixture-request", true),
  )
  expect(headers["User-Agent"]).toBe("codey-gh-auth")
  expect(headers["x-session-affinity"]).toBe("fixture-session")
  expect(headers["x-parent-session-id"]).toBe("fixture-parent")
  expect(headers["Copilot-Vision-Request"]).toBe("true")
  headers["x-initiator"] = "user"
  prepareForCompact(headers, COMPACT_REQUEST)
  prepareInteractionHeaders("fixture-session", true, headers)
  expect(headers["x-initiator"]).toBe("agent")
  expect(headers["x-interaction-type"]).toBeUndefined()
  const before = { ...headers }
  prepareMessageProxyHeaders(headers)
  expect(headers).toEqual(before)
  const socket = copilotWebSocketHeaders(headers)
  expect(socket.Authorization).toBe("Bearer fixture-gh-oauth")
  expect(socket["x-initiator"]).toBeUndefined()
  expect(socket["User-Agent"]).toBe("codey-gh-auth")
})

test("OpenCode still retains its own headers and default mode still exchanges tokens", async () => {
  directMode()
  process.env.COPILOT_API_OAUTH_APP = "opencode"
  expect(copilotModelsHeaders(state)["User-Agent"]).toStartWith("opencode/")
  expect(copilotHeaders(state)["Openai-Intent"]).toBe("conversation-edits")
  delete process.env.COPILOT_API_AUTH_MODE
  delete process.env.COPILOT_API_OAUTH_APP
  const exchange = mock(() =>
    Promise.resolve({
      token: "fixture-exchanged",
      refresh_in: 3600,
      expires_at: 0,
    }),
  )
  await setupCopilotToken({
    getCopilotToken: exchange,
    getCopilotUsage: mock(() => Promise.resolve(null)),
  })
  expect(exchange).toHaveBeenCalledTimes(1)
  expect(state.copilotToken).toBe("fixture-exchanged")
  expect(copilotHeaders(state)["copilot-integration-id"]).toBe("vscode-chat")
})
