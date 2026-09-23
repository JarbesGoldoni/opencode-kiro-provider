import { expect, test } from "bun:test"
import { parseModel, toOpencodeModels } from "./models"

// Shape of a ListAvailableModels entry, per the Kiro IDE's schema.
const gpt = {
  modelId: "gpt-5.6-sol",
  modelName: "GPT-5.6 Sol",
  rateMultiplier: 4.4,
  tokenLimits: { maxInputTokens: 272000, maxOutputTokens: 128000 },
  supportedInputTypes: ["TEXT", "IMAGE"],
  additionalModelRequestFieldsSchema: {
    type: "object",
    properties: { reasoning: { type: "object", properties: { effort: { type: "string", enum: ["low", "medium", "high", "xhigh"], default: "medium" } } } },
  },
}
const opus = {
  modelId: "claude-opus-5",
  modelName: "Claude Opus 5",
  rateMultiplier: 2.2,
  tokenLimits: { maxInputTokens: 1000000 },
  additionalModelRequestFieldsSchema: JSON.stringify({
    properties: { output_config: { properties: { effort: { enum: ["low", "medium", "high", "xhigh", "max"], default: "high" } } } },
  }),
}

test("parseModel reads limits and the effort schema (object or JSON string)", () => {
  expect(parseModel(gpt)).toMatchObject({ modelId: "gpt-5.6-sol", maxInputTokens: 272000, effortPath: "reasoning", effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" })
  expect(parseModel(opus)).toMatchObject({ effortPath: "output_config", effortLevels: ["low", "medium", "high", "xhigh", "max"] })
  expect(parseModel({})).toBeUndefined()
})

test("toOpencodeModels uses real limits and exposes effort variants", () => {
  const out = toOpencodeModels([parseModel(gpt)!, parseModel(opus)!, parseModel({ modelId: "qwen3-coder-next", supportedInputTypes: ["TEXT"] })!])
  expect(out["gpt-5.6-sol"]).toMatchObject({ name: "GPT-5.6 Sol (4.4x)", reasoning: true, attachment: true, limit: { context: 272000, output: 128000 } })
  expect(out["gpt-5.6-sol"].variants.xhigh).toEqual({ reasoningEffort: "xhigh" })
  expect(out["claude-opus-5"].limit.context).toBe(1000000)
  expect(out["claude-opus-5"].variants.max).toEqual({ reasoningEffort: "max" })
  expect(out["qwen3-coder-next"]).toMatchObject({ reasoning: false, attachment: false, modalities: { input: ["text"] } })
  expect(out["qwen3-coder-next"].variants.high).toEqual({ disabled: true })
})
