import { getCredentials, kiroHeaders, type KiroCredentials } from "./auth"
import { debug, legacyEndpoint, runtimeEndpoint } from "./env"
import { buildKiroRequest } from "./request"
import { toOpenAIJson, toOpenAIStream } from "./response"

const MAX_ATTEMPTS = 3

function openaiError(status: number, message: string) {
  return Response.json({ error: { message, type: "kiro_error", code: status } }, { status })
}

async function post(base: string, creds: KiroCredentials, body: unknown, attempt: number) {
  return fetch(`${base}/generateAssistantResponse`, {
    method: "POST",
    headers: kiroHeaders(creds, {
      "Content-Type": "application/json",
      Accept: "*/*",
      "amz-sdk-invocation-id": crypto.randomUUID(),
      "amz-sdk-request": `attempt=${attempt}; max=${MAX_ATTEMPTS}`,
    }),
    body: JSON.stringify(body),
  })
}

/**
 * The `fetch` handed to @ai-sdk/openai-compatible. It receives OpenAI
 * /chat/completions calls and answers them by calling Kiro.
 */
export async function kiroFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.endsWith("/chat/completions")) return openaiError(404, `opencode-kiro-provider: unsupported endpoint ${url}`)

  let openai: any
  try {
    openai = JSON.parse(typeof init?.body === "string" ? init.body : await new Response(init?.body).text())
  } catch {
    return openaiError(400, "opencode-kiro-provider: request body is not JSON")
  }

  let creds: KiroCredentials
  try {
    creds = await getCredentials()
  } catch (e) {
    return openaiError(401, e instanceof Error ? e.message : String(e))
  }

  const req = buildKiroRequest(openai, creds.profileArn)
  debug("request", {
    model: req.modelId,
    history: req.body.conversationState.history?.length ?? 0,
    tools: req.body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.length ?? 0,
    effort: req.body.additionalModelRequestFields,
    region: creds.region,
  })
  if (process.env.KIRO_DEBUG_BODY) debug("request.body", req.body)

  let base = runtimeEndpoint(creds.region)
  let refreshed = false
  let lastError = ""
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response
    try {
      res = await post(base, creds, req.body, attempt)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      debug("request.network-error", { base, error: lastError })
      // The runtime host is newer; fall back to the legacy CodeWhisperer host once.
      const legacy = legacyEndpoint(creds.region)
      if (base !== legacy) base = legacy
      continue
    }

    if (res.ok) {
      return req.stream ? toOpenAIStream(res, req.modelId, req.toolNames) : toOpenAIJson(res, req.modelId, req.toolNames)
    }

    const text = await res.text().catch(() => "")
    lastError = `${res.status} ${text.slice(0, 500)}`
    debug("request.http-error", { base, status: res.status, body: text.slice(0, 500) })

    // Refresh only when Kiro says the token itself is bad. Other 403s ("not authorized to make
    // this call", "subscription does not support this application") are not fixed by a new
    // token, and a needless refresh rotates the refresh token under kiro-cli.
    if (isExpiredToken(res.status, text) && !refreshed) {
      refreshed = true
      try {
        creds = await getCredentials(true)
        continue
      } catch (e) {
        return openaiError(401, e instanceof Error ? e.message : String(e))
      }
    }
    if (res.status === 404 && base !== legacyEndpoint(creds.region)) {
      base = legacyEndpoint(creds.region)
      continue
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)))
      continue
    }
    return openaiError(res.status, explainKiroError(res.status, text))
  }
  return openaiError(502, `Kiro request failed after ${MAX_ATTEMPTS} attempts: ${describe(lastError)}`)
}

/** True when Kiro rejected the token itself (expired, revoked, malformed), not the call. */
export function isExpiredToken(status: number, text: string): boolean {
  if (status === 401) return true
  if (status !== 403) return false
  return /expired|bearer token.*invalid|invalid.*(bearer|access) token|token.*(invalid|revoked)/i.test(describe(text))
}

const DEBUG_HINT = "Rerun with KIRO_DEBUG=1 and check ~/.cache/opencode-kiro-provider/debug.log."

/** Kiro's own message first, then a hint that matches it. */
export function explainKiroError(status: number, text: string): string {
  const message = describe(text)
  let hint = DEBUG_HINT
  if (isExpiredToken(status, text)) {
    hint = "Your Kiro login has expired or was revoked; run `kiro-cli login` and retry."
  } else if (status === 403 && /not authorized to make this call|subscription does not support this application/i.test(message)) {
    hint = `Kiro rejected this client or model, not your login. ${DEBUG_HINT} To test whether Kiro is rejecting this client, set KIRO_HTTP_USER_AGENT and retry.`
  } else if (status === 429) {
    hint = "Kiro is throttling requests or your quota is used up; wait and retry."
  }
  return `Kiro ${status}: ${message} ${hint}`
}

function describe(text: string): string {
  try {
    const j = JSON.parse(text)
    const msg = j.message ?? j.Message ?? j.error?.message
    const reason = j.reason ?? j.__type
    if (msg) return reason ? `${msg} (${reason})` : msg
  } catch {}
  return text || "no details"
}
