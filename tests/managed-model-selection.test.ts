import { expect, test } from "bun:test"

import { getModelMappings, resolveMappedModel } from "~/lib/model-policy"

test("managed requests retain each selected model without compatibility or owner redirects", () => {
  const previous = process.env.CODEY_MANAGED
  process.env.CODEY_MANAGED = "true"
  try {
    expect(getModelMappings()).toEqual({})
    for (const model of [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "owner/custom",
      "unavailable-model",
    ]) {
      expect(resolveMappedModel(model)).toBe(model)
    }
    expect(resolveMappedModel("codex/gpt-6-astra")).toBe("gpt-6-astra")
  } finally {
    if (previous === undefined)
      Reflect.deleteProperty(process.env, "CODEY_MANAGED")
    else process.env.CODEY_MANAGED = previous
  }
})
