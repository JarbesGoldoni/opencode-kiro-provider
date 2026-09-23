# Install guide for an AI agent

You are setting up **opencode-kiro-provider** as the Kiro model provider for this user's OpenCode. Work through the steps in order. Each step says how to check it worked. **Stop and ask the user** wherever this guide says so; don't guess around a failure.

- npm package: `opencode-kiro-provider`
- Source: `https://github.com/JarbesGoldoni/opencode-kiro-provider`

## Rules

- **Never type, paste or store the user's passwords, tokens or SSO codes.** The user does the Kiro login themselves (step 2).
- **Back up every file before you edit it** (step 3). Change only what this guide lists.
- Don't edit the plugin's source code to work around a failure. Report the failure to the user instead.

## 1. Check prerequisites

Run each of these and note the result:

```bash
opencode --version      # needs 1.14.0 or newer
kiro-cli --version      # the official Kiro CLI
```

- If `opencode` is missing or older than 1.14: **stop and ask the user** how they want it installed or upgraded.
- If `kiro-cli` is missing: install it with the official installer (`curl -fsSL https://cli.kiro.dev/install | bash` on macOS/Linux; see https://kiro.dev/downloads for Windows). If installs might be restricted on this machine, ask the user first.

## 2. Kiro login (the user does this)

Check whether kiro-cli is already logged in:

```bash
kiro-cli whoami
```

If it isn't, **ask the user to run `kiro-cli login` themselves**. Organization accounts pick IAM Identity Center and enter their start URL; personal accounts use Builder ID or social login. Wait until `kiro-cli whoami` succeeds before you continue.

## 3. Configure OpenCode

1. Find the global OpenCode config. It's `~/.config/opencode/opencode.json`, or `opencode.jsonc` in the same folder (on Windows, `%USERPROFILE%\.config\opencode\`). If neither exists, create `opencode.json` there with `{ "$schema": "https://opencode.ai/config.json" }`.
2. **Back it up** by copying it to `opencode.json.bak-<date>` in the same folder.
3. In the `plugin` array:
   - **Remove every other Kiro plugin.** They all register the provider id `kiro` and would conflict. Remove any entry containing `kiro-auth`, such as `opencode-kiro-auth` or any `@<scope>/opencode-kiro-auth`, along with any older entry for this plugin. Tell the user which entries you removed.
   - **Add `"opencode-kiro-provider"`.** Keep every other plugin entry unchanged.
4. If the config has a `provider.kiro` block left over from an older plugin (for example `"npm": "@ai-sdk/openai-compatible"` or a hand-written `models` list), **show it to the user and ask** before removing it. This plugin fills `provider.kiro` in automatically, and anything left under `provider.kiro.models` overrides the live model list for those model ids.

Example result (keep any other keys the file already has):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-kiro-provider"]
}
```

**If the user wants to run from a source clone instead of npm**, clone `https://github.com/JarbesGoldoni/opencode-kiro-provider.git` to a permanent folder and add its **absolute path** instead of the package name. On Windows, use forward slashes in the JSON, e.g. `"C:/Users/jane/opencode-kiro-provider"`.

## 4. Verify inside OpenCode

```bash
opencode models kiro
```

You should see `kiro/<model-id>` lines, such as `kiro/claude-opus-5` or `kiro/gpt-5.6-sol`. The exact list depends on the user's Kiro plan and region.

If the list is empty or `kiro` is missing, run the same command once more. On the very first start the plugin adds a `kiro` entry to OpenCode's `auth.json`. If it's still empty:
- run `opencode auth login`, choose **Kiro**, then choose **"Use my kiro-cli login"**,
- then check `opencode models kiro` again.

Then run one real request, which costs a few Kiro credits. Tell the user before you run it:

```bash
opencode run -m kiro/claude-opus-5 "Reply with the word ready"
```

It should print a reply. If GPT models are listed, try one with an effort level too: `opencode run -m kiro/gpt-5.6-sol --variant high "Reply with the word ready"`.

If a request fails, **stop and show the user the full output**.

## 5. Report to the user

Tell the user:
- which plugin entries you removed from and added to the OpenCode config, and where the backup is
- the model list from step 4
- how to update later: OpenCode installs the package once and reuses its cached copy. To upgrade, change the entry to a specific version (`"opencode-kiro-provider@<version>"`), or delete the cached package under `~/.cache/opencode/packages/`, then restart OpenCode.

## Troubleshooting

Turn on debug logging and reproduce the problem:

```bash
KIRO_DEBUG=1 opencode run -m kiro/claude-opus-5 "hi"
```

The log is `~/.cache/opencode-kiro-provider/debug.log`. It never contains tokens, but it shows which endpoint was called and the HTTP status.

| Symptom | Likely cause / fix |
|---|---|
| `No Kiro login found` | The user needs to run `kiro-cli login` (step 2). |
| `Kiro 401`/`403` … "login has expired or was revoked" | The user should run `kiro-cli login` again. |
| `Kiro 403` … "rejected this client or model" | The login is fine. If only one model fails, that model isn't enabled for this account or region. If every model fails, report it to the user along with `debug.log`. |
| Model list is old or missing a new model | Run `KIRO_REFRESH_MODELS=1 opencode models kiro` (the list is cached for 6 hours). |
| Two Kiro providers, or odd `kiro` behavior | Another Kiro plugin is still in the `plugin` array (step 3.3). |
| A Builder ID login is used but the organization SSO should be | Set `KIRO_AUTH_KIND=idc` in the environment. |

If none of these fix it, collect `debug.log` and the command output and hand them to the user.
