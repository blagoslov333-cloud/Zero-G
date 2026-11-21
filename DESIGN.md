# Zero-G (0G) — Design Handoff & Layout Specification (DESIGN.md)

> **Product Identity:** `0G` (digit `0` + capital `G` — zero-weight mobile remote & host control for Antigravity, Claude Code, OpenAI Codex CLI, and xAI Grok Build)
> **Surface Mode:** `Operate` (mobile-first PWA + Desktop Aux Pane) | `Persuade` (open-source landing & pairing cards)
> **Target Breakpoints:** `390px` mobile viewport (primary, zero horizontal overflow), `768px` tablet, `320px–420px` Antigravity Desktop Aux Pane (`?view=auxpane`), `1440px` desktop

---

## 1. Purpose for the Design Team

This codebase separates **100% of visual skinning** from runtime state and host functionality. All layouts are built as semantic, unstyled-dependency-free skeletons bound exclusively to CSS custom properties in `web/src/styles/theme.css` and `tokens.dtcg.json`.

**The color palette, visual direction, brand identity, iconography, and typography are 100% open to the designer.** The UI is unconstrained by any predefined aesthetic or color system. Your design team can invent the visual palette from scratch, restyle fonts, icons, card radii, and project avatars **without touching backend Python or React state logic** simply by populating the semantic CSS variables.

### Built-in Structural Theme Presets (`[data-theme="..."]`)
Existing theme entries in `web/src/styles/theme.css` are temporary structural placeholders demonstrating semantic variable wiring across environments:
1. **`obsidian` (Default structural preset):** Baseline dark structural preset for OLED/night testing.
2. **`outdoor` (Daylight outdoor preset):** Inverted high-contrast structural preset for outdoor mobile testing.
3. **`wireframe` (Studio wireframe preset):** Neutral blueprint grid with structural hairlines for designer annotation and reskinning.

### Explicit Functional Constraints
- Never put raw color values or hex literals in `.tsx` components — consume semantic variables (`var(--bg-canvas)`, `var(--bg-surface)`, `var(--text-primary)`, `var(--text-muted)`, `var(--accent-primary)`, `var(--accent-secondary)`, `var(--border-default)`, and semantic status tokens).
- Never drop `:focus-visible` outlines, never nest cards inside cards needlessly, never shrink touch targets below `44x44px` on mobile, and never use `transition: all` (animate `transform` and `opacity` only, honoring `prefers-reduced-motion`).

---

## 2. Semantic CSS Variable Slots (Palette Defined by Designer)

Consume via `tokens.dtcg.json` or `web/src/styles/theme.css`. The designer defines all palette values according to these semantic roles and accessibility criteria:

| Semantic Role | CSS Custom Property | UI Role / Where Used | Accessibility Requirement |
| :--- | :--- | :--- | :--- |
| **Canvas Background** | `--bg-canvas` / `--background` | Primary viewport backdrop across full screen | Foundation layer |
| **Elevated Surface** | `--bg-surface` / `--surface` | Cards, bottom bar, navigation drawers, Aux Pane cards | Base card layer |
| **Subtle / Nested Well** | `--bg-subtle` | Code blocks, terminal wells, nested table rows | Subtle structural differentiation |
| **Raised Surface** | `--bg-elevated` | Active tab pills, hover highlights, modal sheets | Elevated contrast layer |
| **Primary Text** | `--text-primary` / `--foreground` | Headings, primary labels, main body copy | `>= 4.5:1` contrast on surface and canvas |
| **Muted / Secondary Text** | `--text-muted` / `--muted-foreground` | Metadata, timestamps, captions, secondary labels | `>= 4.5:1` contrast for readable body text |
| **Primary Action** | `--accent-primary` / `--primary` | Primary CTA button fill, active switches, active selection | `>= 3:1` interactive UI contrast |
| **Primary Foreground** | `--accent-primary-fg` / `--primary-foreground` | Text and icons rendered inside primary CTA buttons | `>= 4.5:1` contrast against `--accent-primary` |
| **Secondary Accent** | `--accent-secondary` / `--accent` | Live sync pulse, active links, data badges | `>= 3:1` interactive UI contrast |
| **Border / Hairline** | `--border-default` / `--border` | Structural card borders and control dividers (1px) | `>= 3:1` boundary contrast per WCAG 2.2 AA |
| **Strong Border / Style** | `--border-strong`, `--border-style` | Active focus frames and emphasized dividers | High-visibility focus indicator |
| **Status: Info** | `--status-info`, `-bg`, `-fg` | Informational callouts, Tier-1 workspace badges | `>= 4.5:1` text / `>= 3:1` UI contrast |
| **Status: Warning / Hold** | `--status-warning`, `-bg`, `-fg` | Hold countdown timer, Tier-2 review alerts, battery guard | `>= 4.5:1` text / `>= 3:1` UI contrast |
| **Status: Danger / PANIC** | `--status-danger`, `-bg`, `-fg`, `-contrast` | `HOST_LOCKED` banner, Tier-3 blocks, PANIC button | `>= 4.5:1` text / `>= 3:1` UI contrast |
| **Status: Success** | `--status-success`, `-bg`, `-fg` | Passed checks, clean worktree, synced indicators | `>= 4.5:1` text / `>= 3:1` UI contrast |
| **Git Diff Highlights** | `--diff-add-bg`/`-fg`, `--diff-del-bg`/`-fg` | Added and deleted unified diff lines in drawer | `>= 4.5:1` text contrast for diff inspection |

### Provider Badge Token Slots (Defined by Designer)
| Provider ID | CSS Token | UI Role / Where Used | Accessibility Requirement |
| :--- | :--- | :--- | :--- |
| `antigravity` | `--provider-antigravity` | Priority #1 orbital mark (`0G` native) | `>= 3:1` graphical element contrast |
| `claude_code` | `--provider-claude` | Anthropic Claude Code adapter mark | `>= 3:1` graphical element contrast |
| `codex_cli` | `--provider-codex` | OpenAI Codex CLI adapter mark | `>= 3:1` graphical element contrast |
| `grok_build` | `--provider-grok` | xAI Grok Build adapter mark | `>= 3:1` graphical element contrast |

---

## 3. Typography & Hierarchy

Font selection is completely open to the designer. Configure font families via these token slots:
- **Display Typeface Slot:** `--font-display` (headings, hero titles, modal headers)
- **Body Typeface Slot:** `--font-body` (labels, body copy, descriptions, navigation items)
- **Monospace / Data Typeface Slot:** `--font-mono` (code blocks, terminal output, telemetry, hash chains)

### Functional Mobile Typography Rules
- **Minimum Mobile Font Size:** `>= 12px` (`0.75rem`) for micro-badges and timestamps.
- **Input Field Sizing:** `14px–16px` for text inputs and textareas to prevent iOS browser auto-zoom on focus.
- **Tabular Discipline:** Enforce `font-variant-numeric: tabular-nums` on WebSocket `seq`, countdown timers (`25.0s`), battery %, CPU/VRAM telemetry, and token budgets to prevent horizontal jitter during live streaming.

---

## 4. Information Architecture & Wireframe Skeleton

### A. Mobile PWA Shell (`390px` Primary)
```text
┌──────────────────────────────────────────────────────────┐
│ [0G]  ● WS #seq   🔋 82% [ULTRA-SIP]   🎨Theme   [PANIC] │  <- Persistent Top Bar (min-h 52px)
├──────────────────────────────────────────────────────────┤
│                                                          │
│   Active Tab Canvas (Scrollable, 16px outer gutter)      │
│   1. Projects · Unified Feed (Desktop + Phone Workers)   │
│   2. Inbox (25s Hold Approvals, Edit Overwrite, Rules)   │
│   3. + New (Spawn Isolated Worktree Worker)              │
│   4. Automations & Tools (Cron, Macros, Phone MCP Tools) │
│   5. Host (Power Governor, Vitals, Terminal, Tunnel/QR)  │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ [Projects]   [Inbox (n)]   [+ New]   [Tools]   [Host]    │  <- Fixed 5-Tab Bottom Bar (>=44px tap targets)
└──────────────────────────────────────────────────────────┘
```

### B. Antigravity Desktop Aux Pane (`?view=auxpane`, `320px–420px`)
- Compact single-column stack without bottom nav:
  1. **Tunnel & QR Pairing Card:** Live Cloudflare Tunnel (`*.trycloudflare.com` / named) + Tailscale Serve URL, 1-click Copy, and scannable SVG QR + 6-digit pairing code.
  2. **Backpack Power Governor Card:** Live Battery %, AC/DC state, Gear pill (`Ultra-Sip` / `Auto-Turbo`), Keep-Awake status.
  3. **Pending Approvals & Mobile Tools Summary:** Active hold counter, registered phone tools count.
  4. **PANIC Host Lock Switch:** Instant hardware lock toggle (`HOST_LOCKED`).

### C. Implemented Sub-Views, Drawers & Interactive Overlays (Design Scope)
1. **Tab 1 — Projects & Unified Feed (`ProjectsFeedTab` + `FileChangeDrawer`):** Horizontal project cards (`Video production` + scratch workspaces), source filter (`All` / `Desktop` / `Phone`), live timeline with `Thoughts` & `Artifacts` toggles, offline-capable steering input with outbox status queue, and slide-over **File Change & Undo Drawer** (`git status`, unified diff viewer, revert file, worktree merge/discard).
2. **Tab 2 — Inbox & Smart Rules (`InboxTab`):** **Agent Gate Mode** toggle (`Ask on Phone` vs `Agent Turbo` auto-approve Tier 0–2, independent of hardware power), pending approval queue with live `25s` hold bar, AST breakdown + `Tier 0–3` pills, **Approve**, **Edit & Approve (`overwrite` JSON drawer)**, **Allow 30m**, **Deny**, plus Smart Rules creator.
3. **Tab 3 — Spawn Worker (`NewWorkerTab`):** Project selector, provider picker (`Antigravity` #1, `Claude Code`, `Codex CLI`, `Grok Build`), isolated `git worktree` toggle, token budget slider, and prompt launcher.
4. **Tab 4 — Automations & Phone Tools (`ToolsTab`):** Scheduled cron automations, One-Tap Laptop Macros, and the **Mobile Tool Authoring Studio** (`phone_js` / `host_command` editor + **Test on Phone** runner + 6 built-in phone tools).
5. **Tab 5 — Host Control (`HostTab`):** 5-gear **Backpack Power Governor** (`Ultra-Sip`, `Auto-Turbo`, `Balanced`, `Max Turbo`, `Low-Batt Guard`) + Display-Off + Low-Battery slider, CPU/RAM/GPU/Disk/Port vitals, interactive **Phone Terminal** + preset buttons (`git status`, `nvidia-smi`, `pytest`, `ports`), **Cloudflare / Tailscale Tunnel & QR Pairing**, WebAuthn Passkey & Web Push controls, and Multi-Provider Hook Snippets.
6. **Global Overlays (`MobilePromptModal` + `PairingModal`):** Interactive phone modal triggered live when an agent calls `phone_ask_input` or `phone_capture_photo`, dismissible notification card stack (`phone_notify_card`), and 6-digit pairing dialog.

---

## 5. Mandatory Interactive State Matrix

Every screen and reusable component MUST handle all baseline + `0G` runtime states clearly:

| State Key | Trigger Condition | Required Visual / Structural Behavior |
| :--- | :--- | :--- |
| `default` | Idle or steady connected state | Crisp `1px` `--border-default` hairline, live telemetry, `160ms` transform hover lift on desktop |
| `hover` / `focus-visible` | Keyboard or pointer navigation | `2px solid var(--focus-ring)` with `2px` offset; zero suppressed focus rings |
| `loading` | Initial fetch or worker boot | Skeleton shimmer rows matching card geometry (zero layout shift / `CLS < 0.1`) |
| `empty` | No sessions, pending approvals, or diffs | Clear empty-state card with 1-sentence guidance and direct primary action CTA |
| `error` | API failure, daemon down, or rule block | High-contrast `--status-danger` inline alert with retry button or fallback explanation |
| `phone-hold` | Mode A `PreToolUse` awaiting phone tap (`Ask on Phone` mode) | Live `tabular-nums` countdown bar (`25s -> 0s`), Web Push alert sent, AST risk tier pill (`Tier 0–3`), full unwrapped command block, **Approve**, **Edit & Approve**, **Allow 30m**, **Deny** |
| `escalated` | Hold window expired -> `force_ask` returned | Card transitions cleanly to warning-state `"Escalated to Antigravity Native UI"` badge so user knows laptop state was preserved |
| `agent-turbo` | `agentGateMode == "agent_turbo"` | Header/Inbox pill shows `"Agent Turbo (Auto)"`; Tier 0–2 workspace tools auto-allow while Tier-3 secrets/destructive commands stay blocked |
| `offline-queued` | Phone offline / hotspot handoff | Prompt saved in IndexedDB outbox with `"Queued (Guarded by step # & HEAD sha)"` badge; auto-flushes on WS reconnect |
| `HOST_LOCKED` | PANIC button triggered | Persistent danger-state banner across header (`HOST LOCKED — Hooks Denying All Writes`), unlock requires explicit reset/passkey |
| `ultra_sip` / `max_turbo` | Laptop Hardware Power gear (independent of Agent Gate!) | Distinct hardware power pill; selecting `Ultra-Sip` or `Max Turbo` locks manually (`Auto-Scale` off) and never flips when tasks start/finish |

---

## 6. Geometry, Motion & Custom Project Slot Guide

- **Outer Container Radius:** `16px` (`--radius-outer`) | **Inner Control Radius:** `10px` (`--radius-inner`)
- **Custom Project Icons & Styling Slots:** Each project card renders an optional `project.icon` (`clapperboard`, `terminal`, `cpu`, `folder`, or custom SVG/emoji slot) and `project.accentToken` so projects like **Video production** can receive bespoke iconography, typography accents, and visual treatments in `theme.css` without altering any API contract.
- **Motion Signature:** `140ms`–`240ms` `cubic-bezier(0.22, 1, 0.36, 1)` on `transform` and `opacity` only.
