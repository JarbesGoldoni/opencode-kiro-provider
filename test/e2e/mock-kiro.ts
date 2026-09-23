import { encodeMessage } from "../../src/eventstream"

/**
 * A stand-in for Kiro's runtime + management services. It enforces the same
 * history rules the real backend does, so structural mistakes fail loudly.
 */

export interface Recorded {
  path: string
  headers: Record<string, string>
  query: Record<string, string>
  body?: any
  problems: string[]
}

const ev = (type: string, data: unknown) =>
  encodeMessage({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, JSON.stringify(data))

export const MODELS = {
  models: [
    {
      modelId: "gpt-5.6-sol",
      modelName: "GPT-5.6 Sol",
      rateMultiplier: 4.4,
      tokenLimits: { maxInputTokens: 272000, maxOutputTokens: 128000 },
      supportedInputTypes: ["TEXT", "IMAGE"],
      additionalModelRequestFieldsSchema: {
        type: "object",
        properties: { reasoning: { type: "object", properties: { effort: { type: "string", enum: ["low", "medium", "high", "xhigh"], default: "medium" } } } },
      },
    },
    {
      modelId: "claude-opus-5",
      modelName: "Claude Opus 5",
      rateMultiplier: 2.2,
      tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 },
      supportedInputTypes: ["TEXT", "IMAGE"],
      additionalModelRequestFieldsSchema: {
        type: "object",
        properties: { output_config: { type: "object", properties: { effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], default: "high" } } } },
      },
    },
    { modelId: "claude-haiku-4.5", modelName: "Claude Haiku 4.5", rateMultiplier: 0.4, tokenLimits: { maxInputTokens: 200000 } },
    // Listed, but chat calls get the "valid token, call refused" 403.
    { modelId: "denied-model", modelName: "Denied Model", rateMultiplier: 1, tokenLimits: { maxInputTokens: 200000 } },
  ],
  defaultModel: { modelId: "auto" },
}

export function validate(body: any): string[] {
  const p: string[] = []
  const cs = body?.conversationState
  if (!cs) return ["missing conversationState"]
  if (!cs.conversationId) p.push("missing conversationId")
  const cur = cs.currentMessage?.userInputMessage
  if (!cur) return [...p, "currentMessage must be a userInputMessage"]
  if (!cur.modelId) p.push("currentMessage.modelId missing")
  const turns = [...(cs.history ?? []), cs.currentMessage]
  turns.forEach((t: any, i: number) => {
    const wantUser = i % 2 === 0
    if (wantUser !== Boolean(t.userInputMessage)) p.push(`turn ${i}: expected ${wantUser ? "user" : "assistant"}`)
    const u = t.userInputMessage
    if (u) {
      const results = u.userInputMessageContext?.toolResults ?? []
      if (!u.content && results.length === 0) p.push(`turn ${i}: empty user content`)
      const prevUses = i > 0 ? turns[i - 1].assistantResponseMessage?.toolUses ?? [] : []
      const want = new Set(prevUses.map((x: any) => x.toolUseId))
      const got = new Set(results.map((r: any) => r.toolUseId))
      for (const id of want) if (!got.has(id)) p.push(`turn ${i}: missing result for ${id}`)
      for (const id of got) if (!want.has(id)) p.push(`turn ${i}: result without tool use ${id}`)
    }
    const a = t.assistantResponseMessage
    if (a && !a.content && !a.toolUses?.length) p.push(`turn ${i}: empty assistant`)
  })
  const declared = new Set((cur.userInputMessageContext?.tools ?? []).map((t: any) => t.toolSpecification?.name))
  for (const t of cs.history ?? []) {
    for (const u of t.assistantResponseMessage?.toolUses ?? []) if (!declared.has(u.name)) p.push(`tool ${u.name} used in history but not declared`)
  }
  for (const t of cur.userInputMessageContext?.tools ?? []) {
    const n = t.toolSpecification?.name ?? ""
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(n)) p.push(`bad tool name ${n}`)
  }
  return p
}

/** Decides the reply: ask for the `write` tool once, then finish with text. */
function reply(body: any): Uint8Array[] {
  const cur = body.conversationState.currentMessage.userInputMessage
  const tools: string[] = (cur.userInputMessageContext?.tools ?? []).map((t: any) => t.toolSpecification.name)
  const results = cur.userInputMessageContext?.toolResults ?? []
  const usage = ev("metadataEvent", { tokenUsage: { uncachedInputTokens: 1200, cacheReadInputTokens: 800, outputTokens: 42 } })
  if (results.length) {
    return [ev("assistantResponseEvent", { content: "Created proof.txt as requested." }), usage]
  }
  // opencode offers `write` to Claude models and `apply_patch` to GPT models.
  const call = tools.includes("write")
    ? { name: "write", input: JSON.stringify({ filePath: "proof.txt", content: "written by kiro mock\n" }) }
    : tools.includes("apply_patch")
      ? { name: "apply_patch", input: JSON.stringify({ patchText: "*** Begin Patch\n*** Add File: proof.txt\n+written by kiro mock\n*** End Patch" }) }
      : undefined
  if (call) {
    return [
      ev("reasoningContentEvent", { text: "I should write the file." }),
      ev("assistantResponseEvent", { content: "Writing the file now." }),
      ev("toolUseEvent", { toolUseId: "tooluse_1", name: call.name, input: call.input.slice(0, 20) }),
      ev("toolUseEvent", { toolUseId: "tooluse_1", name: call.name, input: call.input.slice(20) }),
      ev("toolUseEvent", { toolUseId: "tooluse_1", name: call.name, stop: true }),
      usage,
    ]
  }
  return [ev("assistantResponseEvent", { content: "Kiro e2e session" }), usage]
}

export function startMock() {
  const recorded: Recorded[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const rec: Recorded = {
        path: url.pathname,
        headers: Object.fromEntries(req.headers),
        query: Object.fromEntries(url.searchParams),
        problems: [],
      }
      recorded.push(rec)
      // Token refresh endpoints (OIDC /token, Kiro /refreshToken): the fake refresh token is rejected.
      if (url.pathname === "/token" || url.pathname === "/refreshToken") {
        return Response.json({ error: "invalid_grant", error_description: "Invalid refresh token" }, { status: 400 })
      }
      if (req.headers.get("authorization") !== "Bearer e2e-access-token") {
        rec.problems.push("bad authorization")
        return Response.json({ message: "The bearer token included in the request is invalid." }, { status: 403 })
      }
      if (url.pathname === "/ListAvailableModels" && req.method === "GET") return Response.json(MODELS)
      if (url.pathname === "/generateAssistantResponse" && req.method === "POST") {
        rec.body = await req.json()
        // Real Kiro answers a missing or default Bun user-agent with this 403.
        const ua = req.headers.get("user-agent") ?? ""
        const model = rec.body?.conversationState?.currentMessage?.userInputMessage?.modelId
        if (!ua || ua.startsWith("Bun/") || model === "denied-model") {
          if (!ua || ua.startsWith("Bun/")) rec.problems.push(`rejected user-agent: ${ua || "(none)"}`)
          return Response.json({ message: "User is not authorized to make this call." }, { status: 403 })
        }
        rec.problems = validate(rec.body)
        if (rec.problems.length) return Response.json({ message: rec.problems.join("; "), reason: "INVALID_INPUT" }, { status: 400 })
        const frames = reply(rec.body)
        return new Response(
          new ReadableStream({
            start(c) {
              for (const f of frames) c.enqueue(f)
              c.close()
            },
          }),
          { headers: { "Content-Type": "application/vnd.amazon.eventstream" } },
        )
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, recorded, stop: () => server.stop(true) }
}
