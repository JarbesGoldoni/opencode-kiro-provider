import { createHash } from "node:crypto"
import { ORIGIN } from "./env"
import { findModel } from "./models"

/**
 * Translates an OpenAI Chat Completions body (what @ai-sdk/openai-compatible sends)
 * into a Kiro GenerateAssistantResponse body.
 *
 * Kiro's rules, learned from the Kiro IDE's own request builder:
 *  - history alternates userInputMessage / assistantResponseMessage and starts with a user turn
 *  - the last user turn is `currentMessage`; tool specs travel on it
 *  - tool results live in userInputMessageContext.toolResults and must match the
 *    toolUses of the assistant turn right before them
 *  - tool names: [a-zA-Z0-9_-], max 64 chars
 */

type Json = Record<string, any>

interface UserTurn {
  userInputMessage: {
    content: string
    modelId: string
    origin: string
    images?: { format: string; source: { bytes: string } }[]
    userInputMessageContext?: { toolResults?: ToolResult[]; tools?: ToolSpec[] }
  }
}
interface AssistantTurn {
  assistantResponseMessage: { content: string; toolUses?: ToolUse[] }
}
type Turn = UserTurn | AssistantTurn
interface ToolUse {
  toolUseId: string
  name: string
  input: Json
}
interface ToolResult {
  toolUseId: string
  content: { text: string }[]
  status: "success" | "error"
}
interface ToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Json } }
}

export interface KiroRequest {
  body: Json
  modelId: string
  /** Wire tool name -> name opencode knows. */
  toolNames: Map<string, string>
  stream: boolean
}

const TOOL_NAME_MAX = 64
const IMAGE_FORMATS = new Set(["png", "jpeg", "gif", "webp"])

export class ToolNames {
  readonly toWire = new Map<string, string>()
  readonly fromWire = new Map<string, string>()
  wire(name: string): string {
    const hit = this.toWire.get(name)
    if (hit) return hit
    let base = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, TOOL_NAME_MAX) || "tool"
    let candidate = base
    for (let i = 1; this.fromWire.has(candidate); i++) {
      const suffix = `_${i}`
      candidate = base.slice(0, TOOL_NAME_MAX - suffix.length) + suffix
    }
    this.toWire.set(name, candidate)
    this.fromWire.set(candidate, name)
    return candidate
  }
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  return content
    .map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : ""))
    .filter(Boolean)
    .join("\n")
}

function images(content: unknown): UserTurn["userInputMessage"]["images"] {
  if (!Array.isArray(content)) return undefined
  const out: NonNullable<UserTurn["userInputMessage"]["images"]> = []
  for (const p of content as any[]) {
    const url: string | undefined = p?.type === "image_url" ? p.image_url?.url ?? p.image_url : undefined
    const m = typeof url === "string" ? url.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/s) : null
    if (!m) continue
    const format = m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase()
    if (IMAGE_FORMATS.has(format)) out.push({ format, source: { bytes: m[2] } })
  }
  return out.length ? out : undefined
}

function parseArgs(args: unknown): Json {
  if (args && typeof args === "object") return args as Json
  if (typeof args !== "string" || !args.trim()) return {}
  try {
    const v = JSON.parse(args)
    return v && typeof v === "object" ? v : { value: v }
  } catch {
    return { raw: args }
  }
}

/** Mirrors the IDE's schema normalizer: drop keys Kiro rejects, keep a top-level object type. */
export function cleanSchema(schema: unknown): Json {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) return { type: "object", properties: {} }
  const hasRef = JSON.stringify(schema).includes('"$ref"')
  const drop = new Set(["title", "default", "examples", "$id", "$schema", ...(hasRef ? [] : ["$defs", "definitions"])])
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== "object") return node
    const out: Json = {}
    for (const [k, v] of Object.entries(node)) {
      if (drop.has(k)) continue
      // `properties` holds user-chosen names (a property may be called "title"), so only walk its values.
      out[k] = k === "properties" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)])) : walk(v)
    }
    return out
  }
  const out = walk(schema)
  if (!Array.isArray(out.required)) delete out.required
  out.type ??= "object"
  return out
}

function stableConversationId(system: string, firstUser: string): string {
  // Same conversation -> same id across turns, which lets Kiro associate the requests.
  const h = createHash("sha256").update(system.slice(0, 4000)).update("\0").update(firstUser.slice(0, 4000)).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const isUser = (t: Turn): t is UserTurn => "userInputMessage" in t

/** Maps the opencode effort (reasoning_effort) to the shape this Kiro model accepts. */
export function effortFields(modelId: string, requested: unknown): Json | undefined {
  if (typeof requested !== "string" || !requested || requested === "none") return undefined
  const model = findModel(modelId)
  const path = model?.effortPath ?? (modelId.startsWith("gpt-") ? "reasoning" : modelId.startsWith("claude-") ? "output_config" : undefined)
  if (!path) return undefined
  let level = requested
  const levels = model?.effortLevels
  if (levels?.length && !levels.includes(level)) {
    // e.g. opencode "max" on a model that tops out at "xhigh": use the highest supported level.
    const order = ["minimal", "low", "medium", "high", "xhigh", "max"]
    const want = order.indexOf(level)
    level = [...levels].sort((a, b) => order.indexOf(a) - order.indexOf(b)).filter((l) => order.indexOf(l) <= want).pop() ?? levels[0]
  }
  return { [path]: { effort: level } }
}

export function buildKiroRequest(openai: Json, profileArn: string | undefined): KiroRequest {
  const modelId: string = openai.model
  const names = new ToolNames()
  const messages: Json[] = Array.isArray(openai.messages) ? openai.messages : []

  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => text(m.content))
    .filter(Boolean)
    .join("\n\n")

  const user = (content: string, extra?: Partial<UserTurn["userInputMessage"]>): UserTurn => ({
    userInputMessage: { content, modelId, origin: ORIGIN, ...extra },
  })

  // 1. Convert and merge consecutive same-role messages.
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue
    const last = turns[turns.length - 1]
    if (m.role === "assistant") {
      const toolUses: ToolUse[] = (m.tool_calls ?? []).map((tc: any) => ({
        toolUseId: tc.id,
        name: names.wire(tc.function?.name ?? "tool"),
        input: parseArgs(tc.function?.arguments),
      }))
      const content = text(m.content)
      if (last && !isUser(last)) {
        const a = last.assistantResponseMessage
        a.content = [a.content, content].filter(Boolean).join("\n\n")
        if (toolUses.length) a.toolUses = [...(a.toolUses ?? []), ...toolUses]
      } else {
        turns.push({ assistantResponseMessage: { content, ...(toolUses.length ? { toolUses } : {}) } })
      }
      continue
    }
    // user or tool
    const content = m.role === "tool" ? "" : text(m.content)
    const results: ToolResult[] =
      m.role === "tool" ? [{ toolUseId: m.tool_call_id, content: [{ text: text(m.content) || "(no output)" }], status: "success" }] : []
    const imgs = m.role === "user" ? images(m.content) : undefined
    if (last && isUser(last)) {
      const u = last.userInputMessage
      u.content = [u.content, content].filter(Boolean).join("\n\n")
      if (imgs) u.images = [...(u.images ?? []), ...imgs]
      if (results.length) {
        u.userInputMessageContext ??= {}
        u.userInputMessageContext.toolResults = [...(u.userInputMessageContext.toolResults ?? []), ...results]
      }
    } else {
      turns.push(user(content, { ...(imgs ? { images: imgs } : {}), ...(results.length ? { userInputMessageContext: { toolResults: results } } : {}) }))
    }
  }

  // 2. Shape: start with a user turn, end with a user turn.
  if (turns.length === 0 || !isUser(turns[0])) turns.unshift(user("Continue."))
  if (!isUser(turns[turns.length - 1])) turns.push(user("Continue."))

  // 3. Pair tool results with the assistant turn right before them.
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    if (!isUser(t)) continue
    const prev = i > 0 ? turns[i - 1] : undefined
    const uses = prev && !isUser(prev) ? prev.assistantResponseMessage.toolUses ?? [] : []
    const ids = new Set(uses.map((u) => u.toolUseId))
    const results = t.userInputMessage.userInputMessageContext?.toolResults ?? []
    const kept: ToolResult[] = []
    const orphans: string[] = []
    const seen = new Set<string>()
    for (const r of results) {
      if (ids.has(r.toolUseId) && !seen.has(r.toolUseId)) {
        seen.add(r.toolUseId)
        kept.push(r)
      } else orphans.push(`[result of tool call ${r.toolUseId}]\n${r.content.map((c) => c.text).join("\n")}`)
    }
    // Every tool use needs a result, or Kiro rejects the history.
    for (const u of uses) {
      if (!seen.has(u.toolUseId)) kept.push({ toolUseId: u.toolUseId, content: [{ text: "Tool execution was interrupted." }], status: "error" })
    }
    if (orphans.length) t.userInputMessage.content = [t.userInputMessage.content, ...orphans].filter(Boolean).join("\n\n")
    if (kept.length) {
      t.userInputMessage.userInputMessageContext = { ...t.userInputMessage.userInputMessageContext, toolResults: kept }
    } else if (t.userInputMessage.userInputMessageContext) {
      delete t.userInputMessage.userInputMessageContext.toolResults
      if (Object.keys(t.userInputMessage.userInputMessageContext).length === 0) delete t.userInputMessage.userInputMessageContext
    }
  }

  // 4. Non-empty contents where Kiro requires them.
  for (const t of turns) {
    if (isUser(t)) {
      const hasResults = Boolean(t.userInputMessage.userInputMessageContext?.toolResults?.length)
      if (!t.userInputMessage.content.trim() && !hasResults) t.userInputMessage.content = "Continue."
    } else {
      const a = t.assistantResponseMessage
      if (!a.content.trim() && !a.toolUses?.length) a.content = "(no response)"
    }
  }

  // 5. System prompt goes in front of the first user turn (works on every Kiro backend version).
  const first = turns[0] as UserTurn
  const firstUserText = first.userInputMessage.content
  if (system) first.userInputMessage.content = first.userInputMessage.content ? `${system}\n\n${first.userInputMessage.content}` : system

  // 6. Tool specs on the current message, plus placeholders for tools only seen in history.
  const specs: ToolSpec[] = []
  const declared = new Set<string>()
  for (const tool of openai.tools ?? []) {
    const fn = tool?.function ?? tool
    if (!fn?.name) continue
    const name = names.wire(fn.name)
    if (declared.has(name)) continue
    declared.add(name)
    specs.push({
      toolSpecification: {
        name,
        description: (fn.description && String(fn.description).trim()) || fn.name,
        inputSchema: { json: cleanSchema(fn.parameters) },
      },
    })
  }
  for (const t of turns) {
    if (isUser(t)) continue
    for (const u of t.assistantResponseMessage.toolUses ?? []) {
      if (declared.has(u.name)) continue
      declared.add(u.name)
      specs.push({ toolSpecification: { name: u.name, description: u.name, inputSchema: { json: { type: "object", properties: {} } } } })
    }
  }

  const current = turns.pop() as UserTurn
  if (specs.length) {
    current.userInputMessage.userInputMessageContext = { ...current.userInputMessage.userInputMessageContext, tools: specs }
  }

  const effort = effortFields(modelId, openai.reasoning_effort ?? openai.reasoning?.effort)
  const body: Json = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: stableConversationId(system, firstUserText),
      currentMessage: current,
      ...(turns.length ? { history: turns } : {}),
    },
    ...(profileArn ? { profileArn } : {}),
    ...(effort ? { additionalModelRequestFields: effort } : {}),
  }
  return { body, modelId, toolNames: names.fromWire, stream: openai.stream !== false }
}
