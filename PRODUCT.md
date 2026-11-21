# Product Context — Zero-G (0G)

## 1. Subject & Audience
- **Product Name:** Zero-G (0G)
- **Subject / Domain:** 1:1 Native Antigravity Remote Control, always-on two-way WebSocket state relay, and adaptive host power governor for autonomous AI coding agents.
- **Primary Audience:** Developers and technical users running intensive Antigravity workflows on portable laptops (in transit, coffee shops, conferences, or walking with laptop in a backpack) who require untethered phone supervision, real-time conversation streaming, spoken voice interaction, multi-folder workspace management, remote terminal execution, and hardware power governance.
- **Core Job To Be Done:** Supervise, steer, verbally converse with, approve permissions for, and safely gate Antigravity sessions and host power from a mobile phone PWA over cellular or mobile hotspots with zero cloud lock-in and zero port forwarding.

---

## 2. Surface Modes
- **Operate (Primary Surface):** Unified single-canvas Antigravity application with ZERO bottom navigation tabs.
  - **Mobile PWA (`/`):** Optimized for 390px mobile viewports (zero horizontal overflow) with 44x44px minimum tap targets. Organized into Persistent Top Bar, Slide-out Left Sidebar Drawer, Center Chat Canvas with Native Message Box & Spoken Voice Mode, and Slide-out Right Auxiliary Pane.
  - **Desktop Aux Pane (`/?view=auxpane`):** Compact single-column sidebar (320px–420px width) designed for Antigravity desktop sidecars, providing QR pairing, battery and hardware power telemetry, active hold counters, and one-tap PANIC host lock.
- **Persuade (Secondary Surface):** Open-source overview, clean scannable capability highlights, and interactive pairing cards displaying scannable SVG QR codes and 6-digit pairing PINs.
- **Read (Documentation & Audit):** Clear typography hierarchy, under 80 characters line measure, tabular numbers for telemetry, and collapsible unified diffs.

---

## 3. Core User Flows & Capabilities

### 1. Single-Canvas Navigation & Left Sidebar Drawer
- Antigravity operates on a single-canvas paradigm without bottom navigation tabs.
- The persistent top bar hosts a drawer toggle, project and conversation context, interface layout indicator, permission preset pill, battery and power governor pill, theme selector, PANIC lock button, and auxiliary pane toggle.
- Opening the left drawer reveals:
  - **Multi-Folder Project Selector:** Manage configured project roots with folder paths, per-project permission presets, and default worktree modes (`Local` vs `New Worktree`).
  - **Conversation History:** Chronological and project-grouped conversation list with active execution indicators and `+ New Conversation` creation action.
  - **Settings Panel:** Toggle interface layout (`Software Engineering` vs `Knowledge Work`), set global permission presets (`Request Review`, `Default`, `Auto`, `Turbo`), configure Windows login auto-start, set up tunnel delivery via Gmail CLI and Web Push notifications, and manage WebAuthn Passkeys.

### 2. Native Message Box, Dictation & Spoken Voice Mode
- The sticky composer at the base of the chat canvas includes:
  - **`+` Upload Button:** Upload local photos or documents directly into the active workspace.
  - **Model Picker:** Select execution model (`Auto`, `Gemini 4 Carbon`, `Gemini 4 Hydrogen`, `Gemini 4 Argon`, `Gemini 3.8 Flash`, `Pro`, `Flash`).
  - **Permission Preset Picker:** Switch conversation safety threshold (`Request Review`, `Default`, `Auto`, `Turbo`).
  - **Workspace Mode Toggle:** Switch between `Local` repository and isolated `New Worktree`.
  - **Composer Area:** Auto-growing prompt input with `/` Slash Command picker (`/plan`, `/grill-me`, `/boost`, `/teamwork`, `/goal`, `/browser`, `/compact`, `/schedule`, `/learn`) and `@` Mention file autocomplete.
  - **Dictation Mic:** Speech-to-text dictation directly populating prompt input.
  - **Spoken Voice Mode (`Start Voice Mode`):** Launches real-time bidirectional voice conversation powered by `gemini-3.8-live` over WebSocket. Uses 16kHz Int16 PCM microphone input and 24kHz Int16 PCM audio playback scheduled gaplessly with configurable playback rate (`1x`, `1.25x`, `1.5x`), speaker and mic mute toggles, and instant interrupt detection. Supports non-blocking spoken steering, status queries, and verbal approvals (`"approve"`, `"deny"`). Includes automatic fallback to Web Speech recognition and synthesis when live bidirectional audio streaming is unavailable.

### 3. Inline Chat Interactive Cards
Interaction flows occur directly within the conversation stream:
- **Permission Confirmation Card:** Surfaced inline whenever tool execution requires approval. Displays tabular countdown timer (`25.0s -> 0.0s`), AST risk tier badge (Tier 0–3), command preview, and action buttons (`Approve`, `Allow 30m`, `Deny`).
- **Implementation Plan Review Card:** Surfaced when the agent formulates a multi-phase implementation plan, allowing users to inspect planned steps, tap `Proceed` to execute, or submit structured feedback.
- **Clickable Multiple-Choice Question Card:** Presents structured choice menus generated by the agent, allowing users to make selections and submit responses with a single tap.

### 4. Slide-out Right Auxiliary Pane & Desktop Companion (`?view=auxpane`)
Accessible via top bar button or swipe gesture, housing six dedicated auxiliary tools:
- **`Subagents` Tab:** Swarm overview, agent hierarchy, execution states (`waiting`, `working`, `stopped`), child transcripts, and Nudge action to unstick stalled agents.
- **`Files` Tab:**
  - **Changes:** Git status list showing modified and untracked files, unified diff viewer, 1-tap `Git Commit & Push` with custom commit message, and 1-tap `Revert` file action.
  - **Browse:** Read-only breadcrumb file tree explorer (`/api/agy/files/list`, `/api/agy/files/read`) with line numbers and direct `@ Mention` injection into the composer.
- **`Preview` Tab:** Authenticated reverse proxy (`/preview/{port}/`) streaming live local web applications (`localhost:PORT`) running on the host over Cloudflare Tunnel, featuring automatic listening port detection.
- **`Artifacts` Tab:** Rich rendered view of agent-generated artifacts (Markdown documents, interactive HTML widgets, SVG diagrams, and standalone code deliverables).
- **`Terminal` Tab:** Project directory selector, execution log with ANSI sanitization, quick shortcut chips (`git status`, `git log -5 --oneline`, `pytest`, `npm run build`), and remote command input bar (`POST /api/agy/terminal/exec`).
- **`Tasks` Tab:** Background task monitoring, active status, cancellation, and execution logs.

### 5. 4 Native Antigravity Permission Presets vs 5-Gear Backpack Power Governor
Agent execution safety is strictly decoupled from physical hardware power management:
- **4 Permission Presets:**
  - `Request Review`: Strict verification on all tools, file edits, and network operations.
  - `Default`: Balanced mode; auto-approves read and inspect actions, asks on modifications.
  - `Auto`: Autonomous development; auto-approves standard tools, asks on high-risk operations.
  - `Turbo`: Maximum autonomy; auto-approves Tier 0–2 actions while strictly maintaining Tier 3 safety barriers.
- **5 Backpack Power Governor Gears:**
  - `Ultra-Sip`: Aggressive battery conservation, throttled CPU profiles, host display dimmed, tunnel kept active.
  - `Auto-Turbo`: Dynamic scaling; boots CPU to peak performance during agent execution, throttles down when idle.
  - `Balanced`: Standard balanced OS power scheme.
  - `Max Turbo`: Continuous maximum CPU boost for heavy compilation and tasks.
  - `Low-Batt Guard`: Automatic power throttling triggered by low battery threshold.

### 6. Windows Login Auto-Start & Outbound Tunnel Delivery
- Local bridge starts automatically with Windows login (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` or startup folder).
- Automatically establishes an outbound Cloudflare Tunnel over mobile hotspots without port forwarding.
- Dispatches public pairing links directly to the user via Web Push notifications and Gmail CLI.

---

## 4. Technical & Platform Constraints
- **Backend Stack:** FastAPI + SQLite WAL + Win32 ctypes / Linux `/proc/meminfo` telemetry backend + Antigravity Desktop Bridge (`conversation_summaries.db`, `transcript.jsonl`, `agentapi.bat`) running locally on `127.0.0.1:8790`.
- **Frontend Stack:** React 19 + TypeScript + Vite Progressive Web App (PWA) with service worker offline caching, Web Speech API fallback, and Web Push notifications.
- **Styling & Design Tokens:** Styled exclusively via semantic CSS custom properties (`web/src/styles/theme.css`, `tokens.dtcg.json`, `DESIGN.md`) providing slots ready for custom design skinning. Structural presets include baseline testing (`obsidian`), daylight outdoor testing (`outdoor`), and studio wireframe (`wireframe`). Zero hardcoded colors in React components.
- **Target Viewports:**
  - `390×844` (Mobile primary — iPhone / Android standard viewports)
  - `320–420px` (Antigravity Desktop Aux Pane `?view=auxpane` sidecar)
  - `1440×900` (Desktop widescreen monitoring)
- **Accessibility Target:** WCAG 2.2 AA compliant contrast (4.5:1 minimum text contrast, 3:1 minimum on all interactive elements), visible 2px focus rings, reduced-motion media query support, and tabular-nums formatting for telemetry and countdowns.
