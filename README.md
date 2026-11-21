# Zero-G (0G) — Zero-Weight Mobile Remote & Host Control

[![Zero-G CI](https://github.com/blagoslov333-cloud/Zero-G/actions/workflows/ci.yml/badge.svg)](https://github.com/blagoslov333-cloud/Zero-G/actions/workflows/ci.yml)

**Zero-G (0G)** is a local-first Windows bridge (`127.0.0.1:8790`) and mobile-first React PWA serving as a 4-tab mobile remote and Desktop IDE companion for autonomous AI coding agents. It provides native first-class integration for **Antigravity (Priority #1)** via real-time SQLite WAL streaming (`conversation_summaries.db`), transcript ingestion (`transcript.jsonl`), and prompt injection (`agentapi.bat`), alongside multi-provider hook support for **Claude Code**, **OpenAI Codex CLI**, and **xAI Grok Build**, with zero cloud lock-in, always-on two-way WebSocket state sync, adaptive Windows power governance, and a global inline permission banner.

---

## Architecture

```text
+---------------------------------------+       HTTPS / WSS       +----------------------------------+
|           Paired Phone PWA            | <=====================> |  Cloudflare Tunnel / Tailscale   |
|  - 4 Tabs: Chat, Projects,            |    Two-Way /ws/stream   +----------------------------------+
|    Terminal, Laptop                   |                                         |
|  - Global Inline Permission Banner    |                                         v
|  - Real-Time Antigravity Stream       |                         +----------------------------------+
|  - Workspace IDE & Code Viewer        |                         |  0G Bridge Daemon (127.0.0.1)    |
|  - Remote Terminal & Power Governor   |                         |  - FastAPI + SQLite WAL + Audit  |
+---------------------------------------+                         |  - AntigravityDesktopBridge      |
                                                                  |  - EgressRedactor & RulesEngine  |
+---------------------------------------+   Read-only DB / CLI    |  - BackpackPowerGovernor (Win32) |
|      Antigravity Desktop & SDK        | <=====================> |  - JobObjectPtyMux & GitManager  |
|  - conversation_summaries.db (WAL)    |   transcript.jsonl /    +----------------------------------+
|  - ~/.gemini/antigravity/brain/       |   agentapi.bat / stdio                  ^
|  - Multi-Provider Hooks Support       |                                         |
|    (Claude Code, Codex, Grok)         |         hooks/shim.py (python -I -S)    |
+---------------------------------------+ ----------------------------------------+
```

---

## Quickstart

### 1. Install Python & Frontend Dependencies

```powershell
python -m pip install -e ".[dev]"
npm --prefix web install
npm --prefix web run build
```

### 2. Start the 0G Daemon (Auto-Starts Outbound Phone Tunnel)

```powershell
python -m server.app
# or via script entrypoint:
zerog
```

The local server binds strictly to `127.0.0.1:8790` on your laptop (never open `127.0.0.1:8790` directly on your phone — `127.0.0.1` is laptop-only). When `cloudflared` is installed, `python -m server.app` automatically opens an **outbound** Cloudflare Tunnel over your phone's hotspot internet and prints the **Phone Public HTTPS Link** (`https://*.trycloudflare.com/?pair=...`) right in PowerShell, monitoring DNS health and auto-restarting the tunnel if a temporary link drops. Re-running `python -m server.app` when port `8790` is already running prints the active local and phone URLs cleanly instead of raising `[WinError 10048]`.

### 3. Pair & Open on Your Phone Over Hotspot

- **Cloudflare Tunnel (Primary):** Works outbound over mobile hotspots / CGNAT with zero port forwarding and zero extra phone apps (`cloudflared tunnel --url http://127.0.0.1:8790`). Install once on your laptop via `winget install Cloudflare.cloudflared` if missing.
- **Tailscale Serve (Secondary):** Private tailnet HTTPS/WSS (`tailscale serve`).
- Open the printed **`https://*.trycloudflare.com/?pair=...`** link directly on your phone, or scan the QR code from the **Desktop Aux Pane** (`http://127.0.0.1:8790/?view=auxpane`), then tap **Add to Home Screen** in your mobile browser.

---

## Multi-Provider Hook Setup

Fetch ready-to-paste hook configs anytime from `GET /api/adapters/hook-configs` or the **Laptop** tab in the PWA:

| Provider | Priority | Config File | Worker Runner |
| :--- | :--- | :--- | :--- |
| **Antigravity** | **#1 (Native)** | `~/.gemini/antigravity/hooks.json` or `plugin/0g/` | `google.antigravity` SDK / `agy` CLI / async fallback |
| **Claude Code** | Supported | `~/.claude/settings.json` | `claude -p --output-format stream-json` |
| **OpenAI Codex CLI** | Supported | `~/.codex/hooks.json` | `codex exec --json` |
| **xAI Grok Build** | Supported | `~/.grok/hooks.json` | `grok -p` + MCP |

---

## Key Capabilities

### Antigravity Desktop Bridge & 4-Tab Mobile Workspace UI
- **Tab 1 — Chat (`ChatTab`)**: Streams live conversation threads directly from local `conversation_summaries.db` and `transcript.jsonl` with prompt injection via `agentapi.bat`. Features collapsible Thinking sections, expandable Tool Call chips, Subagents & Swarm drawer, rendered Artifacts viewer sheet, and bottom composer with `/` Slash Command picker (`/plan`, `/grill-me`, `/boost`, etc.) and `@` File Mention autocomplete.
- **Tab 2 — Projects (`ProjectsWorkspaceTab`)**: Real local workspace list (`C:\Users\...\F`, `scratch`) opening into a Desktop-style Project Workspace with breadcrumb directory browsing (`/api/agy/files/list`), line-numbered code viewer (`/api/agy/files/read`) with **"Ask Agent about `@file`"** CTA, Git diffs and file revert, and project chats.
- **Tab 3 — Terminal (`TerminalTab`)**: Project directory selection, quick shortcut chips (`git status`, `git log -5 --oneline`, `pytest`, `npm run build`), and secure remote command execution on host (`POST /api/agy/terminal/exec`).
- **Tab 4 — Laptop (`LaptopTab`)**: Independent Agent Gate Mode (`Ask on Phone` vs `Agent Turbo`), separated 5-gear Backpack Power Governor, Antigravity Skills/Plugins/Rules inspection (`GET /api/agy/customizations`), host vitals, and auto-healing Cloudflare Tunnel + QR pairing.

### Global Inline Permission Banner
Surfaces `Ask on Phone` approval prompts (`Approve`, `Allow 30m`, `Deny`) cleanly across any active tab whenever an agent execution is held in Mode A, featuring a tabular countdown bar and AST risk tier badges (Tier 0–3).

### Agent Gate Mode vs. Laptop Hardware Power
`Agent Gate Mode` (`ask_on_phone` vs `agent_turbo`) is independent from the 5 laptop power gears (`ultra_sip`, `auto_turbo`, `balanced`, `max_turbo`, `low_battery_guard`):
- **Agent Gate Mode**: Controls hook execution permissions. In `ask_on_phone` mode, tool use is held in a 25-second queue awaiting phone approval. In `agent_turbo` mode, Tier 0–2 actions are auto-approved while Tier 3 destructive operations and secrets remain strictly blocked.
- **Laptop Hardware Power Gears**: Controls host physical power management (CPU throttling, OS power schemes, and display state). Clicking `ultra_sip` locks `manualGear` (`autoGovernorEnabled=False`) to enforce maximum battery conservation regardless of running agent tasks, remaining locked until `auto_turbo` is selected to re-enable autonomous dynamic scaling.

### Adaptive Backpack Power Governor (`server/power_governor.py`)
- **`ultra_sip`**: When idle on battery/backpack (`autoGovernorEnabled=True`), drops Windows to the Best Power Efficiency overlay (`PowerSetActiveOverlayScheme`) and processor throttling while keeping `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` active only as needed so your hotspot tunnel never drops.
- **`auto_turbo`**: Immediately restores full Balanced/High Performance CPU boost the instant a desktop hook or Mode-B worker begins executing.
- **PANIC Host Lock**: One tap from the header sets `HOST_LOCKED`, denies/terminates active hooks, terminates `JobObjectPtyMux` PowerShell children via Win32 `TerminateJobObject`, and optionally calls `LockWorkStation()`.

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
