import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { kiroHeaders, type KiroCredentials } from "./auth"
import { cacheDir, debug, managementEndpoint, ORIGIN, runtimeEndpoint } from "./env"

/** One entry of ListAvailableModels, trimmed to what the plugin uses. */
export interface KiroModel {
  modelId: string
  modelName?: string
  description?: string
  rateMultiplier?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  supportedInputTypes?: string[]
  /** Where the effort goes in additionalModelRequestFields: `output_config` (Claude) or `reasoning` (GPT). */
  effortPath?: "output_config" | "reasoning"
  effortLevels?: string[]
  defaultEffort?: string
}

interface Catalog {
  fetchedAt: number
  region: string
  models: KiroModel[]
  defaultModel?: string
}

/**
 * Used only when the live list and the on-disk cache are both unavailable.
 * IDs are the ones the Kiro IDE/CLI send as `modelId`.
 */
const FALLBACK: KiroModel[] = [
  { modelId: "auto", modelName: "Auto" },
  { modelId: "claude-opus-5", modelName: "Claude Opus 5", maxInputTokens: 200_000, effortPath: "output_config", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { modelId: "claude-opus-4.8", modelName: "Claude Opus 4.8", maxInputTokens: 200_000, effortPath: "output_config", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { modelId: "claude-sonnet-5", modelName: "Claude Sonnet 5", maxInputTokens: 200_000, effortPath: "output_config", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { modelId: "claude-sonnet-4.6", modelName: "Claude Sonnet 4.6", maxInputTokens: 200_000 },
  { modelId: "claude-haiku-4.5", modelName: "Claude Haiku 4.5", maxInputTokens: 200_000 },
  { modelId: "gpt-5.6-sol", modelName: "GPT-5.6 Sol", maxInputTokens: 272_000, effortPath: "reasoning", effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
]

const CACHE_FILE = () => join(cacheDir(), "models.json")
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

function effortSchema(schema: unknown): Pick<KiroModel, "effortPath" | "effortLevels" | "defaultEffort"> {
  // Same probing as the Kiro IDE: look for an `effort` enum under output_config or reasoning.
  const s = typeof schema === "string" ? safeParse(schema) : schema
  for (const path of ["output_config", "reasoning"] as const) {
    const effort = (s as any)?.properties?.[path]?.properties?.effort
    if (Array.isArray(effort?.enum) && effort.enum.length > 0) {
      return { effortPath: path, effortLevels: effort.enum.map(String), defaultEffort: effort.default }
    }
  }
  return {}
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function parseModel(raw: any): KiroModel | undefined {
  if (!raw?.modelId) return undefined
  return {
    modelId: raw.modelId,
    modelName: raw.modelName,
    description: raw.description,
    rateMultiplier: typeof raw.rateMultiplier === "number" ? raw.rateMultiplier : undefined,
    maxInputTokens: raw.tokenLimits?.maxInputTokens,
    maxOutputTokens: raw.tokenLimits?.maxOutputTokens,
    supportedInputTypes: raw.supportedInputTypes,
    ...effortSchema(raw.additionalModelRequestFieldsSchema),
  }
}

async function listFrom(base: string, creds: KiroCredentials): Promise<{ models: KiroModel[]; defaultModel?: string }> {
  const models: KiroModel[] = []
  let defaultModel: string | undefined
  let nextToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const url = new URL("/ListAvailableModels", base)
    url.searchParams.set("origin", ORIGIN)
    if (creds.profileArn) url.searchParams.set("profileArn", creds.profileArn)
    if (nextToken) url.searchParams.set("nextToken", nextToken)
    const res = await fetch(url, {
      headers: kiroHeaders(creds, { Accept: "application/json" }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`ListAvailableModels ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`)
    const body = (await res.json()) as any
    for (const raw of body.models ?? []) {
      const m = parseModel(raw)
      if (m) models.push(m)
    }
    defaultModel ??= body.defaultModel?.modelId
    nextToken = body.nextToken
    if (!nextToken) break
  }
  return { models, defaultModel }
}

export async function fetchCatalog(creds: KiroCredentials): Promise<Catalog> {
  const errors: string[] = []
  // The IDE asks the management (control plane) host; the runtime host serves the same operation.
  for (const base of [managementEndpoint(creds.region), runtimeEndpoint(creds.region)]) {
    try {
      const { models, defaultModel } = await listFrom(base, creds)
      if (models.length === 0) throw new Error("empty model list")
      const catalog = { fetchedAt: Date.now(), region: creds.region, models, defaultModel }
      writeCache(catalog)
      debug("models.fetched", { base, count: models.length, ids: models.map((m) => m.modelId) })
      return catalog
    } catch (e) {
      errors.push(`${base}: ${e instanceof Error ? e.message : e}`)
    }
  }
  throw new Error(errors.join("; "))
}

function writeCache(catalog: Catalog) {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(CACHE_FILE(), JSON.stringify(catalog, null, 2))
  } catch {}
}

export function readCache(): Catalog | undefined {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE(), "utf-8")) as Catalog
    return Array.isArray(c.models) && c.models.length > 0 ? c : undefined
  } catch {
    return undefined
  }
}

let current: KiroModel[] = []

/** Loads the catalog: fresh cache, else live, else stale cache, else a built-in fallback. */
export async function loadCatalog(getCreds: () => Promise<KiroCredentials>): Promise<KiroModel[]> {
  const cache = readCache()
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS && !process.env.KIRO_REFRESH_MODELS) {
    return (current = cache.models)
  }
  try {
    return (current = (await fetchCatalog(await getCreds())).models)
  } catch (e) {
    debug("models.fetch-failed", { error: String(e) })
    return (current = cache?.models ?? FALLBACK)
  }
}

export function findModel(id: string): KiroModel | undefined {
  return current.find((m) => m.modelId === id) ?? FALLBACK.find((m) => m.modelId === id)
}

export function setCatalogForTest(models: KiroModel[]) {
  current = models
}

const DEFAULT_EFFORTS = ["low", "medium", "high"]

function displayName(m: KiroModel): string {
  const name = m.modelName || m.modelId
  return m.rateMultiplier !== undefined ? `${name} (${m.rateMultiplier}x)` : name
}

/** Converts the catalog to `provider.kiro.models` entries for opencode.json. */
export function toOpencodeModels(models: KiroModel[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const m of models) {
    const input = (m.supportedInputTypes ?? ["TEXT", "IMAGE"]).map((t) => t.toLowerCase())
    const image = input.includes("image")
    const levels = m.effortLevels ?? []
    const variants: Record<string, any> = {}
    // opencode adds low/medium/high for openai-compatible models; hide the ones Kiro rejects.
    for (const level of DEFAULT_EFFORTS) if (!levels.includes(level)) variants[level] = { disabled: true }
    for (const level of levels) variants[level] = { reasoningEffort: level }
    out[m.modelId] = {
      id: m.modelId,
      name: displayName(m),
      tool_call: true,
      reasoning: Boolean(m.effortLevels?.length),
      attachment: image,
      temperature: false,
      modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
      limit: {
        context: m.maxInputTokens ?? 200_000,
        output: m.maxOutputTokens ?? 32_000,
      },
      variants,
    }
  }
  return out
}
