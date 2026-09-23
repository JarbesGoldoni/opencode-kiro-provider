/**
 * End-to-end check with the real opencode binary:
 *   opencode -> this plugin -> mock Kiro (enforces Kiro's history rules)
 *
 * Uses throwaway XDG dirs and a fake kiro-cli database, so it never touches your
 * real opencode config or Kiro login.  Run with: bun run e2e
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { startMock } from "./mock-kiro"

const PLUGIN = process.env.KIRO_E2E_PLUGIN || resolve(import.meta.dir, "../..")
const ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/E2ETEST"
const root = mkdtempSync(join(tmpdir(), "kiro-e2e-"))
const dirs = { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), state: join(root, "state"), project: join(root, "project") }
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

// Fake kiro-cli login (IAM Identity Center shape).
const dbPath = join(root, "kiro-cli.sqlite3")
const db = new Database(dbPath)
db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);")
db.query("INSERT INTO auth_kv VALUES (?, ?)").run(
  "kirocli:odic:token",
  JSON.stringify({ access_token: "e2e-access-token", refresh_token: "e2e-refresh", expires_at: new Date(Date.now() + 3600_000).toISOString(), region: "us-east-1", start_url: "https://example.awsapps.com/start" }),
)
db.query("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:odic:device-registration", JSON.stringify({ client_id: "cid", client_secret: "csecret", region: "us-east-1" }))
db.query("INSERT INTO state VALUES (?, ?)").run("api.codewhisperer.profile", JSON.stringify({ arn: ARN, profile_name: "e2e" }))
db.close()

mkdirSync(join(dirs.config, "opencode"), { recursive: true })
writeFileSync(join(dirs.config, "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(PLUGIN).href], autoupdate: false, share: "disabled" }, null, 2))

const mock = startMock()
const env = {
  ...process.env,
  XDG_CONFIG_HOME: dirs.config,
  XDG_DATA_HOME: dirs.data,
  XDG_CACHE_HOME: dirs.cache,
  XDG_STATE_HOME: dirs.state,
  KIROCLI_DB_PATH: dbPath,
  KIRO_RUNTIME_ENDPOINT: mock.url,
  KIRO_LEGACY_ENDPOINT: mock.url,
  KIRO_MANAGEMENT_ENDPOINT: mock.url,
  KIRO_OIDC_ENDPOINT: mock.url,
  KIRO_AUTH_ENDPOINT: mock.url,
  // Stand-in for kiro-cli, so the refresh fallback never touches a real login.
  KIRO_CLI_BIN: "/usr/bin/false",
  KIRO_DEBUG: "1",
  KIRO_LOG_FILE: join(root, "kiro-debug.log"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
}

async function opencode(args: string[]) {
  const proc = Bun.spawn(["opencode", ...args], { cwd: dirs.project, env: { ...env, PWD: dirs.project }, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 180_000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { stdout, stderr, code }
}

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  if (!ok) {
    failed++
    if (detail !== undefined) console.log("      ", typeof detail === "string" ? detail : JSON.stringify(detail, null, 2).slice(0, 2000))
  }
}

try {
  // 1. Models come from ListAvailableModels.
  const models = await opencode(["models", "kiro"])
  const listed = models.stdout.split("\n").map((l) => l.trim())
  check("opencode lists kiro/gpt-5.6-sol", listed.includes("kiro/gpt-5.6-sol"), models.stdout + models.stderr)
  check("opencode lists kiro/claude-opus-5", listed.includes("kiro/claude-opus-5"))
  const list = mock.recorded.find((r) => r.path === "/ListAvailableModels")
  check("ListAvailableModels sent origin + profileArn", list?.query.origin === "AI_EDITOR" && list?.query.profileArn === ARN, list?.query)
  check("IdC token tagged with TokenType: SSO_OIDC", list?.headers.tokentype === "SSO_OIDC", list?.headers)
  check("ListAvailableModels sends the plugin's user-agent", /opencode-kiro-provider\//.test(list?.headers["user-agent"] ?? ""), list?.headers["user-agent"])
  check("auth.json entry bootstrapped", existsSync(join(dirs.data, "opencode", "auth.json")) && JSON.parse(readFileSync(join(dirs.data, "opencode", "auth.json"), "utf-8")).kiro?.key === "kiro-cli")

  // 2. Real agent turns with a tool call: GPT (gets apply_patch) and Claude (gets write).
  const agentTurn = async (model: string, variant: string, effort: object) => {
    rmSync(join(dirs.project, "proof.txt"), { force: true })
    const before = mock.recorded.length
    const run = await opencode(["run", "-m", `kiro/${model}`, "--variant", variant, "--auto", "--format", "json", "Create proof.txt"])
    const calls = mock.recorded.slice(before).filter((r) => r.path === "/generateAssistantResponse")
    const bad = calls.filter((c) => c.problems.length)
    const toolNames = (c: any) => (c.body?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools ?? []).map((t: any) => t.toolSpecification.name)
    const agentCalls = calls.filter((c) => toolNames(c).some((n: string) => n === "write" || n === "apply_patch"))
    const first = agentCalls[0]?.body
    const followUp = agentCalls[1]?.body?.conversationState
    const results = followUp?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults
    check(`[${model}] opencode run exited 0`, run.code === 0, run.stderr.slice(-3000))
    check(`[${model}] every Kiro request passed history validation`, bad.length === 0, bad.map((b) => b.problems))
    check(`[${model}] tool call + follow-up reached Kiro`, agentCalls.length >= 2, calls.map((c) => toolNames(c)))
    check(`[${model}] chat requests send the plugin's user-agent`, calls.every((c) => /opencode-kiro-provider\//.test(c.headers["user-agent"] ?? "")), calls.map((c) => c.headers["user-agent"]))
    check(`[${model}] modelId sent`, first?.conversationState?.currentMessage?.userInputMessage?.modelId === model)
    check(`[${model}] effort sent as ${JSON.stringify(effort)}`, JSON.stringify(first?.additionalModelRequestFields) === JSON.stringify(effort), first?.additionalModelRequestFields)
    check(`[${model}] profileArn sent`, first?.profileArn === ARN)
    check(`[${model}] tool result paired with tooluse_1`, results?.[0]?.toolUseId === "tooluse_1" && results?.[0]?.status === "success", results)
    check(`[${model}] history replays the tool use`, followUp?.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId === "tooluse_1", followUp?.history)
    check(`[${model}] conversationId stable across the turn`, first?.conversationState?.conversationId === followUp?.conversationId)
    check(
      `[${model}] file tool actually ran in opencode`,
      existsSync(join(dirs.project, "proof.txt")) && readFileSync(join(dirs.project, "proof.txt"), "utf-8").includes("kiro mock"),
      run.stdout.split("\n").filter((l) => l.includes('"type":"tool')).join("\n") || results,
    )
    check(`[${model}] final answer reached opencode`, run.stdout.includes("Created proof.txt"), run.stdout.slice(-2000))
    check(`[${model}] token usage reported to opencode`, run.stdout.includes('"read":800'), run.stdout.slice(-800))
  }
  await agentTurn("gpt-5.6-sol", "high", { reasoning: { effort: "high" } })
  await agentTurn("claude-opus-5", "max", { output_config: { effort: "max" } })

  // 3. A refused call with a valid token: no token refresh, Kiro's message shown, no login hint.
  const storedToken = () => {
    const d = new Database(dbPath, { readonly: true })
    const row = d.query("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'").get() as { value: string }
    d.close()
    return row.value
  }
  const tokenBefore = storedToken()
  const beforeDenied = mock.recorded.length
  const refused = await opencode(["run", "-m", "kiro/denied-model", "--format", "json", "hello"])
  const refusedOut = refused.stdout + refused.stderr
  const refusedCalls = mock.recorded.slice(beforeDenied)
  check("refused call: no token refresh attempted", !refusedCalls.some((r) => r.path === "/token" || r.path === "/refreshToken"), refusedCalls.map((r) => r.path))
  check("refused call: stored kiro-cli token untouched", storedToken() === tokenBefore)
  check("refused call: error quotes Kiro's message", refusedOut.includes("User is not authorized to make this call."), refusedOut.slice(-1500))
  check("refused call: error does not blame the login", !refusedOut.includes("kiro-cli login") && refusedOut.includes("KIRO_DEBUG=1"), refusedOut.slice(-1500))

  // 4. A revoked login fails fast with an actionable message instead of hanging.
  const revoked = new Database(dbPath)
  revoked.query("UPDATE auth_kv SET value = ? WHERE key = ?").run(
    JSON.stringify({ access_token: "revoked-token", refresh_token: "r", expires_at: new Date(Date.now() + 3600_000).toISOString(), region: "us-east-1" }),
    "kirocli:odic:token",
  )
  revoked.close()
  const started = Date.now()
  const denied = await opencode(["run", "-m", "kiro/claude-opus-5", "--format", "json", "hello"])
  const seconds = (Date.now() - started) / 1000
  const output = denied.stdout + denied.stderr
  check("revoked login fails within 60s", seconds < 60, `${seconds}s`)
  check("revoked login tells the user to run kiro-cli login", output.includes("kiro-cli login"), output.slice(-1500))
} finally {
  mock.stop()
  if (failed) console.log(`\nKept ${root} for inspection (see kiro-debug.log).`)
  else rmSync(root, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll e2e checks passed")
process.exit(failed ? 1 : 0)
