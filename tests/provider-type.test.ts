import { beforeEach, describe, expect, test } from "bun:test"

import {
  resolveEffectiveProviderType,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { installModelsDevCatalog } from "~/lib/models-dev-cache"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

const createProviderConfig = (
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig => ({
  apiKey: "provider-key",
  authType: "authorization",
  baseUrl: "https://opencode.example/zen/go",
  name: "opencode-go",
  type: "openai-compatible",
  ...overrides,
})

describe("effective provider type", () => {
  beforeEach(() => {
    installModelsDevCatalog(modelsDevCatalogFixture)
  })

  test("uses Anthropic for models with the Anthropic npm package", () => {
    const providerConfig = createProviderConfig()

    expect(resolveEffectiveProviderType(providerConfig, "qwen3.8-flash")).toBe(
      "anthropic",
    )
    expect(resolveEffectiveProviderType(providerConfig, "MiniMax-M3")).toBe(
      "anthropic",
    )
  })

  test("uses OpenAI Responses for models with the OpenAI npm package", () => {
    expect(
      resolveEffectiveProviderType(createProviderConfig(), "gpt-5.6-luna"),
    ).toBe("openai-responses")
  })

  test("uses OpenAI Responses for OpenCode Go Grok models", () => {
    expect(
      resolveEffectiveProviderType(createProviderConfig(), "grok-4.7"),
    ).toBe("openai-responses")
  })

  test("uses npm metadata rather than model ID prefixes", () => {
    installModelsDevCatalog({
      "opencode-go": {
        models: {
          "messages-model": {
            id: "messages-model",
            provider: { npm: "@ai-sdk/anthropic" },
          },
          "responses-model": {
            id: "responses-model",
            provider: { npm: "@ai-sdk/openai" },
          },
          "gpt-chat": {
            id: "gpt-chat",
            provider: { npm: "@ai-sdk/openai", shape: "completions" },
          },
          "unknown-package": {
            id: "unknown-package",
            provider: { npm: "@ai-sdk/other" },
          },
        },
      },
    })
    const providerConfig = createProviderConfig()
    expect(resolveEffectiveProviderType(providerConfig, "messages-model")).toBe(
      "anthropic",
    )
    expect(
      resolveEffectiveProviderType(providerConfig, "responses-model"),
    ).toBe("openai-responses")
    expect(resolveEffectiveProviderType(providerConfig, "gpt-chat")).toBe(
      "openai-compatible",
    )
    expect(
      resolveEffectiveProviderType(providerConfig, "unknown-package"),
    ).toBe("openai-compatible")
  })

  test("uses provider npm when a model has no npm override", () => {
    for (const [npm, expectedType] of [
      ["@ai-sdk/anthropic", "anthropic"],
      ["@ai-sdk/openai", "openai-responses"],
      ["@ai-sdk/openai-compatible", "openai-compatible"],
    ] as const) {
      installModelsDevCatalog({
        "opencode-go": {
          npm,
          models: { "provider-default": { id: "provider-default" } },
        },
      })
      expect(
        resolveEffectiveProviderType(
          createProviderConfig(),
          "provider-default",
        ),
      ).toBe(expectedType)
    }
  })

  test("defaults to OpenAI-compatible when npm is absent or unknown", () => {
    const providerConfig = createProviderConfig()

    expect(resolveEffectiveProviderType(providerConfig, "glm-5.2")).toBe(
      "openai-compatible",
    )
    expect(resolveEffectiveProviderType(providerConfig, "gptfoo")).toBe(
      "openai-compatible",
    )
    expect(resolveEffectiveProviderType(providerConfig, "qwen3.8-max")).toBe(
      "openai-compatible",
    )
    expect(
      resolveEffectiveProviderType(providerConfig, "gpt-provider-only"),
    ).toBe("openai-compatible")
    installModelsDevCatalog({
      "opencode-go": {
        models: { "no-npm": { id: "no-npm" } },
      },
    })
    expect(resolveEffectiveProviderType(providerConfig, "no-npm")).toBe(
      "openai-compatible",
    )
  })

  test("does not apply OpenCode Go rules to other providers", () => {
    expect(
      resolveEffectiveProviderType(
        createProviderConfig({ name: "custom" }),
        "qwen3.8-flash",
      ),
    ).toBe("openai-compatible")
  })

  test("keeps an explicit model type override ahead of built-in rules", () => {
    expect(
      resolveEffectiveProviderType(
        createProviderConfig({
          models: {
            "qwen3.8-flash": { type: "openai-compatible" },
          },
        }),
        "qwen3.8-flash",
      ),
    ).toBe("openai-compatible")
  })
})
