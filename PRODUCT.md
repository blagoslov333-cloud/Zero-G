# Product Context — Zero-G (0G)

## 1. Subject & Audience
- **Product Name:** Zero-G (0G)
- **Subject / Domain:** Local-first mobile remote, always-on two-way WebSocket state relay, adaptive backpack laptop power governor, and phone-authored MCP tools for AI coding agents (Antigravity Priority #1, Claude Code, OpenAI Codex CLI, and xAI Grok Build).
- **Primary Audience:** Developers running intensive autonomous AI coding agent workflows on portable laptops (in transit, coffee shops, conferences, or walking with laptop in a backpack) who need untethered phone supervision, remote approval controls, and host hardware power management.
- **Core Job To Be Done:** Control, monitor, steer, and safely gate AI coding agents and laptop host power from a phone PWA over cellular/hotspots with zero cloud dependency and zero port forwarding.

## 2. Surface Modes
- **Operate (Primary Surface):** High-clarity, scannable density, predictable controls, and 44x44px minimum tap targets.
  - **Mobile PWA (`/`):** 390px-optimized 5-tab interface (`Projects & Feed`, `Inbox & Approvals`, `+ New Worker`, `Automations & Mobile Tools`, `Host Control & Vitals`) featuring persistent status bar (connection, battery %, power gear, theme selector, PANIC button) and tab navigation.
  - **Desktop Aux Pane (`/?view=auxpane`):** Compact single-column sidebar (320px–420px width) designed for Antigravity desktop sidecars, showing instant QR pairing, live battery/power state, pending approval counts, and one-tap PANIC host lock.
- **Persuade (Secondary Surface):** Open-source overview, clean scannable feature highlights, and interactive pairing cards displaying scannable SVG QR codes and 6-digit pairing PINs.
- **Read (Documentation & Audit):** Clear typography hierarchy, under 80 characters line measure, tabular numbers for telemetry, and collapsible unified diffs.

## 3. Core User Flows & States
Every view defines explicit visual behaviors across `default`, `loading`, `empty`, `error`, and `390px` mobile viewport layouts:

1. **Hotspot-Safe QR Pairing & PWA Installation:**
   - User starts local bridge (`127.0.0.1:8790`) and pairs outbound via Cloudflare Tunnel (`*.trycloudflare.com`) or Tailscale Serve.
   - User scans SVG QR code from desktop Aux Pane or enters 6-digit PIN on phone browser, creates an authenticated session, and uses Add-to-Home-Screen for full standalone PWA operation.
   - **States:**
     - `default`: Interactive pairing dialog with live QR code and PIN input.
     - `loading`: Shimmer skeleton card during tunnel negotiation.
     - `empty`: Prompt to launch local tunnel or enter manual bridge URL.
     - `error`: Inline warning alert on invalid pairing code with retry button.
     - `390px`: Full-width stacked layout with 48px touch-friendly number inputs.

2. **Decoupled Agent Gate Mode & Laptop Hardware Power Governance:**
   - **Agent Gate Mode:** Independent control between `Ask on Phone` (Mode A) and `Agent Turbo` (Mode B). In `Ask on Phone`, pending tool executions stream to the phone Inbox with a 25-second countdown bar, AST risk tier badges (Tier 0–3), command inspection, and 1-tap Approve, Edit & Approve (`overwrite` JSON drawer), Allow 30m, or Deny. In `Agent Turbo`, Tier 0–2 actions auto-approve while Tier 3 destructive operations remain strictly blocked.
   - **Laptop Hardware Power Gears:** 5 sticky hardware gears (`Ultra-Sip`, `Auto-Turbo`, `Balanced`, `Max Turbo`, `Low Battery Guard`). Tapping `Ultra-Sip` locks `manualGear` (`autoGovernorEnabled=False`) to enforce Windows power efficiency and processor throttling indefinitely until `Auto-Turbo` is explicitly selected.
   - **States:**
     - `default`: Live status badges in header and Inbox showing active Gate Mode and Hardware Gear.
     - `loading`: Tabular progress countdown bar (25.0s to 0.0s) for active holds.
     - `empty`: "All clear — zero pending approvals" card with last action timestamp.
     - `error`: Escalation warning badge ("Escalated to Antigravity Native UI") when hold timer expires.
     - `390px`: Edge-to-edge approval cards with sticky bottom action sheet.

3. **Phone-Authored MCP Tool Studio, PTY/Git Monitoring & PANIC Host Lock:**
   - **Mobile Tool Studio (`0g_mobile`):** Author and test custom `phone_js` or `host_command` tools on phone without restarting agents; agent queries live daemon via Stdio JSON-RPC 2.0.
   - **PTY & Git Monitoring:** Track terminal sessions, review file changes in the File Change & Undo Drawer with syntax-highlighted diffs, and revert individual files.
   - **PANIC Host Lock:** One-tap header button sets `HOST_LOCKED`, denies all active hooks, terminates child terminal processes, and locks workstation.
   - **States:**
     - `default`: 5-tab scrollable views with crisp 1px borders and live WebSocket updates.
     - `loading`: Smooth skeleton shimmers preserving card geometry (zero layout shift, CLS under 0.1).
     - `empty`: Helpful guidance cards with direct primary action buttons (e.g., "+ Create Tool").
     - `error`: High-contrast error banners with diagnostic details and reconnection actions.
     - `390px`: Zero horizontal scroll, minimum 44x44px touch targets, safe-area inset padding.

## 4. Technical & Platform Constraints
- **Backend Stack:** FastAPI + SQLite WAL + Win32 ctypes / Linux `/proc/meminfo` telemetry backend running locally on `127.0.0.1:8790`.
- **Frontend Stack:** React 19 + TypeScript + Vite Progressive Web App (PWA) with service worker offline caching and Web Push notifications.
- **Styling & Design Tokens:** Styled exclusively via color-agnostic semantic CSS custom properties (`web/src/styles/theme.css`, `tokens.dtcg.json`, `DESIGN.md`) providing slots ready for custom design skinning. Structural presets include baseline testing (`obsidian`), daylight outdoor testing (`outdoor`), and studio wireframe (`wireframe`). Zero hardcoded colors in React components.
- **Target Viewports:**
  - `390×844` (Mobile primary — iPhone / Android standard viewports)
  - `320–420px` (Antigravity Desktop Aux Pane `?view=auxpane` sidecar)
  - `1440×900` (Desktop widescreen monitoring)
- **Accessibility Target:** WCAG 2.2 AA compliant contrast (4.5:1 minimum text contrast, 3:1 minimum on all interactive elements), visible 2px focus rings, reduced-motion media query support, and tabular-nums formatting for telemetry and countdowns.
