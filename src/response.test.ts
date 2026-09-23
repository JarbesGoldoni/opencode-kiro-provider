import { expect, test } from "bun:test"
import { EventStreamDecoder, encodeMessage } from "./eventstream"
import { setCatalogForTest } from "./models"
import { toOpenAIJson, toOpenAIStream } from "./response"

const ev = (type: string, data: unknown) => encodeMessage({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, JSON.stringify(data))

function kiroResponse(frames: Uint8Array[], splitAt = 7): Response {
  // Deliver bytes in awkward chunk sizes to exercise the incremental decoder.
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0))
  let o = 0
  for (const f of frames) {
    all.set(f, o)
    o += f.length
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < all.length; i += splitAt) c.enqueue(all.slice(i, i + splitAt))
      c.close()
    },
  })
  return new Response(stream)
}

async function sse(res: Response) {
  const text = await res.text()
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .filter((l) => l !== "[DONE]")
    .map((l) => JSON.parse(l))
}

test("decoder round-trips frames split across chunks", () => {
  const d = new EventStreamDecoder()
  const bytes = ev("assistantResponseEvent", { content: "hé" })
  expect(d.push(bytes.slice(0, 5))).toEqual([])
  const msgs = d.push(bytes.slice(5))
  expect(msgs).toHaveLength(1)
  expect(msgs[0].headers[":event-type"]).toBe("assistantResponseEvent")
  expect(JSON.parse(new TextDecoder().decode(msgs[0].payload))).toEqual({ content: "hé" })
})

test("stream: text, reasoning, tool call and real usage", async () => {
  setCatalogForTest([{ modelId: "claude-opus-5", maxInputTokens: 1_000_000 }])
  const res = toOpenAIStream(
    kiroResponse([
      ev("reasoningContentEvent", { text: "thinking..." }),
      ev("assistantResponseEvent", { content: "Let me look." }),
      ev("toolUseEvent", { toolUseId: "tu1", name: "github_search_issues", input: '{"q":' }),
      ev("toolUseEvent", { toolUseId: "tu1", name: "github_search_issues", input: '"bug"}' }),
      ev("toolUseEvent", { toolUseId: "tu1", name: "github_search_issues", stop: true }),
      ev("metadataEvent", { tokenUsage: { uncachedInputTokens: 100, cacheReadInputTokens: 900, outputTokens: 20 } }),
    ]),
    "claude-opus-5",
    new Map([["github_search_issues", "github.search/issues"]]),
  )
  const chunks = await sse(res)
  const deltas = chunks.map((c) => c.choices[0].delta)
  expect(deltas.some((d) => d.reasoning_content === "thinking...")).toBe(true)
  expect(deltas.some((d) => d.content === "Let me look.")).toBe(true)
  const start = deltas.find((d) => d.tool_calls?.[0]?.id)
  expect(start.tool_calls[0]).toEqual({ index: 0, id: "tu1", type: "function", function: { name: "github.search/issues", arguments: "" } })
  const args = deltas.flatMap((d) => d.tool_calls ?? []).map((t: any) => t.function.arguments).join("")
  expect(JSON.parse(args)).toEqual({ q: "bug" })
  const last = chunks[chunks.length - 1]
  expect(last.choices[0].finish_reason).toBe("tool_calls")
  expect(last.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 900 } })
})

test("stream: no-arg tool gets {} arguments; exceptions become errors", async () => {
  const chunks = await sse(
    toOpenAIStream(
      kiroResponse([
        ev("toolUseEvent", { toolUseId: "x", name: "todoread", stop: true }),
        encodeMessage({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, JSON.stringify({ message: "slow down" })),
      ]),
      "auto",
      new Map(),
    ),
  )
  const args = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []).map((t: any) => t.function.arguments).join("")
  expect(args).toBe("{}")
  expect(chunks.some((c) => c.error?.message?.includes("ThrottlingException"))).toBe(true)
})

test("usage falls back to context percentage of the real input window", async () => {
  setCatalogForTest([{ modelId: "claude-opus-5", maxInputTokens: 1_000_000 }])
  const chunks = await sse(toOpenAIStream(kiroResponse([ev("assistantResponseEvent", { content: "abcd" }), ev("contextUsageEvent", { contextUsagePercentage: 50 })]), "claude-opus-5", new Map()))
  const usage = chunks[chunks.length - 1].usage
  expect(usage.prompt_tokens + usage.completion_tokens).toBe(500_000)
})

test("non-streaming JSON response", async () => {
  const res = await toOpenAIJson(kiroResponse([ev("assistantResponseEvent", { content: "Title: Fix bug" })]), "auto", new Map())
  const body = (await res.json()) as any
  expect(body.object).toBe("chat.completion")
  expect(body.choices[0].message.content).toBe("Title: Fix bug")
  expect(body.choices[0].finish_reason).toBe("stop")
})
