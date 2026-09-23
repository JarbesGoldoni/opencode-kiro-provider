import { debug } from "./env"
import { EventStreamDecoder, type StreamMessage } from "./eventstream"
import { findModel } from "./models"

/**
 * Turns Kiro's event stream into OpenAI Chat Completions output:
 * an SSE stream of chat.completion.chunk objects, or one chat.completion JSON.
 *
 * Kiro events (schema from the Kiro IDE bundle):
 *   assistantResponseEvent { content }
 *   reasoningContentEvent  { text, signature, redactedContent }
 *   toolUseEvent           { toolUseId, name, input (partial JSON string), stop }
 *   metadataEvent          { tokenUsage { uncachedInputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens, ... } }
 *   contextUsageEvent      { contextUsagePercentage }
 *   meteringEvent          { usage, unit }      credits spent
 *   invalidStateEvent      { reason, message }
 */

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
}

type Delta =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-start"; index: number; id: string; name: string }
  | { kind: "tool-args"; index: number; args: string }
  | { kind: "error"; message: string }

class KiroTranslator {
  private tools = new Map<string, { index: number; name: string; args: string }>()
  private tokenUsage: any
  private contextPct: number | undefined
  private outputChars = 0
  credits: number | undefined

  constructor(
    private modelId: string,
    private toolNames: Map<string, string>,
  ) {}

  get hasTools() {
    return this.tools.size > 0
  }

  handle(msg: StreamMessage): Delta[] {
    const type = String(msg.headers[":message-type"] ?? "event")
    const event = String(msg.headers[":event-type"] ?? msg.headers[":exception-type"] ?? "")
    let data: any = {}
    try {
      data = msg.payload.length ? JSON.parse(new TextDecoder().decode(msg.payload)) : {}
    } catch {}

    if (type === "exception" || type === "error") {
      return [{ kind: "error", message: `Kiro ${event || "error"}: ${data.message ?? data.Message ?? JSON.stringify(data)}` }]
    }

    switch (event) {
      case "assistantResponseEvent":
        if (!data.content) return []
        this.outputChars += data.content.length
        return [{ kind: "text", text: data.content }]
      case "reasoningContentEvent":
        if (!data.text) return []
        this.outputChars += data.text.length
        return [{ kind: "reasoning", text: data.text }]
      case "toolUseEvent": {
        const out: Delta[] = []
        const id: string = data.toolUseId
        if (!id) return out
        let tool = this.tools.get(id)
        if (!tool) {
          const name = this.toolNames.get(data.name) ?? data.name
          tool = { index: this.tools.size, name, args: "" }
          this.tools.set(id, tool)
          out.push({ kind: "tool-start", index: tool.index, id, name })
        }
        const input = typeof data.input === "string" ? data.input : data.input != null ? JSON.stringify(data.input) : ""
        if (input) {
          tool.args += input
          this.outputChars += input.length
          out.push({ kind: "tool-args", index: tool.index, args: input })
        }
        if (data.stop && !tool.args) {
          tool.args = "{}"
          out.push({ kind: "tool-args", index: tool.index, args: "{}" })
        }
        return out
      }
      case "metadataEvent":
        if (data.tokenUsage) this.tokenUsage = data.tokenUsage
        return []
      case "contextUsageEvent":
        this.contextPct = data.contextUsagePercentage
        return []
      case "meteringEvent":
        if (typeof data.usage === "number") this.credits = (this.credits ?? 0) + data.usage
        return []
      case "invalidStateEvent":
        return [{ kind: "error", message: `Kiro rejected the request: ${data.message ?? data.reason ?? "invalid state"}` }]
      default:
        return []
    }
  }

  finishReason(): "tool_calls" | "stop" {
    return this.hasTools ? "tool_calls" : "stop"
  }

  usage(): Usage {
    const u = this.tokenUsage
    if (u) {
      const cached = u.cacheReadInputTokens ?? 0
      const prompt = (u.uncachedInputTokens ?? 0) + cached + (u.cacheWriteInputTokens ?? 0)
      const completion = u.outputTokens ?? 0
      return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } }
    }
    // Older backends only report context usage as a percentage of the model's input window.
    const window = findModel(this.modelId)?.maxInputTokens ?? 200_000
    const completion = Math.ceil(this.outputChars / 4)
    const prompt = this.contextPct !== undefined ? Math.max(0, Math.round((window * this.contextPct) / 100) - completion) : 0
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  }
}

function chunk(id: string, model: string, delta: Record<string, any>, finish: string | null = null, usage?: Usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

function deltaToOpenAI(d: Delta): Record<string, any> | undefined {
  switch (d.kind) {
    case "text":
      return { content: d.text }
    case "reasoning":
      return { reasoning_content: d.text }
    case "tool-start":
      return { tool_calls: [{ index: d.index, id: d.id, type: "function", function: { name: d.name, arguments: "" } }] }
    case "tool-args":
      return { tool_calls: [{ index: d.index, function: { arguments: d.args } }] }
  }
}

export function toOpenAIStream(kiro: Response, modelId: string, toolNames: Map<string, string>): Response {
  const id = `chatcmpl-kiro-${crypto.randomUUID()}`
  const translator = new KiroTranslator(modelId, toolNames)
  const decoder = new EventStreamDecoder()
  const enc = new TextEncoder()
  const reader = kiro.body!.getReader()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
      send(chunk(id, modelId, { role: "assistant", content: "" }))
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const msg of decoder.push(value)) {
            for (const d of translator.handle(msg)) {
              if (d.kind === "error") {
                send({ error: { message: d.message, type: "kiro_error" } })
                continue
              }
              const delta = deltaToOpenAI(d)
              if (delta) send(chunk(id, modelId, delta))
            }
          }
        }
        send(chunk(id, modelId, {}, translator.finishReason(), translator.usage()))
        debug("response.done", { modelId, usage: translator.usage(), credits: translator.credits })
      } catch (e) {
        send({ error: { message: `Kiro stream failed: ${e instanceof Error ? e.message : e}`, type: "kiro_error" } })
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

export async function toOpenAIJson(kiro: Response, modelId: string, toolNames: Map<string, string>): Promise<Response> {
  const translator = new KiroTranslator(modelId, toolNames)
  const decoder = new EventStreamDecoder()
  let content = ""
  let reasoning = ""
  const calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = []
  const errors: string[] = []
  const bytes = new Uint8Array(await kiro.arrayBuffer())
  for (const msg of decoder.push(bytes)) {
    for (const d of translator.handle(msg)) {
      if (d.kind === "text") content += d.text
      else if (d.kind === "reasoning") reasoning += d.text
      else if (d.kind === "tool-start") calls[d.index] = { id: d.id, type: "function", function: { name: d.name, arguments: "" } }
      else if (d.kind === "tool-args") calls[d.index].function.arguments += d.args
      else if (d.kind === "error") errors.push(d.message)
    }
  }
  if (errors.length && !content && calls.length === 0) {
    return Response.json({ error: { message: errors.join("; "), type: "kiro_error" } }, { status: 502 })
  }
  return Response.json({
    id: `chatcmpl-kiro-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: translator.finishReason(),
      },
    ],
    usage: translator.usage(),
  })
}
