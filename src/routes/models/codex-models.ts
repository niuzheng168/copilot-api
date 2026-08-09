import type { Context } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type {
  CodexModel,
  CodexModelsResponse,
  SyntheticCodexModelCandidate,
} from "~/routes/models/codex-models-types"
import { forwardCodexModels } from "~/services/codex/get-models"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("codex-models-handler")
const CODEX_USER_AGENT_PATTERN = /^codex/iu
const FALLBACK_BASE_INSTRUCTIONS =
  "You are a coding agent. Follow the user's instructions, inspect the workspace as needed, use the available tools carefully, and continue until the task is complete."
const FALLBACK_AVAILABLE_IN_PLANS: CodexModel["available_in_plans"] = [
  "business",
  "edu",
  "edu_plus",
  "edu_pro",
  "education",
  "enterprise",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "finserv",
  "free",
  "free_workspace",
  "go",
  "hc",
  "k12",
  "plus",
  "pro",
  "prolite",
  "quorum",
  "sci",
  "self_serve_business_usage_based",
  "team",
]

export function isCodexUserAgent(userAgent: string | undefined): boolean {
  return CODEX_USER_AGENT_PATTERN.test(userAgent?.trim() ?? "")
}

async function logCodexModelsResponse(response: Response): Promise<void> {
  try {
    const models = (await response.clone().json()) as CodexModelsResponse
    debugJson(logger, "models.codex.response", {
      statusCode: response.status,
      models,
    })
  } catch (error) {
    logger.warn("models.codex.response_log_error", { error })
  }
}

/**
 * Proxies a models request to the fixed Codex upstream models endpoint.
 * Returns a 404 JSON response when the codex provider is unavailable.
 * Pass `resolvedProviderConfig` when the caller already resolved the codex
 * provider to avoid a second resolve.
 */
export async function handleCodexModelsProxy(
  c: Context,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  const codexProviderConfig =
    resolvedProviderConfig ?? (await resolveProviderConfig("codex"))
  if (!codexProviderConfig) {
    return c.json(
      {
        error: {
          message: "Provider 'codex' not found or disabled",
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  const upstreamResponse = await forwardCodexModels(
    c.req.url,
    c.req.raw.headers,
  )
  await logCodexModelsResponse(upstreamResponse)
  return createProviderProxyResponse(upstreamResponse)
}

export async function handleMergedCodexModels(
  c: Context,
  candidatesRequest:
    | Array<SyntheticCodexModelCandidate>
    | Promise<Array<SyntheticCodexModelCandidate>>,
): Promise<Response> {
  const [upstreamCatalog, candidates] = await Promise.all([
    tryGetCodexCatalog(c),
    candidatesRequest,
  ])
  const upstreamModels = upstreamCatalog?.models ?? []
  const template = selectTemplate(upstreamModels)
  const seenSlugs = new Set(upstreamModels.map((model) => model.slug))
  const syntheticModels = candidates
    .filter((candidate) => !seenSlugs.has(candidate.slug))
    .map((candidate, index) =>
      createSyntheticCodexModel(
        candidate,
        template,
        upstreamModels.length + index,
      ),
    )

  const response: CodexModelsResponse = {
    ...(upstreamCatalog ?? {}),
    models: [...upstreamModels, ...syntheticModels],
  }
  debugJson(logger, "models.codex.merged_response", {
    upstreamCount: upstreamModels.length,
    syntheticCount: syntheticModels.length,
    models: response,
  })
  return c.json(response)
}

export function createSyntheticCodexModel(
  candidate: SyntheticCodexModelCandidate,
  template: CodexModel | undefined,
  priority: number,
): CodexModel {
  const reasoningEfforts =
    candidate.reasoningEfforts.length > 0 ?
      candidate.reasoningEfforts
    : [candidate.defaultReasoningEffort]
  const defaultReasoningEffort =
    reasoningEfforts.includes(candidate.defaultReasoningEffort) ?
      candidate.defaultReasoningEffort
    : reasoningEfforts[0]
  const supportsReasoning = reasoningEfforts.some((effort) => effort !== "none")
  const inputModalities = [...new Set(candidate.inputModalities)]

  return {
    ...(template ?? {}),
    slug: candidate.slug,
    display_name: candidate.displayName,
    description: candidate.description,
    priority,
    visibility: "list",
    supported_in_api: true,
    minimal_client_version: "0.0.0",
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    supports_search_tool: false,
    use_responses_lite: true,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    shell_type: "shell_command",
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    supports_image_detail_original: false,
    supports_parallel_tool_calls: candidate.supportsParallelToolCalls,
    context_window: candidate.contextWindow,
    max_context_window: candidate.contextWindow,
    max_output_tokens: candidate.maxOutputTokens,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    default_reasoning_level: defaultReasoningEffort,
    supported_reasoning_levels: reasoningEfforts.map((effort) => ({
      effort,
      description: `${effort} reasoning effort`,
    })),
    supports_reasoning_summary_parameter: supportsReasoning,
    supports_reasoning_summaries: supportsReasoning,
    default_reasoning_summary: supportsReasoning ? "auto" : "none",
    reasoning_summary_format: "experimental",
    availability_nux: null,
    upgrade: null,
    available_in_plans:
      template?.available_in_plans ?? FALLBACK_AVAILABLE_IN_PLANS,
    model_messages: template?.model_messages ?? {
      instructions_template: FALLBACK_BASE_INSTRUCTIONS,
      instructions_variables: null,
      approvals: null,
      auto_review: null,
      permissions: null,
    },
    auto_review_model_override: null,
    default_service_tier: null,
    service_tiers: [],
    additional_speed_tiers: [],
    include_skills_usage_instructions: false,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    base_instructions:
      template?.base_instructions?.trim() ?
        template.base_instructions
      : FALLBACK_BASE_INSTRUCTIONS,
  }
}

async function tryGetCodexCatalog(
  c: Context,
): Promise<CodexModelsResponse | null> {
  try {
    const providerConfig = await resolveProviderConfig("codex")
    if (!providerConfig) return null

    const response = await forwardCodexModels(c.req.url, c.req.raw.headers)
    if (!response.ok) {
      logger.warn("models.codex.catalog_fallback", {
        statusCode: response.status,
      })
      return null
    }

    const body = await response.json()
    if (!isCodexModelsResponse(body)) {
      logger.warn("models.codex.catalog_invalid")
      return null
    }
    return body
  } catch (error) {
    logger.warn("models.codex.catalog_error", { error })
    return null
  }
}

function selectTemplate(models: Array<CodexModel>): CodexModel | undefined {
  return (
    models.find(
      (model) =>
        model.visibility === "list" && model.supported_in_api !== false,
    ) ?? models[0]
  )
}

function isCodexModelsResponse(value: unknown): value is CodexModelsResponse {
  if (!isRecord(value) || !Array.isArray(value.models)) return false
  return value.models.every(
    (model: unknown) => isRecord(model) && typeof model.slug === "string",
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
