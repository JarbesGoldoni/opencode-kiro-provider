import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { getCredentials, kiroCliLoginExists } from "./auth"
import { debug, opencodeAuthPath, PROVIDER_ID } from "./env"
import { kiroFetch } from "./fetch"
import { loadCatalog, toOpencodeModels } from "./models"

// Requests never reach this URL: kiroFetch answers them. The SDK just needs a base.
const BASE_URL = "https://kiro.invalid/v1"
const PLACEHOLDER_KEY = "kiro-cli"

/**
 * opencode only runs an auth loader (where the custom fetch is installed) for providers
 * with an entry in auth.json. When a kiro-cli login exists, add that entry so the
 * provider works without an extra `opencode auth login` step.
 */
function ensureAuthEntry() {
  if (!kiroCliLoginExists()) return
  const path = opencodeAuthPath()
  try {
    const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {}
    if (!data || typeof data !== "object" || Array.isArray(data) || data[PROVIDER_ID]) return
    data[PROVIDER_ID] = { type: "api", key: PLACEHOLDER_KEY }
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
    debug("plugin.auth-entry-created", { path })
  } catch (e) {
    debug("plugin.auth-entry-failed", { error: String(e) })
  }
}

export async function KiroPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    async config(config) {
      ensureAuthEntry()
      const models = toOpencodeModels(await loadCatalog(() => getCredentials()))
      config.provider ??= {}
      const user = (config.provider[PROVIDER_ID] ?? {}) as Record<string, any>
      config.provider[PROVIDER_ID] = {
        ...user,
        name: user.name ?? "Kiro",
        npm: "@ai-sdk/openai-compatible",
        api: BASE_URL,
        // User entries in opencode.json win over the live catalog, key by key.
        models: { ...models, ...(user.models ?? {}) },
      } as any
    },
    auth: {
      provider: PROVIDER_ID,
      async loader() {
        return { apiKey: PLACEHOLDER_KEY, baseURL: BASE_URL, fetch: kiroFetch }
      },
      methods: [
        {
          type: "api",
          label: "Use my kiro-cli login (run `kiro-cli login` first)",
          async authorize() {
            try {
              await getCredentials()
              return { type: "success", key: PLACEHOLDER_KEY }
            } catch (e) {
              debug("plugin.authorize-failed", { error: String(e) })
              return { type: "failed" }
            }
          },
        },
      ],
    },
  }
}
