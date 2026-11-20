# `0G` — Design System & Layout Handoff Specification (`DESIGN.md`)

> **Product Identity:** `0G` (digit `0` + capital `G` — zero-weight mobile remote & host control for Antigravity, Claude Code, OpenAI Codex CLI, and xAI Grok Build)
> **Active Style Archetype:** `#13` — **Obsidian Dark Bento Grid** (`obsidian-dark-bento-grid`)
> **Surface Mode:** `Operate` (mobile-first PWA + Desktop Aux Pane) | `Persuade` (open-source landing & pairing cards)
> **Target Breakpoints:** `390px` mobile viewport (primary, zero horizontal overflow), `768px` tablet, `320px–420px` Antigravity Desktop Aux Pane (`?view=auxpane`), `1440px` desktop

---

## 1. Purpose for the Design Team

This codebase separates **100% of visual skinning** from runtime state and host functionality. All layouts are built as semantic, unstyled-dependency-free skeletons bound exclusively to CSS custom properties in `web/src/styles/theme.css` and `tokens.dtcg.json`. Your design team can restyle fonts, icons, glow/motion effects, card radii, and project avatars **without touching backend Python or React state logic** by swapping theme tokens or adding a custom theme selector entry.

### Built-in Theme Presets (`[data-theme="..."]`)
1. **`obsidian` (Default — Style #13 Obsidian Dark Bento Grid):** High-contrast OLED dark (`#09090B` canvas / `#121318` surface, emerald `#10B981` primary, sky `#38BDF8` accent).
2. **`outdoor` (`0G Daylight Outdoor`):** High-visibility sunlight contrast for on-the-go mobile use (`#F8FAFC` canvas / `#FFFFFF` surface, deep emerald `#047857`, deep slate text `#0F172A`).
3. **`wireframe` (`0G Studio Wireframe`):** Neutral low-ornament blueprint grid (`#111111` / `#1A1A1A` dashed hairlines, monochrome structural labels) specifically for your external design team to annotate and reskin.

### Explicit Anti-Patterns
- Never put raw hex codes in `.tsx` components — consume `var(--bg-canvas)`, `var(--bg-surface)`, `var(--text-primary)`, `var(--text-muted)`, `var(--accent-primary)`, `var(--accent-secondary)`, `var(--border-default)`, and semantic status tokens.
- Never drop `:focus-visible` outlines, never nest cards inside cards needlessly, never shrink touch targets below `44x44px` on mobile, and never use `transition: all` (animate `transform` and `opacity` only, honoring `prefers-reduced-motion`).

---

## 2. Semantic Color System & Verified Contrast

Consume via `tokens.dtcg.json` or `web/src/styles/theme.css` (`theme.css` root mirrors these exact Style #13 tokens):

| Semantic Role | CSS Custom Property | Obsidian Hex | Notes / Verified WCAG Ratio |
| :--- | :--- | :--- | :--- |
| **Canvas Background** | `--bg-canvas` / `--background` | `#09090B` | Primary viewport backdrop |
| **Elevated Surface** | `--bg-surface` / `--surface` | `#121318` | Cards, bottom bar, drawers, Aux Pane |
| **Subtle / Nested Well** | `--bg-subtle` | `#0F1013` | Code blocks, terminal wells, nested rows |
| **Raised Surface** | `--bg-elevated` | `#181A22` | Active tabs, hover pills, modal sheets |
| **Primary Text** | `--text-primary` / `--foreground` | `#F4F4F5` | `16.88:1` on surface · `18.10:1` on canvas |
| **Muted / Secondary Text** | `--text-muted` / `--muted-foreground` | `#A1A1AA` | Metadata, captions, secondary labels |
| **Primary Action** | `--accent-primary` / `--primary` | `#10B981` | Primary CTA fill & active state |
| **Primary Foreground** | `--accent-primary-fg` / `--primary-foreground` | `#041E16` | `6.88:1` against `--accent-primary` |
| **Secondary Accent** | `--accent-secondary` / `--accent` | `#38BDF8` | Live sync pulse, data links, info badges |
| **Border / Hairline** | `--border-default` / `--border` | `#27272A` | `1px` structural dividers & control outlines |
| **Strong Border / Style** | `--border-strong`, `--border-style` | `#5A5A5D`, `solid` | Active focus frames (`dashed` in `wireframe`) |
| **Status: Info** | `--status-info`, `-bg`, `-fg` | `#38BDF8` | Tier 1 workspace badge, info callouts |
| **Status: Warning / Hold** | `--status-warning`, `-bg`, `-fg` | `#F59E0B` | Hold countdown, Tier 2, battery guard |
| **Status: Danger / PANIC** | `--status-danger`, `-bg`, `-fg`, `-contrast` | `#EF4444` | `HOST_LOCKED`, Tier-3 block, PANIC switch |
| **Status: Success** | `--status-success`, `-bg`, `-fg` | `#10B981` | Passed checks, clean worktree, synced |
| **Git Diff Highlights** | `--diff-add-bg`/`-fg`, `--diff-del-bg`/`-fg` | `#34D399` / `#F87171` | File Change & Undo unified diff lines |

### Provider Badge Tokens (Slot for Custom Design Icons)
| Provider ID | CSS Token | Default Color | Design Team Slot |
| :--- | :--- | :--- | :--- |
| `antigravity` | `--provider-antigravity` | `#10B981` | Priority #1 orbital mark (`0G` native) |
| `claude_code` | `--provider-claude` | `#F59E0B` | Anthropic Claude Code adapter mark |
| `codex_cli` | `--provider-codex` | `#38BDF8` | OpenAI Codex CLI adapter mark |
| `grok_build` | `--provider-grok` | `#E4E4E7` | xAI Grok Build adapter mark |

---

## 3. Typography & Hierarchy

- **Display Typeface:** `Space Grotesk / Geist (700, -0.025em)` (`--font-display`)
- **Body Typeface:** `Inter / Geist Sans (400, 1.5)` (`--font-body`)
- **Monospace / Data Typeface:** `JetBrains Mono` (`--font-mono`)
- **Modular Scale Ratio:** `1.250 (Major Third)`
- **Minimum Mobile Font Size:** `12px` (`0.75rem`) for micro-badges/timestamps; `14px–16px` for body and inputs (prevent iOS auto-zoom on `input`/`textarea` focus).
- **Tabular Discipline:** Enforce `font-variant-numeric: tabular-nums` on WebSocket `seq`, countdown timers (`25.0s`), battery %, CPU/VRAM telemetry, and token budgets.

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
| `escalated` | Hold window expired -> `force_ask` returned | Card transitions cleanly to amber `"Escalated to Antigravity Native UI"` badge so user knows laptop state was preserved |
| `agent-turbo` | `agentGateMode == "agent_turbo"` | Header/Inbox pill shows `"Agent Turbo (Auto)"`; Tier 0–2 workspace tools auto-allow while Tier-3 secrets/destructive commands stay blocked |
| `offline-queued` | Phone offline / hotspot handoff | Prompt saved in IndexedDB outbox with `"Queued (Guarded by step # & HEAD sha)"` badge; auto-flushes on WS reconnect |
| `HOST_LOCKED` | PANIC button triggered | Persistent red banner across header (`HOST LOCKED — Hooks Denying All Writes`), unlock requires explicit reset/passkey |
| `ultra_sip` / `max_turbo` | Laptop Hardware Power gear (independent of Agent Gate!) | Distinct hardware power pill; selecting `Ultra-Sip` or `Max Turbo` locks manually (`Auto-Scale` off) and never flips when tasks start/finish |

---

## 6. Geometry, Motion & Custom Project Slot Guide

- **Outer Container Radius:** `16px` (`--radius-outer`) | **Inner Control Radius:** `10px` (`--radius-inner`)
- **Custom Project Icons & Styling Slots:** Each project card renders an optional `project.icon` (`clapperboard`, `terminal`, `cpu`, `folder`, or custom SVG/emoji slot) and `project.accentToken` so projects like **Video production** can receive bespoke iconography, typography accents, and glow treatments in `theme.css` without altering any API contract.
- **Motion Signature:** `140ms`–`240ms` `cubic-bezier(0.22, 1, 0.36, 1)` on `transform` and `opacity` only.
