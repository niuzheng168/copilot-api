import { builtinProviderModelRegistry } from "~/lib/builtin-provider-models"
import type {
  CodexReasoningEffort,
  ModelConfig,
  ResolvedProviderConfig,
} from "~/lib/config"
import type { Reasoning, ResponsesPayload } from "~/lib/types/responses"

type ResponsesReasoningEffort = Exclude<Reasoning["effort"], null | undefined>

const RESPONSES_REASONING_EFFORTS = new Set<ResponsesReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

const REASONING_EFFORT_ALIASES: Record<string, ResponsesReasoningEffort> = {
  minimal: "low",
  xhigh: "high",
  max: "high",
  ultra: "high",
}

interface SamplingPayload {
  temperature?: number | null
  top_p?: number | null
  top_k?: number | null
}

export const applyModelDefaults = (
  payload: SamplingPayload,
  modelConfig: ModelConfig | undefined,
): void => {
  payload.temperature ??= modelConfig?.temperature
  payload.top_p ??= modelConfig?.topP
  payload.top_k ??= modelConfig?.topK
}

export const applyMissingExtraBody = (
  payload: Record<string, unknown>,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  for (const [key, value] of Object.entries(options.extraBody ?? {})) {
    if (!Object.hasOwn(payload, key)) {
      payload[key] = value
    }
  }
}

export const normalizeProviderResponsesReasoningEffort = (
  payload: ResponsesPayload,
  providerConfig: ResolvedProviderConfig,
): void => {
  const currentEffort = payload.reasoning?.effort
  if (typeof currentEffort !== "string") return

  const modelConfig = providerConfig.models?.[payload.model]
  const builtinModelConfig = builtinProviderModelRegistry.getModelConfig(
    providerConfig.name,
    payload.model,
  )
  const configuredEfforts = normalizeResponsesReasoningEfforts(
    modelConfig?.reasoningEfforts,
  )
  const builtinEfforts = normalizeResponsesReasoningEfforts(
    builtinModelConfig?.reasoningEfforts,
  )
  const supportedEfforts =
    configuredEfforts.length > 0 ? configuredEfforts : builtinEfforts

  if (
    supportedEfforts.length === 0
    || supportedEfforts.includes(currentEffort as ResponsesReasoningEffort)
  ) {
    return
  }

  const aliasedEffort = REASONING_EFFORT_ALIASES[currentEffort]
  const fallbackEffort =
    aliasedEffort && supportedEfforts.includes(aliasedEffort) ?
      aliasedEffort
    : selectSupportedReasoningEffort(
        supportedEfforts,
        modelConfig?.defaultReasoningEffort,
        builtinModelConfig?.defaultReasoningEffort,
      )

  if (payload.reasoning && fallbackEffort) {
    payload.reasoning.effort = fallbackEffort
  }
}

const normalizeResponsesReasoningEfforts = (
  efforts: Array<CodexReasoningEffort> | undefined,
): Array<ResponsesReasoningEffort> =>
  (efforts ?? []).filter((effort): effort is ResponsesReasoningEffort =>
    RESPONSES_REASONING_EFFORTS.has(effort as ResponsesReasoningEffort),
  )

const selectSupportedReasoningEffort = (
  supportedEfforts: Array<ResponsesReasoningEffort>,
  ...defaults: Array<CodexReasoningEffort | undefined>
): ResponsesReasoningEffort | undefined => {
  for (const defaultEffort of defaults) {
    if (
      defaultEffort
      && supportedEfforts.includes(defaultEffort as ResponsesReasoningEffort)
    ) {
      return defaultEffort as ResponsesReasoningEffort
    }
  }

  return supportedEfforts[0]
}
