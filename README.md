# opencode-kiro-provider

Use **every model your [Kiro](https://kiro.dev) subscription offers** inside [OpenCode](https://opencode.ai): GPT‑5.6 Sol/Terra/Luna, Claude Opus 5, Sonnet 5, Haiku, the open-weight models, and Kiro's Auto router.

OpenCode stays in charge of the agent loop (its tools, permissions, agents and UI), and Kiro provides the models.

- **Always the current model list.** The plugin asks Kiro which models your account can use (`ListAvailableModels`, the same call the Kiro IDE makes). When Kiro adds a model, it shows up in OpenCode on its own, with no plugin update or config edit.
- **GPT and Claude, both done right.** OpenCode's reasoning variants (`--variant high`, or the variant picker) are sent the way each model family expects: `reasoning.effort` for GPT, `output_config.effort` for Claude. The allowed levels come from Kiro, per model.
- **Real limits and costs.** Each model gets its real context window from Kiro, and its credit multiplier appears in the model name, e.g. `Claude Opus 5 (2.2x)`.
- **Real token usage**, including cache reads, reported to OpenCode.
- **No extra login.** It reuses your `kiro-cli login`: IAM Identity Center (organization SSO), Builder ID, or an external IdP. Tokens are refreshed automatically.
- **Full agent support:** streaming, tool calls (including parallel ones), images and reasoning output.

> Unofficial project. It isn't affiliated with or endorsed by Amazon Web Services or Kiro. It calls the same Kiro service APIs as the official clients, using your own Kiro login, so your use is subject to your Kiro/AWS terms.

## Install

Requirements: OpenCode ≥ 1.14 and [kiro-cli](https://kiro.dev/cli).

1. Log in to Kiro once:
   ```bash
   kiro-cli login
   ```
2. Add the plugin to `~/.config/opencode/opencode.json`:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-kiro-provider"]
   }
   ```
   OpenCode installs it from npm on the next start. Remove any other Kiro plugin (such as `opencode-kiro-auth`) from the list, because both register the provider id `kiro`.
3. Start OpenCode and open `/models`. Kiro models appear as `kiro/<model-id>`, e.g. `kiro/gpt-5.6-sol` or `kiro/claude-opus-5`.

If no Kiro models show up on the very first start, restart OpenCode once, or run `opencode auth login` → **Kiro** → **Use my kiro-cli login**.

**Updating:** OpenCode installs the package once and reuses its cached copy. To upgrade, pin a version (`"opencode-kiro-provider@0.3.0"`), or delete the cached package under `~/.cache/opencode/packages/` and restart OpenCode. The model list doesn't depend on the plugin version, because it's fetched from Kiro.

> **Setting this up with an AI agent?** Point it at [INSTALL-AGENT.md](INSTALL-AGENT.md). It's a step-by-step guide with checks and stop points.

### From source

```bash
git clone https://github.com/JarbesGoldoni/opencode-kiro-provider.git
```

Then put the clone's absolute path in the `plugin` list instead of the package name, e.g. `"/home/you/opencode-kiro-provider"`. No build step is needed, because OpenCode runs the TypeScript directly.

## Usage

```bash
opencode run -m kiro/claude-opus-5 "explain this repo"
opencode run -m kiro/gpt-5.6-sol --variant high "refactor src/app.ts"
opencode models kiro          # everything your account can use
```

Model availability depends on your Kiro plan and region. Some models (for example GPT‑5.6) are only offered in some regions, and the plugin shows exactly what Kiro reports for your account.

## Check your account

From a clone, this lists your models and sends one short prompt to `gpt-5.6-sol` and `claude-opus-5`, which costs a few credits:

```bash
bun run smoke                      # default models
bun run smoke gpt-5.6-terra auto   # specific models
```

## Configuration

All environment variables are optional:

| Variable | Purpose |
|---|---|
| `KIRO_DEBUG=1` | Log requests and responses (never tokens) to `~/.cache/opencode-kiro-provider/debug.log` |
| `KIRO_DEBUG_BODY=1` | Also log full request bodies (these include your prompts) |
| `KIRO_REFRESH_MODELS=1` | Ignore the 6-hour model-list cache and refetch |
| `KIRO_AUTH_KIND` | Force a login type: `idc` (IAM Identity Center), `social` (Builder ID) or `external-idp` |
| `KIRO_HTTP_USER_AGENT` | Override the HTTP `user-agent` header |
| `KIRO_USER_AGENT` | Override the `x-amz-user-agent` header |
| `KIROCLI_DB_PATH` | Non-standard kiro-cli database location |

To change a model's settings, define it under `provider.kiro.models` in `opencode.json`. Your entry replaces the plugin's entry for that model id.

## Troubleshooting

Errors quote Kiro's own message, followed by a hint:

| Message | Meaning |
|---|---|
| `No Kiro login found` | Run `kiro-cli login`. |
| "…login has expired or was revoked" | Run `kiro-cli login` again. |
| "…rejected this client or model" | Your login is fine, but Kiro refused the call, usually because that model isn't enabled for your account or region. Rerun with `KIRO_DEBUG=1` and check the log. |
| Model list is missing a new model | `KIRO_REFRESH_MODELS=1 opencode models kiro` |

## How it works

```
OpenCode ──OpenAI chat format──▶ plugin fetch ──GenerateAssistantResponse──▶ runtime.<region>.kiro.dev
   ▲                                 │                                              │
   └────── OpenAI SSE chunks ◀───────┴────────── AWS event-stream ◀─────────────────┘
```

The provider registers as `@ai-sdk/openai-compatible` with a custom `fetch` that:

1. converts OpenAI messages to Kiro's `conversationState`: history alternates user/assistant turns, tool results are paired with their tool uses, and tool names and JSON schemas are normalized the way Kiro expects,
2. sends the request to `runtime.<region>.kiro.dev`, falling back to the legacy `q.<region>.amazonaws.com` host,
3. decodes Kiro's binary event stream (text, reasoning, tool calls, token usage) back into OpenAI stream chunks.

OpenCode gives GPT models its `apply_patch` tool instead of `edit`/`write`. That's OpenCode's own behavior, and it works through this plugin.

## Development

```bash
bun install
bun test           # unit tests
bun run typecheck
bun run e2e        # real opencode binary against a mock Kiro server
```

`bun run e2e` uses throwaway config folders and a fake kiro-cli login, so it never touches your real setup. The mock server enforces Kiro's history, tool-pairing and header rules.

Issues and pull requests are welcome.

## License

MIT
