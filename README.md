# Zero-G (0G) — Zero-Weight Mobile Remote & Host Control

[![Zero-G CI](https://github.com/blagoslov333-cloud/Zero-G/actions/workflows/ci.yml/badge.svg)](https://github.com/blagoslov333-cloud/Zero-G/actions/workflows/ci.yml)

**Zero-G (0G)** is a local-first Windows bridge (`127.0.0.1:8790`) and mobile-first React PWA serving as a 1:1 Native Antigravity Remote Control and host power governor for autonomous AI coding agents. It provides native first-class integration for **Antigravity (Priority 1)** via real-time SQLite WAL streaming (`conversation_summaries.db`), transcript ingestion (`transcript.jsonl`), prompt injection (`agentapi.bat`), and bidirectional spoken voice conversation (`gemini-3.8-live`), alongside multi-provider hook support for **Claude Code**, **OpenAI Codex CLI**, and **xAI Grok Build**, with zero cloud lock-in, always-on two-way WebSocket state sync, adaptive Windows power governance, and a single-canvas mobile interface with zero bottom navigation tabs.

---

## Architecture

```text
+---------------------------------------+       HTTPS / WSS       +----------------------------------+
|    Paired Phone PWA (Single Canvas)   | <=====================> |  Cloudflare Tunnel / Tailscale   |
|  - Persistent Top Bar & Left Drawer   |    Two-Way /ws/stream   +----------------------------------+
|  - Center Chat & Spoken Voice Mode    |         /ws/voice                       |
|  - Slide-out Right Auxiliary Pane     |                                         v
|  - Inline Interactive Cards           |                         +----------------------------------+
|  - Zero Bottom Navigation Tabs        |                         |  0G Bridge Daemon (127.0.0.1)    |
+---------------------------------------+                         |  - FastAPI + SQLite WAL + Audit  |
                                                                  |  - AntigravityDesktopBridge      |
+---------------------------------------+   Read-only DB / CLI    |  - VoiceLiveRelay (Gemini Live)  |
|      Antigravity Desktop & SDK        | <=====================> |  - EgressRedactor & RulesEngine  |
|  - conversation_summaries.db (WAL)    |   transcript.jsonl /    |  - BackpackPowerGovernor (Win32) |
|  - ~/.gemini/antigravity/brain/       |   agentapi.bat / stdio  |  - JobObjectPtyMux & GitManager  |
|  - Multi-Provider Hooks Support       |                         +----------------------------------+
|    (Claude Code, Codex, Grok)         |                                         ^
+---------------------------------------+         hooks/shim.py (python -I -S)    |
                                          ----------------------------------------+
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

Fetch ready-to-paste hook configs anytime from `GET /api/adapters/hook-configs` or Settings in the PWA:

| Provider | Priority | Config File | Worker Runner |
| :--- | :--- | :--- | :--- |
| **Antigravity** | **Priority 1 (Native)** | `~/.gemini/antigravity/hooks.json` or `plugin/0g/` | `google.antigravity` SDK / `agy` CLI / async fallback |
| **Claude Code** | Supported | `~/.claude/settings.json` | `claude -p --output-format stream-json` |
| **OpenAI Codex CLI** | Supported | `~/.codex/hooks.json` | `codex exec --json` |
| **xAI Grok Build** | Supported | `~/.grok/hooks.json` | `grok -p` + MCP |

---

## Key Capabilities

### 1:1 Native Antigravity Remote Control (Single-Canvas UI)
- **Zero Bottom Navigation Tabs:** Antigravity operates on a unified single-canvas design featuring a Persistent Top Bar, Slide-out Left Sidebar Drawer, Center Chat Canvas with Native Message Box & Spoken Voice Mode, and Slide-out Right Auxiliary Pane.
- **Persistent Top Bar:** Hamburger drawer toggle, Project & Conversation title, Interface Layout indicator (`Software Engineering` vs `Knowledge Work`), Permission Preset pill, battery & power gear pill, theme switcher, PANIC host lock button, and Aux Pane toggle.
- **Slide-out Left Sidebar Drawer:** Multi-Folder Project Selector (folder management, per-project permission presets, worktree mode defaults), filterable Conversation History with `+ New Conversation` action, and Settings modal.

### Interface Layouts: Software Engineering vs. Knowledge Work
- **`Software Engineering` Layout:** Technical interface exposing full git diffs, commit/push actions, remote terminal execution, AST risk tiers, reverse proxy port previews, and granular swarm coordination.
- **`Knowledge Work` Layout:** Streamlined interface prioritizing conversation transcripts, document and artifact drafting, spoken voice mode, and simplified task cards.

### Native Message Box & Spoken Voice Mode
- **Native Composer:** `+` File/Photo upload directly to project workspace, Model Picker (`Auto`, `Gemini 4 Carbon`, `Gemini 4 Hydrogen`, `Gemini 4 Argon`, `Gemini 3.8 Flash`, `Pro`, `Flash`), Permission Preset Picker (`Request Review`, `Default`, `Auto`, `Turbo`), Workspace Mode toggle (`Local` vs `New Worktree`), auto-growing prompt input with `/` Slash Commands (`/plan`, `/grill-me`, `/boost`, `/teamwork`, `/goal`, `/browser`, `/compact`, `/schedule`, `/learn`) and `@` Mentions (file autocomplete), and Dictation Mic.
- **Spoken Voice Mode (`Start Voice Mode`):** Real-time bidirectional voice conversation powered by `gemini-3.8-live` over WebSocket (`/ws/voice`, 16kHz Int16 PCM upload, 24kHz Int16 PCM playback with gapless scheduling, 1x/1.25x/1.5x speed, mic/speaker mute, and instant interrupt detection). Supports non-blocking spoken steering, status queries, and verbal approvals (`"approve"`, `"deny"`), with automatic fallback to Web Speech recognition and synthesis.

### Inline Chat Interactive Cards
- **Permission Confirmation Card:** Surfaced inline whenever tool execution requires approval. Displays tabular countdown timer (`25.0s -> 0.0s`), AST risk tier badge (Tier 0–3), command preview, and action buttons (`Approve`, `Allow 30m`, `Deny`).
- **Implementation Plan Review Card:** Displays structured plan steps with `Proceed` action and feedback input.
- **Clickable Multiple-Choice Question Card:** Lets users review and tap structured decisions directly in the conversation feed.

### 6-Tab Right Auxiliary Pane (`?view=auxpane`)
Slides out on mobile or runs as a dedicated desktop sidecar (`320px–420px`):
1. **`Subagents`:** Swarm hierarchy and roster, execution states (`waiting`, `working`, `stopped`), child transcripts, and Nudge button.
2. **`Files`:** `Changes` sub-view (modified/untracked files, unified diff viewer, 1-tap `Git Commit & Push` with commit message, 1-tap `Revert`) and `Browse` sub-view (read-only file tree with line numbers and direct `@ Mention` button).
3. **`Preview`:** Authenticated reverse proxy (`/preview/{port}/`) streaming live local web applications (`localhost:PORT`) running on the host over Cloudflare Tunnel, featuring automatic listening port detection.
4. **`Artifacts`:** Rendered view of generated artifacts (Markdown documents, interactive HTML widgets, SVG diagrams, and code deliverables).
5. **`Terminal`:** Working directory selector, execution log with ANSI sanitization, quick shortcut chips (`git status`, `git log -5 --oneline`, `pytest`, `npm run build`), and remote command input bar (`POST /api/agy/terminal/exec`).
6. **`Tasks`:** Background task management, active task status, cancellation, and execution logs.

### 4 Native Permission Presets vs. 5 Backpack Power Governor Gears
- **4 Permission Presets (Agent Execution Safety):** `Request Review`, `Default`, `Auto`, `Turbo` (configured globally and overridden per multi-folder project).
- **5 Backpack Power Governor Gears (Host Hardware Physics):** `Ultra-Sip`, `Auto-Turbo`, `Balanced`, `Max Turbo`, `Low-Batt Guard` controlling CPU frequencies, OS power overlays, and display states to preserve battery.
- **PANIC Host Lock:** One tap sets `HOST_LOCKED`, terminates active hook executions, stops child processes via Win32 `TerminateJobObject`, and locks the host.

### Windows Login Auto-Start & Tunnel Delivery
- Windows login auto-start (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` or startup shortcut).
- Automatic outbound Cloudflare Tunnel negotiation on boot.
- Automatic pairing link delivery via Web Push notifications and Gmail CLI.

### Security & Tamper-Evident Audit
- **`EgressRedactor`**: Strips ANSI escapes & Unicode BiDi overrides and masks API keys (`sk-`, `AIza`, `ghp_`, `xai-`, `AKIA`, Bearer tokens, PEM blocks, `.env` secrets) before streaming to the phone.
- **`RulesEngine`**: Enforces Tier-3 hard-deny self-protection on `hooks.json`, `plugin/0g`, `.env`, `~/.gemini/config/config.json`, `bridge.token`, and private key files.
- **Hash-Chained Audit Log**: Every rule evaluation, approval, pairing, and panic event is appended to a SHA-256 hash-chained `audit_log` table (`verify_audit_chain()`).

---

## Design & Theming (`DESIGN.md`)

100% of visual styling is tokenized as semantic CSS variable slots in [tokens.dtcg.json](tokens.dtcg.json) and [web/src/styles/theme.css](web/src/styles/theme.css) following [DESIGN.md](DESIGN.md), ready for custom design skinning:
- `obsidian` (Baseline structural preset for testing)
- `outdoor` (Daylight high-contrast mobile preset)
- `wireframe` (Neutral structural studio grid for design reskinning)

---

## Documentation

- **[PRODUCT.md](PRODUCT.md)** — Product context, target audience, surface modes (`Operate` vs `Persuade`), core user flows, and platform constraints.
- **[DESIGN.md](DESIGN.md)** — Design handoff specification, semantic CSS variable slots, DTCG tokens, and single-canvas mobile layout specifications.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — Architecture breakdown, local development checks, and security rules.
