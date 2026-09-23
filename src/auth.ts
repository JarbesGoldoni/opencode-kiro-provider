import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { amzUserAgent, debug, httpUserAgent, kiroCliDbPath, serviceRegion } from "./env"

/**
 * Credentials come from kiro-cli's local SQLite store (`kiro-cli login`), so the
 * plugin never handles passwords and stays in sync with the official client.
 *
 * Keys in the `auth_kv` table (confirmed from the kiro-cli binary):
 *   kirocli:odic:token                IAM Identity Center (organization SSO)
 *   kirocli:odic:device-registration  OIDC client id/secret used to refresh the above
 *   kirocli:social:token              Builder ID / social login
 *   kirocli:external-idp:token        external IdP
 * The active profile ARN lives in `state` under `api.codewhisperer.profile`.
 */

export type AuthKind = "idc" | "social" | "external-idp"

export interface KiroCredentials {
  kind: AuthKind
  accessToken: string
  refreshToken?: string
  expiresAt: number
  /** Region of the OIDC / auth service that issued the token. */
  authRegion: string
  /** Region of the Kiro service, derived from the profile ARN. */
  region: string
  profileArn?: string
  clientId?: string
  clientSecret?: string
  /** Row key and original JSON, so refreshed tokens can be written back in the same shape. */
  key: string
  raw: Record<string, any>
}

const TOKEN_KEYS: Record<AuthKind, string> = {
  idc: "kirocli:odic:token",
  "external-idp": "kirocli:external-idp:token",
  social: "kirocli:social:token",
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000

function parseJson(value: unknown): any {
  if (typeof value !== "string") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function toMillis(value: unknown): number {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value)
    if (!Number.isNaN(t)) return t
    const n = Number(value)
    if (Number.isFinite(n)) return toMillis(n)
  }
  return 0
}

export function regionFromArn(arn: string | undefined): string | undefined {
  // arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC
  const region = arn?.split(":")[3]
  return region && /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region) ? region : undefined
}

function findClientCreds(node: any): { clientId?: string; clientSecret?: string } {
  if (!node || typeof node !== "object") return {}
  const clientId = node.client_id ?? node.clientId
  const clientSecret = node.client_secret ?? node.clientSecret
  if (typeof clientId === "string" && typeof clientSecret === "string") return { clientId, clientSecret }
  for (const v of Object.values(node)) {
    const found = findClientCreds(v)
    if (found.clientId) return found
  }
  return {}
}

function openDb(readonly: boolean): Database | undefined {
  const path = kiroCliDbPath()
  if (!existsSync(path)) return undefined
  const db = new Database(path, readonly ? { readonly: true } : { readwrite: true })
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}

export function kiroCliLoginExists(): boolean {
  try {
    return readCredentials() !== undefined
  } catch {
    return false
  }
}

/** Reads the preferred login from kiro-cli. KIRO_AUTH_KIND=idc|social|external-idp forces one. */
export function readCredentials(): KiroCredentials | undefined {
  const db = openDb(true)
  if (!db) return undefined
  try {
    const rows = db.query("SELECT key, value FROM auth_kv").all() as { key: string; value: string }[]
    const byKey = new Map(rows.map((r) => [r.key, r.value]))

    let profileArn: string | undefined
    try {
      const state = db.query("SELECT value FROM state WHERE key = ?").get("api.codewhisperer.profile") as
        | { value: string }
        | null
      const parsed = parseJson(state?.value)
      profileArn = parsed?.arn ?? parsed?.profileArn ?? parsed?.profile_arn
    } catch {}

    const forced = process.env.KIRO_AUTH_KIND as AuthKind | undefined
    const order: AuthKind[] = forced ? [forced] : ["idc", "external-idp", "social"]
    for (const kind of order) {
      const key = TOKEN_KEYS[kind]
      const data = parseJson(byKey.get(key))
      if (!data) continue
      const accessToken = data.access_token ?? data.accessToken
      if (!accessToken) continue

      let clientId: string | undefined
      let clientSecret: string | undefined
      if (kind === "idc") {
        const regKey = [...byKey.keys()].find((k) => k.includes("odic") && k.includes("device-registration"))
        ;({ clientId, clientSecret } = findClientCreds(parseJson(regKey ? byKey.get(regKey) : undefined)))
      }

      const arn = data.profile_arn ?? data.profileArn ?? profileArn
      const authRegion = data.region ?? "us-east-1"
      return {
        kind,
        accessToken,
        refreshToken: data.refresh_token ?? data.refreshToken,
        expiresAt: toMillis(data.expires_at ?? data.expiresAt) || Date.now() + 60 * 60 * 1000,
        authRegion,
        region: serviceRegion(regionFromArn(arn) ?? authRegion),
        profileArn: arn,
        clientId,
        clientSecret,
        key,
        raw: data,
      }
    }
    return undefined
  } finally {
    db.close()
  }
}

async function refreshIdc(c: KiroCredentials) {
  if (!c.clientId || !c.clientSecret || !c.refreshToken) throw new Error("missing OIDC client registration")
  const base = process.env.KIRO_OIDC_ENDPOINT || `https://oidc.${c.authRegion}.amazonaws.com`
  const res = await fetch(`${base}/token`, {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": httpUserAgent() },
    body: JSON.stringify({
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      grantType: "refresh_token",
      refreshToken: c.refreshToken,
    }),
  })
  if (!res.ok) throw new Error(`OIDC refresh failed: ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as { accessToken: string; refreshToken?: string; expiresIn?: number }
}

async function refreshSocial(c: KiroCredentials) {
  if (!c.refreshToken) throw new Error("missing refresh token")
  const base = process.env.KIRO_AUTH_ENDPOINT || `https://prod.${c.authRegion}.auth.desktop.kiro.dev`
  const res = await fetch(`${base}/refreshToken`, {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": httpUserAgent() },
    body: JSON.stringify({ refreshToken: c.refreshToken }),
  })
  if (!res.ok) throw new Error(`Kiro refresh failed: ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as { accessToken: string; refreshToken?: string; expiresIn?: number; profileArn?: string }
}

/** Writes refreshed tokens back so kiro-cli keeps working with rotated refresh tokens. */
function writeBack(c: KiroCredentials, accessToken: string, refreshToken: string | undefined, expiresAt: number) {
  const next = { ...c.raw }
  const set = (snake: string, camel: string, value: unknown) => {
    if (camel in next && !(snake in next)) next[camel] = value
    else next[snake] = value
  }
  set("access_token", "accessToken", accessToken)
  if (refreshToken) set("refresh_token", "refreshToken", refreshToken)
  const prev = c.raw.expires_at ?? c.raw.expiresAt
  const expires = typeof prev === "number" ? (prev < 10_000_000_000 ? Math.floor(expiresAt / 1000) : expiresAt) : new Date(expiresAt).toISOString()
  set("expires_at", "expiresAt", expires)

  const db = openDb(false)
  if (!db) return
  try {
    db.query("UPDATE auth_kv SET value = ? WHERE key = ?").run(JSON.stringify(next), c.key)
  } finally {
    db.close()
  }
}

/** Lets kiro-cli refresh its own token, then re-reads it. Used when a direct refresh fails. */
function refreshViaKiroCli(): KiroCredentials | undefined {
  const bin = process.env.KIRO_CLI_BIN || "kiro-cli"
  const r = spawnSync(bin, ["whoami", "--format", "json"], { timeout: 30_000, encoding: "utf-8" })
  debug("auth.kiro-cli-whoami", { status: r.status, error: r.error?.message })
  return readCredentials()
}

let cached: KiroCredentials | undefined
let inflight: Promise<KiroCredentials> | undefined

export function invalidateCredentials() {
  cached = undefined
}

/** Returns valid credentials, refreshing if they expire within 5 minutes. */
export async function getCredentials(force = false): Promise<KiroCredentials> {
  if (!force && cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached
  if (inflight) return inflight
  inflight = (async (): Promise<KiroCredentials> => {
    // kiro-cli may have refreshed on its own since we last looked.
    const current = readCredentials()
    if (!current) {
      throw new Error("No Kiro login found. Run `kiro-cli login` (for organization SSO, use your IAM Identity Center start URL), then restart OpenCode.")
    }
    if (!force && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return (cached = current)

    try {
      const out = current.kind === "idc" ? await refreshIdc(current) : await refreshSocial(current)
      const expiresAt = Date.now() + (out.expiresIn ?? 3600) * 1000
      try {
        writeBack(current, out.accessToken, out.refreshToken, expiresAt)
      } catch (e) {
        debug("auth.writeback-failed", { error: String(e) })
      }
      const profileArn = (out as { profileArn?: string }).profileArn || current.profileArn
      debug("auth.refreshed", { kind: current.kind, expiresAt })
      return (cached = {
        ...current,
        accessToken: out.accessToken,
        refreshToken: out.refreshToken ?? current.refreshToken,
        expiresAt,
        profileArn,
        region: serviceRegion(regionFromArn(profileArn) ?? current.region),
      })
    } catch (e) {
      debug("auth.refresh-failed", { kind: current.kind, error: String(e) })
      const viaCli = refreshViaKiroCli()
      // Only useful if kiro-cli actually produced a different token.
      if (viaCli && viaCli.accessToken !== current.accessToken && viaCli.expiresAt > Date.now()) return (cached = viaCli)
      throw new Error(`Kiro login expired and could not be refreshed. Run \`kiro-cli login\` again. (${e instanceof Error ? e.message : e})`)
    }
  })().finally(() => {
    inflight = undefined
  })
  return inflight
}

/**
 * Headers for every Kiro API call. Build Kiro requests only through this, so no call
 * site can miss a header Kiro checks (without a user-agent, Kiro answers chat calls with 403).
 */
export function kiroHeaders(c: KiroCredentials, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.accessToken}`,
    "user-agent": httpUserAgent(),
    "x-amz-user-agent": amzUserAgent(),
    "x-amzn-kiro-agent-mode": "vibe",
  }
  // The Kiro IDE tags IAM Identity Center tokens this way (TokenType middleware).
  if (c.kind === "idc") headers.TokenType = "SSO_OIDC"
  if (c.kind === "external-idp") headers.TokenType = "EXTERNAL_IDP"
  return { ...headers, ...extra }
}
