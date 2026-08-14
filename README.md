<p align="center">
  <img src="docs/assets/banner.svg" alt="dsh-smarthome" width="820">
</p>

<p align="center">
  <b>Home Assistant control for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> agents.</b><br>
  Read entity states · query history · call services — every state-changing call sits behind a human approval gate.
</p>

<p align="center">
  <a href="README.zh.md">中文</a> ·
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-ecosystem-4d7cfe" alt="dsh-plugin"></a> ·
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a> ·
  <a href="https://github.com/YLifeOnlyOnce/dsh-smarthome/actions/workflows/ci.yml"><img src="https://github.com/YLifeOnlyOnce/dsh-smarthome/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">Zero runtime dependencies beyond the harness itself. Uses Home Assistant's built-in REST API — no MQTT, no WebSocket, no extra daemon.</p>

---

## ✨ What it looks like

Click any image to open the live demo — [`docs/demo.html`](docs/demo.html) simulates the full DSH conversation, and its live console talks to the bundled HA emulator (no real Home Assistant needed).

| ① Ask | ② Approval gate | ③ Done — state changed |
|---|---|---|
| <img src="docs/assets/demo-start.png" width="380" alt="start"> | <img src="docs/assets/demo-approval.png" width="380" alt="approval"> | <img src="docs/assets/demo-final.png" width="380" alt="final"> |
| The agent lists your lights with `ha_list_entities`. | `ha_call_service` pauses for a human approval dialog. | Approved — `ha_get_state` confirms the light turned on. |

## 🛠 Features

| Tool | Description | Approval |
|---|---|---|
| `ha_health` | Verify the connection; return instance name, version, timezone | read |
| `ha_list_entities` | List entities, filter by domain (`light`, `switch`, `sensor`…) and text | read |
| `ha_get_state` | Full state + attributes of one entity | read |
| `ha_history` | State-change timeline over a time window | read |
| `ha_call_service` | Call any service, e.g. `light.turn_on`, `climate.set_temperature` | **ask** |
| `ha_render_template` | Render a Jinja2 template server-side | **ask** |

Example prompts:

> "Check that Home Assistant is reachable, then list the lights in the living room."
>
> "Set the living room light to 60% brightness." *(triggers an approval request)*
>
> "Show me the boiler switch history for the last 24 hours."

## 📦 Install

Requires **dsh ≥ 0.1.0-rc.6** (current npm latest).

```sh
# From GitHub (source install — pnpm builds on the fly):
dsh plugin --profile web add github:YLifeOnlyOnce/dsh-smarthome

# If pnpm refuses to run the prepare build on a git dependency, allow it once:
#   add this to <profile>/pnpm-workspace.yaml, then re-run the add:
#     allowBuilds:
#       dsh-smarthome: true

# Or from npm once published:
# dsh plugin --profile web add dsh-smarthome
```

Restart `dsh --profile web` after installing. Manage it in **Settings → Plugins**.

## 🧪 Try it without Home Assistant (demo mode)

No HA instance? The repo ships a **fake HA emulator** with a small living demo home whose state *actually changes* when you call services — perfect for trying the plugin before wiring up real hardware.

```sh
git clone https://github.com/YLifeOnlyOnce/dsh-smarthome
cd dsh-smarthome
pnpm install
pnpm demo:ha          # serves a fake Home Assistant at http://127.0.0.1:8124
```

In another terminal, configure the plugin (add to your profile's `cordis.patch.yml`):

```yaml
- id: smarthome
  config:
    baseUrl: http://127.0.0.1:8124
    tokenEnv: HOME_ASSISTANT_TOKEN
```

Then start dsh and try:

```sh
HOME_ASSISTANT_TOKEN=demo-token dsh --profile web
```

> "Check that Home Assistant is reachable, then list the lights."
>
> "Turn on the bedroom light at 200 brightness." — an approval request pops up; approve it, and `ha_get_state` will show the light is actually `on` with `brightness: 200`.

The emulator also drifts the temperature sensor every few seconds, so `ha_history` always has fresh data. Any `Bearer` token works; `demo-token` is just the convention.

**Want to preview the UI without running dsh at all?** Open [`docs/demo.html`](docs/demo.html) in a browser: it replays a simulated DSH conversation (tool cards + the approval dialog), and its live console talks to the emulator directly when it's running.

Ready-to-paste configs (demo / real HA / no-approval) live in [`examples/cordis.patch.yml`](examples/cordis.patch.yml).

## ⚙️ Configuration

Create a long-lived access token in Home Assistant: **Profile → Security → Long-lived access tokens**.

Override the plugin row in your profile's `cordis.patch.yml` (later layers win):

```yaml
- id: smarthome
  config:
    baseUrl: http://192.168.1.10:8123   # your Home Assistant instance
    token: ''                           # prefer tokenEnv over committing a token
    tokenEnv: HOME_ASSISTANT_TOKEN      # env var holding the token
    timeoutMs: 15000
    requireApproval: true               # human approval for state-changing calls
    allowedDomains: []                  # e.g. ["light", "switch"]; empty = all domains
    maxHistoryEvents: 200
```

Then run dsh with the variable set:

```sh
HOME_ASSISTANT_TOKEN=<token> dsh --profile web
```

`baseUrl` defaults to `http://homeassistant.local:8123` (the standard Home Assistant mDNS host). If no token is configured the plugin still loads — every tool call fails with a clear "not configured" message instead of crashing the harness.

## 🔒 Security

- A Home Assistant token can control **everything** in your instance — there is no per-entity scope. That is why `requireApproval` defaults to `true` and `ha_call_service` / `ha_render_template` always route through the harness approval seam.
- `allowedDomains` is a second belt: when set, service calls on other domains are denied outright.
- Prefer `tokenEnv` over `token` so the secret never lands in a committed config file.

## 🛠 Development

```sh
pnpm install
pnpm typecheck   # strict TS against the published @deepseek-ai/* types
pnpm build       # bundle lib/ (ESM + d.ts)
pnpm test        # 18 tests: client suite + real ToolRuntime integration suite
node scripts/capture-demo.mjs   # regenerate the README screenshots
```

## 📋 Compatibility

DeepSeek Harness is in developer preview and changes fast. This plugin is verified against the published `@deepseek-ai/dsh@0.1.0-rc.6` line; if a harness update breaks it, please open an issue.

## 📄 License

MIT
