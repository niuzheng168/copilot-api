import { Hono } from "hono"
import { z } from "zod"

import { forwardError } from "~/lib/error"
import { getEditableModelMappings, setModelMappings } from "~/lib/config"
import { reloadServerConfig } from "~/lib/config-reload"
import { PATHS } from "~/lib/paths"
import {
  codeySettings,
  CodeySettingsError,
  isCodeyProxyModelAlias,
} from "~/lib/codey-settings"

export const configRoutes = new Hono()

configRoutes.get("/codey-settings", (c) => {
  try {
    return c.json(codeySettings.status())
  } catch (error) {
    return c.json(
      {
        error: {
          message:
            error instanceof CodeySettingsError ?
              error.message
            : "Cannot read node settings.",
        },
      },
      503,
    )
  }
})

configRoutes.put("/codey-settings", async (c) => {
  try {
    return c.json(codeySettings.save(await c.req.json()))
  } catch (error) {
    return c.json(
      {
        error: {
          message:
            error instanceof CodeySettingsError ?
              error.message
            : "Cannot save node settings.",
        },
      },
      error instanceof CodeySettingsError ? error.status
      : error instanceof SyntaxError ? 400
      : 503,
    )
  }
})

const modelMappingsRequestSchema = z.object({
  modelMappings: z.record(
    z.string(),
    z
      .string()
      .refine(
        (target) =>
          !codeySettings.isEnabled() || !isCodeyProxyModelAlias(target),
        "Configure additional proxy routes in the node settings file.",
      ),
  ),
})

configRoutes.post("/reload", async (c) => {
  try {
    await reloadServerConfig()
    return c.json({ configPath: PATHS.CONFIG_PATH, reloaded: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/model-mappings", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    modelMappings: getEditableModelMappings(),
  })
})

configRoutes.post("/model-mappings", async (c) => {
  try {
    const parseResult = modelMappingsRequestSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedModelMappings = setModelMappings(
      parseResult.data.modelMappings,
    )

    return c.json({
      configPath: PATHS.CONFIG_PATH,
      modelMappings: updatedModelMappings,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
