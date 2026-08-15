import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"
import { Hono } from "hono"

import {
  createAuthMiddleware,
  getConfiguredSessionHistoryApiKeys,
} from "~/lib/request-auth"
import {
  SessionHistoryRequestError,
  SessionHistoryService,
} from "~/lib/session-history"

interface SessionHistoryRouteOptions {
  getApiKeys?: () => Array<string>
  service?: SessionHistoryService
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value === "") return fallback
  if (!/^\d+$/u.test(value)) {
    throw new SessionHistoryRequestError(`${label} must be an integer`, 400)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SessionHistoryRequestError(
      `${label} must be between ${minimum} and ${maximum}`,
      400,
    )
  }
  return parsed
}

function parseState(value: string | undefined, allowAll: boolean) {
  const states =
    allowAll ?
      new Set(["active", "archived", "all"])
    : new Set(["active", "archived"])
  const state = value ?? (allowAll ? "all" : "")
  if (!states.has(state)) {
    throw new SessionHistoryRequestError(
      `state must be ${allowAll ? "active, archived, or all" : "active or archived"}`,
      400,
    )
  }
  return state as "active" | "all" | "archived"
}

function handleError(c: Context, error: unknown): Response {
  if (error instanceof SessionHistoryRequestError) {
    return c.json(
      { error: { message: error.message, type: "session_history_error" } },
      error.status as ContentfulStatusCode,
    )
  }
  consola.error("Session history request failed", error)
  return c.json(
    {
      error: {
        message: "Session history is temporarily unavailable",
        type: "session_history_error",
      },
    },
    500,
  )
}

export function createSessionHistoryRoutes(
  options: SessionHistoryRouteOptions = {},
) {
  const service = options.service ?? new SessionHistoryService()
  const routes = new Hono()
  routes.use(
    "*",
    createAuthMiddleware({
      getApiKeys: options.getApiKeys ?? getConfiguredSessionHistoryApiKeys,
      allowUnauthenticatedPaths: [],
      allowWhenNoApiKeys: false,
    }),
  )

  routes.get("/", async (c) => {
    try {
      const query = (c.req.query("q") ?? "").trim()
      if (query.length > 256) {
        throw new SessionHistoryRequestError(
          "q must be at most 256 characters",
          400,
        )
      }
      return c.json(
        await service.list({
          state: parseState(c.req.query("state"), true),
          query,
          limit: parseInteger(c.req.query("limit"), 50, 1, 1000, "limit"),
          offset: parseInteger(
            c.req.query("offset"),
            0,
            0,
            Number.MAX_SAFE_INTEGER,
            "offset",
          ),
          startAtMs: parseInteger(
            c.req.query("start_at_ms"),
            0,
            0,
            Number.MAX_SAFE_INTEGER,
            "start_at_ms",
          ),
        }),
      )
    } catch (error) {
      return handleError(c, error)
    }
  })

  routes.get("/:state/:sessionId", async (c) => {
    try {
      const state = parseState(c.req.param("state"), false)
      return c.json(
        await service.detail(
          state as "active" | "archived",
          c.req.param("sessionId"),
        ),
      )
    } catch (error) {
      return handleError(c, error)
    }
  })

  return routes
}

export const sessionHistoryRoutes = createSessionHistoryRoutes()
