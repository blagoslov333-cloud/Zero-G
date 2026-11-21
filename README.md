# Zero-G (0G) — Zero-Weight Mobile Remote & Host Control

[![Zero-G CI](https://github.com/blagoslov333-cloud/Zero-G/actions/workflows/ci.yml/badge.svg)](https://github.com/blagoslov333-cloud/Zero-G/actions/workflows/ci.yml)

**Zero-G (0G)** is a local-first Windows bridge (`127.0.0.1:8790`) and mobile-first React PWA for controlling AI coding agents from your phone while your laptop stays in your backpack. It supports **Antigravity (Priority #1)** natively alongside **Claude Code**, **OpenAI Codex CLI**, and **xAI Grok Build**, with zero cloud lock-in, always-on two-way WebSocket state sync, adaptive Windows power governance, and live **Phone-Authored MCP Tools**.

---

## Architecture

```text
+-----------------------+       HTTPS / WSS       +----------------------------------+
|   Paired Phone PWA    | <=====================> |  Cloudflare Tunnel / Tailscale   |
|  - Approvals (25s)    |    Two-Way /ws/stream   +----------------------------------+
|  - Offline Outbox     |                                         |
|  - Phone Tool Studio  |                                         v
|  - Host & PTY Vitals  |                         +----------------------------------+
+-----------------------+                         |  0G Bridge Daemon (127.0.0.1)    |
                                                  |  - FastAPI + SQLite WAL + Audit  |
+-----------------------+   JSON-RPC 2.0 Stdio    |  - EgressRedactor & RulesEngine  |
|  IDE / CLI Agents     | <=====================> |  - BackpackPowerGovernor (Win32) |
|  - Antigravity (#1)   |    server/mcp_server.py |  - JobObjectPtyMux & GitManager  |
|  - Claude Code        |                         +----------------------------------+
|  - OpenAI Codex CLI   |                                         ^
|  - xAI Grok Build     |         hooks/shim.py (python -I -S)    |
+-----------------------+ ----------------------------------------+
```

---

## Quickstart

### 1. Install Python & Frontend Dependencies

```powershell
python -m pip install -e ".[dev]"
npm --prefix web install
npm --prefix web run build
```

### 2. Start the 0G Daemon

```powershell
python -m server.app
# or via script entrypoint:
zerog
```

The daemon binds strictly to `127.0.0.1:8790` and serves both the Mobile PWA (`/`) and the Desktop Aux Pane (`/?view=auxpane`). Re-running `python -m server.app` when port `8790` is already running prints status cleanly instead of raising `[WinError 10048]`.

### 3. Pair Your Phone via Hotspot-Safe Tunnel

- **Cloudflare Tunnel (Primary):** Works outbound over mobile hotspots / CGNAT with zero port forwarding (`cloudflared tunnel --url http://127.0.0.1:8790`). Install via `winget install Cloudflare.cloudflared`.
- **Tailscale Serve (Secondary):** Private tailnet HTTPS/WSS (`tailscale serve`).
- Open the **Desktop Aux Pane** (`http://127.0.0.1:8790/?view=auxpane`) or the Antigravity sidecar (`plugin/0g`) and scan the QR code or enter the 6-digit pairing code on your phone.

---

## Multi-Provider Hook Setup

Fetch ready-to-paste hook configs anytime from `GET /api/adapters/hook-configs` or the **Host** tab in the PWA:

| Provider | Priority | Config File | Worker Runner |
| :--- | :--- | :--- | :--- |
| **Antigravity** | **#1 (Native)** | `~/.gemini/antigravity/hooks.json` or `plugin/0g/` | `google.antigravity` SDK / `agy` CLI / async fallback |
| **Claude Code** | Supported | `~/.claude/settings.json` | `claude -p --output-format stream-json` |
| **OpenAI Codex CLI** | Supported | `~/.codex/hooks.json` | `codex exec --json` |
| **xAI Grok Build** | Supported | `~/.grok/hooks.json` | `grok -p` + MCP |

---

## Key Capabilities

### Agent Gate Mode vs. Laptop Hardware Power
`Agent Gate Mode` (`ask_on_phone` vs `agent_turbo`) is independent from the 5 laptop power gears (`ultra_sip`, `auto_turbo`, `balanced`, `max_turbo`, `low_battery_guard`):
- **Agent Gate Mode**: Controls hook execution permissions. In `ask_on_phone` mode, tool use is held in a 25-second queue awaiting phone approval. In `agent_turbo` mode, Tier 0–2 actions are auto-approved while Tier 3 destructive operations and secrets remain strictly blocked.
- **Laptop Hardware Power Gears**: Controls host physical power management (CPU throttling, OS power schemes, and display state). Clicking `ultra_sip` locks `manualGear` (`autoGovernorEnabled=False`) to enforce maximum battery conservation regardless of running agent tasks, remaining locked until `auto_turbo` is selected to re-enable autonomous dynamic scaling.

### Adaptive Backpack Power Governor (`server/power_governor.py`)
- **`ultra_sip`**: When idle on battery/backpack (`autoGovernorEnabled=True`), drops Windows to the Best Power Efficiency overlay (`PowerSetActiveOverlayScheme`) and processor throttling while keeping `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` active only as needed so your hotspot tunnel never drops.
- **`auto_turbo`**: Immediately restores full Balanced/High Performance CPU boost the instant a desktop hook or Mode-B worker begins executing.
- **PANIC Host Lock**: One tap from the header sets `HOST_LOCKED`, denies/terminates active hooks, terminates `JobObjectPtyMux` PowerShell children via Win32 `TerminateJobObject`, and optionally calls `LockWorkStation()`.

### Phone-Authored MCP Tools (`server/mobile_tools.py` & `server/mcp_server.py`)
- Built-in phone capabilities exposed immediately over Stdio JSON-RPC 2.0 (`0g_mobile`):
  - `phone_notify_card`
  - `phone_ask_input`
  - `phone_read_clipboard`
  - `phone_capture_photo`
  - `phone_get_location`
  - `phone_speak_tts`
- Author custom `phone_js` or `host_command` tools directly inside the phone **Tools** tab — `tools/list` queries the live daemon on every agent turn so new tools appear without restarting your agent.

### Security & Tamper-Evident Audit
- **`EgressRedactor`**: Strips ANSI escapes & Unicode BiDi overrides and masks API keys (`sk-`, `AIza`, `ghp_`, `xai-`, `AKIA`, Bearer tokens, PEM blocks, `.env` secrets) before streaming to your phone.
- **`RulesEngine`**: Enforces Tier-3 hard-deny self-protection on `hooks.json`, `plugin/0g`, `.env`, `~/.gemini/config/config.json`, `bridge.token`, and private key files.
- **Hash-Chained Audit Log**: Every rule evaluation, approval, pairing, and panic event is appended to a SHA-256 hash-chained `audit_log` table (`verify_audit_chain()`).

---

## Design & Theming (`DESIGN.md`)

100% of visual styling is tokenized as color-agnostic semantic CSS variable slots in [tokens.dtcg.json](tokens.dtcg.json) and [web/src/styles/theme.css](web/src/styles/theme.css) following [DESIGN.md](DESIGN.md), ready for custom design skinning:
- `obsidian` (Default structural baseline preset)
- `outdoor` (Daylight high-contrast mobile preset)
- `wireframe` (Neutral structural studio grid for design reskinning)

---

## Documentation

- **[PRODUCT.md](PRODUCT.md)** — Product context, target audience, surface modes (`Operate` vs `Persuade`), core user flows, and platform constraints.
- **[DESIGN.md](DESIGN.md)** — Design handoff specification, color-agnostic semantic CSS variable slots, DTCG tokens, and mobile layout specifications.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — Architecture breakdown, local development checks, and security rules.
