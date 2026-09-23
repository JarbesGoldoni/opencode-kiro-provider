import { appendFileSync, mkdirSync } from "node:fs"
import { homedir, platform, release } from "node:os"
import { dirname, join } from "node:path"

export const PROVIDER_ID = "kiro"
export const ORIGIN = "AI_EDITOR"
export const DEFAULT_REGION = "us-east-1"

// Regions Kiro's runtime/management services are deployed in (from the Kiro IDE bundle).
const KIRO_REGIONS = new Set(["us-east-1", "eu-central-1", "us-gov-east-1", "us-gov-west-1"])

export function serviceRegion(region: string | undefined): string {
  return region && KIRO_REGIONS.has(region) ? region : DEFAULT_REGION
}

/** Chat endpoint (Kiro Runtime Service). Override with KIRO_RUNTIME_ENDPOINT. */
export function runtimeEndpoint(region: string): string {
  return process.env.KIRO_RUNTIME_ENDPOINT || `https://runtime.${region}.kiro.dev`
}

/** Legacy CodeWhisperer endpoint, used as a fallback when the runtime host is unreachable. */
export function legacyEndpoint(region: string): string {
  return process.env.KIRO_LEGACY_ENDPOINT || `https://q.${region}.amazonaws.com`
}

/** Control plane (ListAvailableModels). Override with KIRO_MANAGEMENT_ENDPOINT. */
export function managementEndpoint(region: string): string {
  return process.env.KIRO_MANAGEMENT_ENDPOINT || `https://management.${region}.kiro.dev`
}

export const VERSION = "0.2.0"

/**
 * HTTP `user-agent` for every Kiro call. Kiro rejects Bun's default (`Bun/x.y.z`) with 403
 * ("User is not authorized to make this call" / "Your subscription does not support this
 * application") but accepts any explicit value, so always send one. It uses the AWS SDK's
 * format and names this plugin truthfully.
 * Override with KIRO_HTTP_USER_AGENT.
 */
export function httpUserAgent(): string {
  if (process.env.KIRO_HTTP_USER_AGENT) return process.env.KIRO_HTTP_USER_AGENT
  const p = platform()
  const os = p === "win32" ? `windows#${release()}` : p === "darwin" ? `macos#${release()}` : `${p}#${release()}`
  const runtime = process.versions.bun ? `bun#${process.versions.bun}` : `nodejs#${process.versions.node}`
  return `aws-sdk-js/3.738.0 ua/2.1 os/${os} lang/js md/${runtime} api/codewhispererstreaming#3.738.0 m/E opencode-kiro-provider/${VERSION}`
}

/** `x-amz-user-agent`, the AWS SDK's second client header. Override with KIRO_USER_AGENT. */
export function amzUserAgent(): string {
  return process.env.KIRO_USER_AGENT || `aws-sdk-js/3.738.0 opencode-kiro-provider/${VERSION}`
}

export function kiroCliDbPath(): string {
  if (process.env.KIROCLI_DB_PATH) return process.env.KIROCLI_DB_PATH
  const p = platform()
  if (p === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3")
  }
  if (p === "darwin") return join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3")
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kiro-cli", "data.sqlite3")
}

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(base, "opencode-kiro-provider")
}

export function opencodeAuthPath(): string {
  const base =
    platform() === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode", "auth.json")
}

const LOG_FILE = process.env.KIRO_DEBUG ? process.env.KIRO_LOG_FILE || join(cacheDir(), "debug.log") : undefined

/** Debug logging, enabled with KIRO_DEBUG=1. Never logs tokens. */
export function debug(message: string, data?: unknown) {
  if (!LOG_FILE) return
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    const line = `${new Date().toISOString()} ${message}${data === undefined ? "" : " " + JSON.stringify(data)}\n`
    appendFileSync(LOG_FILE, line)
  } catch {}
}
