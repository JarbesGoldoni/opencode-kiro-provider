import { beforeEach, describe, expect, test } from "bun:test"
import { setCatalogForTest } from "./models"
import { buildKiroRequest, cleanSchema, effortFields } from "./request"

beforeEach(() => {
  setCatalogForTest([
    { modelId: "claude-opus-5", effortPath: "output_config", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { modelId: "gpt-5.6-sol", effortPath: "reasoning", effortLevels: ["low", "medium", "high", "xhigh"] },
    { modelId: "qwen3-coder-next" },
  ])
})

const tools = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", title: "Bash", properties: { command: { type: "string", default: "ls" }, title: { type: "string" } }, required: ["command"] },
    },
  },
  { type: "function", function: { name: "github.search/issues", description: "", parameters: {} } },
]

describe("buildKiroRequest", () => {
  test("simple turn: system goes in front of the only user message", () => {
    const { body } = buildKiroRequest(
      { model: "claude-opus-5", stream: true, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] },
      "arn:aws:codewhisperer:us-east-1:111122223333:profile/ABC",
    )
    expect(body.profileArn).toBe("arn:aws:codewhisperer:us-east-1:111122223333:profile/ABC")
    expect(body.conversationState.history).toBeUndefined()
    const cur = body.conversationState.currentMessage.userInputMessage
    expect(cur.content).toBe("Be brief.\n\nhi")
    expect(cur.modelId).toBe("claude-opus-5")
    expect(cur.origin).toBe("AI_EDITOR")
    expect(body.conversationState.chatTriggerType).toBe("MANUAL")
  })

  test("tool round trip: history alternates and results pair with tool uses", () => {
    const { body, toolNames } = buildKiroRequest(
      {
        model: "gpt-5.6-sol",
        tools,
        reasoning_effort: "high",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "list files" },
          { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
          { role: "tool", tool_call_id: "t1", content: "a.txt" },
        ],
      },
      undefined,
    )
    const h = body.conversationState.history
    expect(h).toHaveLength(2)
    expect(h[0].userInputMessage.content).toBe("sys\n\nlist files")
    expect(h[1].assistantResponseMessage.toolUses).toEqual([{ toolUseId: "t1", name: "bash", input: { command: "ls" } }])
    const cur = body.conversationState.currentMessage.userInputMessage
    expect(cur.content).toBe("")
    expect(cur.userInputMessageContext.toolResults).toEqual([{ toolUseId: "t1", content: [{ text: "a.txt" }], status: "success" }])
    const specNames = cur.userInputMessageContext.tools.map((t: any) => t.toolSpecification.name)
    expect(specNames).toEqual(["bash", "github_search_issues"])
    expect(toolNames.get("github_search_issues")).toBe("github.search/issues")
    expect(body.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } })
  })

  test("parallel tool results merge into one user turn; missing results are filled", () => {
    const { body } = buildKiroRequest(
      {
        model: "claude-opus-5",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "running",
            tool_calls: [
              { id: "a", type: "function", function: { name: "bash", arguments: "{}" } },
              { id: "b", type: "function", function: { name: "bash", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "a", content: "ok-a" },
          { role: "user", content: "and then?" },
        ],
      },
      undefined,
    )
    const cur = body.conversationState.currentMessage.userInputMessage
    expect(cur.content).toBe("and then?")
    expect(cur.userInputMessageContext.toolResults.map((r: any) => [r.toolUseId, r.status])).toEqual([
      ["a", "success"],
      ["b", "error"],
    ])
    // history tool "bash" is declared even though no tools were sent this turn
    expect(cur.userInputMessageContext.tools.map((t: any) => t.toolSpecification.name)).toEqual(["bash"])
  })

  test("orphan tool results become text", () => {
    const { body } = buildKiroRequest(
      { model: "claude-opus-5", messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }, { role: "tool", tool_call_id: "zz", content: "late" }] },
      undefined,
    )
    const cur = body.conversationState.currentMessage.userInputMessage
    expect(cur.userInputMessageContext).toBeUndefined()
    expect(cur.content).toContain("late")
  })

  test("assistant-first and assistant-last conversations are repaired", () => {
    const { body } = buildKiroRequest({ model: "auto", messages: [{ role: "assistant", content: "hello" }] }, undefined)
    expect(body.conversationState.history[0].userInputMessage.content).toBe("Continue.")
    expect(body.conversationState.history[1].assistantResponseMessage.content).toBe("hello")
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("Continue.")
  })

  test("images are passed as bytes", () => {
    const { body } = buildKiroRequest(
      {
        model: "claude-opus-5",
        messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
      },
      undefined,
    )
    expect(body.conversationState.currentMessage.userInputMessage.images).toEqual([{ format: "png", source: { bytes: "AAAA" } }])
  })

  test("conversation id is stable across turns of the same session", () => {
    const base = [{ role: "system", content: "s" }, { role: "user", content: "first" }]
    const a = buildKiroRequest({ model: "auto", messages: base }, undefined)
    const b = buildKiroRequest({ model: "auto", messages: [...base, { role: "assistant", content: "r" }, { role: "user", content: "second" }] }, undefined)
    expect(a.body.conversationState.conversationId).toBe(b.body.conversationState.conversationId)
  })
})

describe("effortFields", () => {
  test("uses the model's schema path", () => {
    expect(effortFields("claude-opus-5", "xhigh")).toEqual({ output_config: { effort: "xhigh" } })
    expect(effortFields("gpt-5.6-sol", "low")).toEqual({ reasoning: { effort: "low" } })
  })
  test("clamps unsupported levels to the highest supported one below", () => {
    expect(effortFields("gpt-5.6-sol", "max")).toEqual({ reasoning: { effort: "xhigh" } })
  })
  test("no effort for models without an effort schema", () => {
    expect(effortFields("qwen3-coder-next", "high")).toBeUndefined()
    expect(effortFields("claude-opus-5", undefined)).toBeUndefined()
  })
})

test("cleanSchema strips keys Kiro rejects but keeps property names", () => {
  expect(cleanSchema(tools[0].function.parameters)).toEqual({
    type: "object",
    properties: { command: { type: "string" }, title: { type: "string" } },
    required: ["command"],
  })
  expect(cleanSchema({})).toEqual({ type: "object", properties: {} })
})
