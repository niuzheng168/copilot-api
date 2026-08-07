import { Hono, type Context } from "hono"
import consola from "consola"

import {
  isAlphaSearchCodexPriorityEnabled,
  resolveMappedModel,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJsonAsync } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type {
  AlphaSearchRequest,
  AlphaSearchResponse,
} from "~/routes/alpha-search/alpha-search-types"
import { handleAlphaSearchResponses } from "~/routes/alpha-search/alpha-search-responses"
import { forwardCodexAlphaSearch } from "~/services/codex/alpha-search"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("alpha-search-handler")

export const alphaSearchRoutes = new Hono()

function parseDebugBody<T>(body: string): T | string {
  try {
    return JSON.parse(body) as T
  } catch {
    return body
  }
}

async function forwardCodexAlphaSearchRequest(
  request: Request,
): Promise<Response> {
  await debugJsonAsync(logger, "alpha_search.codex.request", async () => ({
    body: parseDebugBody<AlphaSearchRequest>(await request.clone().text()),
  }))

  const upstreamResponse = await forwardCodexAlphaSearch(request)
  await debugJsonAsync(logger, "alpha_search.codex.response", async () => ({
    body: parseDebugBody<AlphaSearchResponse>(
      await upstreamResponse.clone().text(),
    ),
    statusCode: upstreamResponse.status,
  }))
  return createProviderProxyResponse(upstreamResponse)
}

function createAlphaSearchRequest(
  request: Request,
  payload: AlphaSearchRequest,
): Request {
  return new Request(request, {
    body: JSON.stringify(payload),
    method: "post",
  })
}

async function handleCodexRequest(
  c: Context,
  request: Request,
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

  return await forwardCodexAlphaSearchRequest(request)
}

function invalidRequest(c: Context, message: string): Response {
  return c.json(
    {
      error: {
        message,
        type: "invalid_request_error",
      },
    },
    400,
  )
}

async function parseAlphaSearchBody(
  c: Context,
): Promise<AlphaSearchRequest | Response> {
  let body: unknown
  try {
    body = await c.req.raw.clone().json()
  } catch {
    return invalidRequest(c, "Invalid alpha search request: expected JSON body")
  }

  const model = (body as AlphaSearchRequest | null)?.model
  if (typeof model !== "string") {
    return invalidRequest(
      c,
      "Invalid alpha search request: model must be a string",
    )
  }
  return body as AlphaSearchRequest
}

/**
 * Handles top-level alpha-search dispatch. Pass `resolvedProviderConfig` when
 * the provider-scoped route has already resolved Codex. Codex is preferred
 * for every top-level request while alphaSearchCodexPriority stays enabled.
 */
export async function handleAlphaSearchRequest(
  c: Context,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  if (resolvedProviderConfig) {
    return await handleCodexRequest(c, c.req.raw, resolvedProviderConfig)
  }

  const payload = await parseAlphaSearchBody(c)
  if (payload instanceof Response) return payload

  const requestedModel = payload.model

  payload.model = resolveMappedModel(requestedModel)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    if (providerModelAlias.provider === "codex") {
      return await handleCodexRequest(
        c,
        createAlphaSearchRequest(c.req.raw, payload),
      )
    }
  }

  if (isAlphaSearchCodexPriorityEnabled()) {
    const codexProviderConfig = await resolveProviderConfig("codex")
    if (codexProviderConfig) {
      return await forwardCodexAlphaSearchRequest(
        createAlphaSearchRequest(c.req.raw, payload),
      )
    }
  }

  if (providerModelAlias) {
    return await handleAlphaSearchResponses(c, {
      provider: providerModelAlias.provider,
      request: payload,
    })
  }

  return await handleAlphaSearchResponses(c, {
    request: {
      ...payload,
      model: requestedModel,
    },
  })
}

alphaSearchRoutes.post("/", async (c) => {
  try {
    return await handleAlphaSearchRequest(c)
  } catch (error) {
    logger.error("alpha_search.error", { error })
    return await forwardError(c, error)
  }
})
