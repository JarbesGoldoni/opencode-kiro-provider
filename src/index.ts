import type { PluginModule } from "@opencode-ai/plugin"
import { KiroPlugin } from "./plugin"

// opencode treats every export of the entry module as a plugin, so export only this.
export default {
  id: "kiro",
  server: KiroPlugin,
} satisfies PluginModule
