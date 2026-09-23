/**
 * Live check against the real Kiro service, using your kiro-cli login.
 *
 *   bun run smoke                         list models, then ping gpt-5.6-sol and claude-opus-5
 *   bun run smoke gpt-5.6-terra auto      ping specific models
 *
 * Spends a few Kiro credits (one short prompt per model).
 */
import { getCredentials } from "../src/auth"
import { fetchCatalog } from "../src/models"
import { kiroFetch } from "../src/fetch"

const creds = await getCredentials()
console.log(`Login: ${creds.kind}, region ${creds.region}, profile ${creds.profileArn ?? "(none)"}`)
console.log(`Token expires: ${new Date(creds.expiresAt).toISOString()}\n`)

const catalog = await fetchCatalog(creds)
console.log(`ListAvailableModels: ${catalog.models.length} models (default: ${catalog.defaultModel ?? "?"})`)
for (const m of catalog.models) {
  const effort = m.effortLevels ? `${m.effortPath}.effort ${m.effortLevels.join("/")}` : "no effort control"
  console.log(`  ${m.modelId.padEnd(24)} ${String(m.maxInputTokens ?? "?").padStart(8)} ctx  ${String(m.rateMultiplier ?? "?").padStart(4)}x  ${effort}`)
}

const wanted = process.argv.slice(2)
const targets = wanted.length ? wanted : ["gpt-5.6-sol", "claude-opus-5"].filter((id) => catalog.models.some((m) => m.modelId === id))
for (const model of targets) {
  const started = Date.now()
  const res = await kiroFetch("https://kiro.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      reasoning_effort: "low",
      messages: [{ role: "user", content: "Reply with exactly: OK from <your model name>" }],
      tools: [{ type: "function", function: { name: "noop", description: "Does nothing. Never call it.", parameters: { type: "object", properties: {} } } }],
    }),
  })
  const body = (await res.json()) as any
  const ms = Date.now() - started
  if (!res.ok) console.log(`\n${model}: FAILED ${res.status} ${body.error?.message}`)
  else console.log(`\n${model}: ${JSON.stringify(body.choices[0].message.content)} (${ms} ms, usage ${JSON.stringify(body.usage)})`)
}
