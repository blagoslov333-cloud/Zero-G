# Zero-G (0G) — Design Handoff & Layout Specification (DESIGN.md)

> **Product Identity:** `0G` (digit `0` + capital `G` — 1:1 Native Antigravity Remote Control & Host Power Governor)
> **Surface Mode:** `Operate` (mobile-first PWA & Desktop Aux Pane) | `Persuade` (pairing & status cards)
> **Target Breakpoints:** `390px` mobile viewport (primary canvas, zero horizontal overflow), `768px` tablet, `320px–420px` Antigravity Desktop Aux Pane (`?view=auxpane`), `1440px` desktop workstation

---

## 1. Purpose for the Design Team

This codebase separates 100% of visual skinning from runtime state, WebSocket streaming, and Python host execution. All layouts are semantic, dependency-free skeletons bound strictly to CSS custom properties in `web/src/styles/theme.css` and `tokens.dtcg.json`.

The visual direction, typography, corner radii, spacing scales, elevations, and branding are 100% open to the designer. The interface is unconstrained by any predefined aesthetic. Your design team can construct custom visual themes from scratch without modifying backend Python or React application logic simply by assigning values to the semantic CSS variables.

### Built-in Structural Theme Presets (`[data-theme="..."]`)
Existing theme entries in `web/src/styles/theme.css` serve as structural references demonstrating variable wiring across environments:
1. **`obsidian` (Baseline structural preset):** Default baseline structural preset for low-ambient and night-mode testing.
2. **`outdoor` (Daylight high-contrast preset):** Inverted structural preset optimized for high-glare mobile environments.
3. **`wireframe` (Studio wireframe preset):** Neutral structural grid with baseline hairlines for designer annotation and reskinning.

### Explicit Functional Constraints
- Consume semantic variables exclusively (`var(--bg-canvas)`, `var(--bg-surface)`, `var(--text-primary)`, `var(--text-muted)`, `var(--accent-primary)`, `var(--accent-secondary)`, `var(--border-default)`, and semantic status tokens).
- Never drop `:focus-visible` outlines.
- Never nest cards inside cards needlessly.
- Never shrink interactive touch targets below `44x44px` on mobile viewports.
- Never use `transition: all` (animate `transform` and `opacity` only, honoring `prefers-reduced-motion`).
- **Zero Bottom Navigation Tabs:** Antigravity operates as a unified single-canvas application (Top Bar, Left Sidebar Drawer, Center Chat Canvas, Slide-out Right Auxiliary Pane).

---

## 2. Semantic CSS Variable Slots (Palette Defined by Designer)

Consume via `tokens.dtcg.json` or `web/src/styles/theme.css`. The designer defines all values according to these semantic roles and accessibility criteria:

| Semantic Role | CSS Custom Property | UI Role / Where Used | Accessibility Requirement |
| :--- | :--- | :--- | :--- |
| **Canvas Background** | `--bg-canvas` / `--background` | Primary viewport backdrop across full screen | Foundation layer |
| **Elevated Surface** | `--bg-surface` / `--surface` | Cards, drawers, top bar, message box, Aux Pane | Base card layer |
| **Subtle Well** | `--bg-subtle` | Code blocks, terminal wells, nested table rows | Subtle structural differentiation |
| **Raised Surface** | `--bg-elevated` | Active pills, hover highlights, modal sheets, voice bar | Elevated contrast layer |
| **Primary Text** | `--text-primary` / `--foreground` | Headings, primary labels, main message content | `>= 4.5:1` contrast on surface and canvas |
| **Muted Text** | `--text-muted` / `--muted-foreground` | Secondary labels, metadata, timestamps, captions | `>= 4.5:1` contrast for readable body text |
| **Primary Action** | `--accent-primary` / `--primary` | Primary CTA button fill, active switches, selection | `>= 3:1` interactive UI contrast |
| **Primary Foreground** | `--accent-primary-fg` / `--primary-foreground` | Text and icons rendered inside primary CTA buttons | `>= 4.5:1` contrast against `--accent-primary` |
| **Secondary Accent** | `--accent-secondary` / `--accent` | Live sync pulse, active links, data badges | `>= 3:1` interactive UI contrast |
| **Border Hairline** | `--border-default` / `--border` | Structural card borders and control dividers (1px) | `>= 3:1` boundary contrast per WCAG 2.2 AA |
| **Strong Border** | `--border-strong`, `--border-style` | Active focus frames and emphasized dividers | High-visibility focus indicator |
| **Status: Info** | `--status-info`, `-bg`, `-fg` | Informational callouts, workspace badges | `>= 4.5:1` text / `>= 3:1` UI contrast |
| **Status: Warning** | `--status-warning`, `-bg`, `-fg` | Hold countdown timer, review alerts, battery guard | `>= 4.5:1` text / `>= 3:1` UI contrast |
| **Status: Danger** | `--status-danger`, `-bg`, `-fg`, `-contrast` | `HOST_LOCKED` banner, tier 3 blocks, PANIC button | `>= 4.5:1` text / `>= 3:1` UI contrast |
| **Status: Success** | `--status-success`, `-bg`, `-fg` | Passed checks, clean worktree, synced indicators | `>= 4.5:1` text / `>= 3:1` UI contrast |
| **Diff Highlights** | `--diff-add-bg`/`-fg`, `--diff-del-bg`/`-fg` | Added and deleted unified diff lines in drawer | `>= 4.5:1` text contrast for diff inspection |

### Provider Badge Token Slots (Defined by Designer)
| Provider ID | CSS Token | UI Role / Where Used | Accessibility Requirement |
| :--- | :--- | :--- | :--- |
| `antigravity` | `--provider-antigravity` | Priority 1 orbital mark (0G native integration) | `>= 3:1` graphical element contrast |
| `claude_code` | `--provider-claude` | Anthropic Claude Code adapter mark | `>= 3:1` graphical element contrast |
| `codex_cli` | `--provider-codex` | OpenAI Codex CLI adapter mark | `>= 3:1` graphical element contrast |
| `grok_build` | `--provider-grok` | xAI Grok Build adapter mark | `>= 3:1` graphical element contrast |

---

## 3. Typography & Hierarchy

Font selection is completely open to the designer. Configure font families via these token slots:
- **Display Typeface Slot:** `--font-display` (headings, hero titles, modal headers)
- **Body Typeface Slot:** `--font-body` (labels, body copy, descriptions, navigation items)
- **Monospace Typeface Slot:** `--font-mono` (code blocks, terminal output, telemetry, hash chains)

### Functional Mobile Typography Rules
- **Minimum Mobile Font Size:** `>= 12px` (`0.75rem`) for micro-badges and timestamps.
- **Input Field Sizing:** `14px–16px` for text inputs and textareas to prevent iOS browser auto-zoom on focus.
- **Tabular Discipline:** Enforce `font-variant-numeric: tabular-nums` on WebSocket sequence numbers, countdown timers (`25.0s`), battery percentages, CPU/VRAM telemetry, port numbers, and token budgets to prevent horizontal jitter during live streaming.

---

## 4. Information Architecture & Wireframe Skeleton

Zero-G implements a **1:1 Native Antigravity Remote Control** architecture. It operates as a unified single-canvas application with **ZERO bottom navigation tabs**. Navigation, workspace switching, multi-folder project configuration, tool supervision, and auxiliary companion views are organized across four structural regions:

```text
┌──────────────────────────────────────────────────────────┐
│ [≡] Project Name · Chat Title    [SE] ⚡Auto 🔋82% 🎨 [■] [⊞]│  Top Bar (min-h 52px)
├──────────────────────────────────────────────────────────┤
│                                                          │
│   CENTER CHAT CANVAS (Scrollable, full-bleed stream)     │
│                                                          │
│   - Turn History (User & Assistant)                      │
│   - Collapsible Thinking Blocks                          │
│   - Expandable Tool Call Chips                           │
│                                                          │
│   - Inline Interactive Cards:                            │
│     * Permission Confirmation Card (25s countdown)       │
│     * Implementation Plan Review (Proceed / Feedback)    │
│     * Clickable Multiple-Choice Question Card            │
│                                                          │
│   - Spoken Voice Call Bar (When Voice Mode Active):      │
│     * Live Gemini 3.8 Live Bidirectional Audio Stream    │
│     * Status: Listening / Speaking / Interrupted         │
│     * Controls: Mute Mic, Mute Speaker, 1x/1.25x/1.5x    │
│                                                          │
│   - Native Message Box (Sticky Bottom Composer):         │
│     [+] [Model: Auto ▼] [Preset: Auto ▼] [Local/Worktree]│
│     [Type prompt... /commands @files            ] [Mic]  │
│     [Start Voice Mode]                          [Send →] │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Region 1: Persistent Top Bar
Positioned at the top of the mobile viewport (`min-height: 52px`):
1. **Drawer Toggle (`[≡]`):** Opens the Slide-out Left Sidebar Drawer.
2. **Context Title:** Displays active Project Name and Conversation Title with truncation.
3. **Interface Layout Pill:** Indicates active layout mode (`SE` for Software Engineering, `KW` for Knowledge Work).
4. **Permission Preset Pill:** Displays active preset (`Review`, `Default`, `Auto`, `Turbo`).
5. **Backpack Power Governor Pill:** Displays battery percentage and active hardware power gear (`Ultra-Sip`, `Auto-Turbo`, `Balanced`, `Max Turbo`, `Low-Batt Guard`).
6. **Theme Switcher (`🎨`):** Cycles structural presets (`obsidian`, `outdoor`, `wireframe`).
7. **PANIC Lock Button (`[■]`):** One-tap hardware emergency lock (`HOST_LOCKED`).
8. **Aux Pane Toggle (`[⊞]`):** Opens the Slide-out Right Auxiliary Pane.

### Region 2: Slide-out Left Sidebar Drawer
Accessible via the top bar hamburger button or edge-swipe:
1. **Multi-Folder Project Selector:**
   - Real local workspaces and configured multi-folder projects.
   - Per-project configuration: folder paths, per-project permission preset override, and default worktree mode (`Local` vs `New Worktree`).
   - Project actions: Add folder root, refresh git status, inspect branch.
2. **Conversation History:**
   - Filterable conversation list grouped by project, recency, and active execution status.
   - `+ New Conversation` action with project directory picker, model selector (`Auto`, `Gemini 4 Carbon`, `Gemini 4 Hydrogen`, `Gemini 4 Argon`, `Gemini 3.8 Flash`, `Pro`, `Flash`), and worktree branch options.
3. **Settings Panel (General & Host Settings):**
   - **Interface Layout Selector:** Toggle between `Software Engineering` and `Knowledge Work`.
   - **Global Permission Preset:** Select global default (`Request Review`, `Default`, `Auto`, `Turbo`).
   - **Windows Login Auto-Start:** Toggle host boot persistence.
   - **Tunnel Delivery Configuration:** Configure automatic link dispatch via Web Push and Gmail CLI.
   - **Authentication:** WebAuthn Passkey management.

### Region 3: Center Chat Canvas
The core interaction space for Antigravity sessions:
1. **Conversation Stream:**
   - Real-time turn rendering directly from local SQLite WAL (`conversation_summaries.db`) and `transcript.jsonl`.
   - Collapsible thinking sections displaying model contemplation state.
   - Expandable tool call chips detailing invocation arguments, execution duration, and output logs.
2. **Inline Chat Interactive Cards:**
   - **Permission Confirmation Card:** Surfaced inline whenever tool execution requires approval. Displays tabular countdown timer (`25.0s -> 0.0s`), AST risk tier badge (Tier 0–3), command preview, and action buttons (`Approve`, `Allow 30m`, `Deny`). If the timer elapses, transitions cleanly to an escalation badge indicating execution was preserved for host review.
   - **Implementation Plan Review Card:** Rendered when an agent presents a multi-step execution plan. Displays phase breakdown, executable steps, `Proceed` button, and structured feedback input.
   - **Clickable Multiple-Choice Question Card:** Displays structured decision options provided by the agent. Users select single or multiple choices with one tap and submit directly to the agent session.
3. **Spoken Voice Mode & Call Bar:**
   - Powered by `gemini-3.8-live` real-time bidirectional audio streaming over WebSocket (`16kHz` Int16 PCM input, `24kHz` Int16 PCM output).
   - Floats above the composer when active, displaying audio status: `Connecting`, `Listening`, `Speaking`, or `Interrupted`.
   - Native audio playback using gapless scheduling with configurable playback speed (`1x`, `1.25x`, `1.5x`).
   - Audio controls: Microphone mute toggle, Speaker mute toggle, and End Call button.
   - Spoken tool invocation: Hands-free steering, status query, and verbal hold approval (`"approve"`, `"deny"`).
   - Automatic graceful fallback to Web Speech recognition and synthesis when live bidirectional audio streaming is unavailable.
4. **Native Message Box:**
   - **`+` Upload Button:** Mobile file and photo upload dispatching directly to active project workspace.
   - **Model Selector Dropdown:** Select active model (`Auto`, `Gemini 4 Carbon`, `Gemini 4 Hydrogen`, `Gemini 4 Argon`, `Gemini 3.8 Flash`, `Pro`, `Flash`).
   - **Permission Preset Picker:** Switch active conversation preset (`Request Review`, `Default`, `Auto`, `Turbo`).
   - **Workspace Mode Toggle:** Choose between `Local` workspace or isolated `New Worktree`.
   - **Auto-Growing Text Area:** Keyboard input supporting `/` Slash Commands (`/plan`, `/grill-me`, `/boost`, `/teamwork`, `/goal`, `/browser`, `/compact`, `/schedule`, `/learn`) and `@` Mentions (file autocomplete).
   - **Dictation Mic:** Speech-to-text dictation directly into the composer.
   - **Voice Mode Trigger:** Button to launch spoken bidirectional session.

### Region 4: Slide-out Right Auxiliary Pane (`?view=auxpane`)
Slides out from the right on mobile, or embeds as a standalone desktop companion sidebar (`320px–420px`). Organizes six dedicated tabs:
1. **`Subagents` Tab:**
   - Hierarchical swarm overview and agent roster.
   - Displays agent role, active state (`waiting`, `working`, `stopped`), and parent-child task lineage.
   - Nudge button to wake dormant agents or break coordination deadlocks.
2. **`Files` Tab:**
   - **Changes Sub-view:** Git status list showing modified and untracked files, expandable unified diff viewer, 1-tap `Git Commit & Push` with commit message input, and 1-tap `Revert` file action.
   - **Browse Sub-view:** Read-only breadcrumb file tree explorer (`/api/agy/files/list`, `/api/agy/files/read`) with line numbers and 1-tap `@ Mention` button to inject file paths into the chat composer.
3. **`Preview` Tab:**
   - Authenticated reverse proxy (`/preview/{port}/`) streaming live local web applications (`localhost:PORT`) running on the host over Cloudflare Tunnel.
   - Automatic port detection scanning active development listening ports (`3000`, `5173`, `8080`, `8000`, etc.) with one-tap preview launch.
4. **`Artifacts` Tab:**
   - Rich artifact viewer rendering generated artifacts (Markdown documents, interactive HTML widgets, SVG diagrams, and standalone code deliverables).
5. **`Terminal` Tab:**
   - Workspace directory selector, execution history with ANSI sanitization, quick shortcut chips (`git status`, `git log -5 --oneline`, `pytest`, `npm run build`), and remote command input bar (`POST /api/agy/terminal/exec`).
6. **`Tasks` Tab:**
   - Background task monitoring, progress tracking, task cancellation, and execution logs.

---

## 5. Interface Layouts & Permission Models

### Interface Layouts (Settings > General)
Users can toggle between two primary interface layouts depending on their focus:
- **`Software Engineering` Layout:** Full technical surface exposing git diffs, commit/push actions, remote terminal execution, AST risk tiers, reverse proxy port preview, and granular swarm coordination.
- **`Knowledge Work` Layout:** Streamlined productivity surface emphasizing conversation transcripts, document and artifact drafting, spoken voice interaction, and simplified task progress cards.

### 4 Native Antigravity Permission Presets
Permission presets control tool execution safety thresholds, configured globally or per project:
1. **`Request Review`:** Strict verification. All tool invocations, file modifications, command executions, and network requests require explicit confirmation.
2. **`Default`:** Balanced operation. Read-only actions and benign inspect commands run automatically; file modifications and elevated commands require approval.
3. **`Auto`:** Autonomous workflow. Standard development tools and safe commands run automatically; only high-risk operations trigger confirmation.
4. **`Turbo`:** Maximum speed. Auto-approves all Tier 0–2 actions while maintaining strict hard-block safety invariants on Tier 3 operations (sensitive files, credential stores, host destruction).

### Decoupling: Permission Presets vs. Backpack Power Governor
Permission presets govern agent execution autonomy. The **Backpack Power Governor** governs host hardware physics:
- **`Ultra-Sip`:** Engages maximum battery conservation, throttles CPU power profiles, dims host display, and maintains tunnel persistence with minimal energy draw.
- **`Auto-Turbo`:** Dynamically scales host CPU performance to maximum boost during agent execution, scaling down to conservation when idle.
- **`Balanced`:** Standard OS balanced power delivery.
- **`Max Turbo`:** Forces continuous peak CPU performance for intensive compilation or local model tasks.
- **`Low-Batt Guard`:** Automatically enforces conservation thresholds when battery drops below safety limits.

---

## 6. Mandatory Interactive State Matrix

Every screen and component MUST handle all baseline and runtime states cleanly:

| State Key | Trigger Condition | Required Visual / Structural Behavior |
| :--- | :--- | :--- |
| `default` | Idle or steady connected state | Crisp `1px` `--border-default` hairline, live telemetry, `160ms` transform hover lift on desktop |
| `hover` / `focus-visible` | Keyboard or pointer navigation | `2px solid var(--border-strong)` with `2px` offset; zero suppressed focus rings |
| `loading` | Initial fetch, conversation load, or command execution | Skeleton shimmer rows matching card geometry (zero layout shift, `CLS < 0.1`) |
| `empty` | No active conversations, clean git working tree, or empty directory | Clear empty-state card with guidance copy and direct primary action CTA |
| `error` | API failure, bridge offline, or command execution error | High-contrast `--status-danger` inline alert with retry button or diagnostic explanation |
| `permission-hold` | Tool execution requiring approval | Inline confirmation card with tabular countdown timer (`25.0s -> 0.0s`), AST risk tier pill, command preview, `Approve`, `Allow 30m`, `Deny` |
| `plan-review` | Multi-step agent plan awaiting review | Plan review card displaying steps, `Proceed` primary button, and feedback input |
| `question-pending` | Agent requesting user decision | Multiple-choice card with selectable options and submit button |
| `voice-active` | Spoken voice session connected | Floating Voice Call Bar with audio waveform pulse, mic/speaker toggles, speed selector |
| `voice-speaking` | Agent voice output streaming | Audio playback active with interrupt detection and speech synthesis status |
| `voice-interrupted` | User speaks while agent speaks | Scheduled audio buffers cleared instantly, returning to listening state |
| `HOST_LOCKED` | PANIC button triggered | Persistent danger-state banner across top bar (`HOST LOCKED — Hooks Denying All Writes`), unlock requires explicit reset |
| `offline-queued` | Phone offline / network handoff | Outgoing prompt saved in IndexedDB outbox with queued status badge; auto-flushes on reconnect |
| `ultra_sip` / `max_turbo` | Hardware Power gear selected | Hardware power pill reflects active state; manual selection locks state until changed |

---

## 7. Geometry, Motion & Custom Project Slot Guide

- **Outer Container Radius:** `16px` (`--radius-outer`) | **Inner Control Radius:** `10px` (`--radius-inner`)
- **Custom Project Icon Slots:** Each workspace card renders an optional `project.icon` (`terminal`, `cpu`, `folder`, or custom SVG slot) and `project.accentToken` for bespoke iconography and visual treatments without altering API contracts.
- **Motion Signature:** `140ms`–`240ms` `cubic-bezier(0.22, 1, 0.36, 1)` applied strictly to `transform` and `opacity` properties.
