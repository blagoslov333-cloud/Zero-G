# Product Context — Zero-G (0G)

## 1. Subject & Audience
- **Product Name:** Zero-G (0G)
- **Subject / Domain:** Local-first mobile remote, always-on two-way WebSocket state relay, adaptive backpack laptop power governor, and Antigravity Desktop IDE companion for autonomous AI coding agents (Antigravity Priority #1 native bridge, with multi-provider hook support).
- **Primary Audience:** Developers running intensive autonomous AI coding agent workflows on portable laptops (in transit, coffee shops, conferences, or walking with laptop in a backpack) who need untethered phone supervision, live conversation streaming, workspace code browsing, remote terminal execution, and host hardware power management.
- **Core Job To Be Done:** Control, monitor, steer, and safely gate Antigravity sessions and laptop host power from a phone PWA over cellular/hotspots with zero cloud dependency and zero port forwarding.

## 2. Surface Modes
- **Operate (Primary Surface):** High-clarity, scannable density, predictable controls, and 44x44px minimum tap targets.
  - **Mobile PWA (`/`):** 390px-optimized 4-tab interface (`Chat`, `Projects`, `Terminal`, `Laptop`) featuring persistent top bar (connection, agent permission mode, battery %, power gear, theme selector, PANIC button), Global Inline Permission Banner, and fixed bottom navigation.
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

2. **Antigravity Mobile Chat & Global Inline Permission Approvals:**
   - Real-time conversation streaming from local Antigravity sessions (`conversation_summaries.db`, `transcript.jsonl`, `agentapi.bat`).
   - Interactive timeline displaying user and assistant turns, collapsible Thinking sections, expandable Tool Calls, Subagents and Swarm transcripts, and rendered Artifacts (Markdown, HTML, images, code).
   - Bottom composer features `/` Slash Command picker (`/plan`, `/grill-me`, `/boost`, `/teamwork`, `/goal`, `/browser`, `/compact`, `/schedule`, `/learn`) and `@` File Mention autocomplete.
   - When an agent requests tool use in Mode A (`Ask on Phone`), the Global Inline Permission Banner appears across any active tab with a 25-second countdown bar, AST risk tier badges (Tier 0–3), command inspection, and one-tap Approve, Allow 30m, or Deny actions. In `Agent Turbo`, Tier 0–2 actions auto-approve while Tier 3 destructive operations remain strictly blocked.
   - **States:**
     - `default`: Live conversation feed with active status badges, collapsible thinking, and sticky composer.
     - `loading`: Tabular progress countdown bar (25.0s to 0.0s) for active holds, skeleton shimmer during transcript fetch.
     - `empty`: "No conversations found" card with "+ New Chat" action button.
     - `error`: Escalation warning badge ("Escalated to Antigravity Native UI") when hold timer expires, or inline error banner on API disconnect.
     - `390px`: Edge-to-edge chat feed with sticky composer and safe-area inset padding.

3. **Desktop-Style Project Workspaces, Remote Terminal & Laptop Host Governance:**
   - **Projects Workspace:** Real local workspace list (`C:\Users\...\F`, `scratch`) opening into a dedicated project view with Files & Code viewer (with "Ask Agent about `@file`" CTA), Git Changes & Diffs with 1-tap Revert, and Project Chats.
   - **Remote Terminal:** Working-directory selector, shortcut command chips (`git status`, `pytest`, `npm run build`), and secure laptop command execution (`POST /api/agy/terminal/exec`).
   - **Laptop Host Governance & Vitals:** Independent 5-gear Backpack Power Governor (`Ultra-Sip`, `Auto-Turbo`, `Balanced`, `Max Turbo`, `Low Battery Guard`), Antigravity Skills/Plugins/Rules inspection, hardware vitals (CPU, RAM, GPU, Disk, active ports), and PANIC Host Lock (`HOST_LOCKED`).
   - **States:**
     - `default`: 4-tab scrollable views with crisp 1px borders and live WebSocket updates.
     - `loading`: Smooth skeleton shimmers preserving card geometry (zero layout shift, CLS under 0.1).
     - `empty`: Helpful guidance cards with direct primary action buttons (e.g., "+ New Chat Here").
     - `error`: High-contrast error banners with diagnostic details and reconnection actions.
     - `390px`: Zero horizontal scroll, minimum 44x44px touch targets, safe-area inset padding.

## 4. Technical & Platform Constraints
- **Backend Stack:** FastAPI + SQLite WAL + Win32 ctypes / Linux `/proc/meminfo` telemetry backend + Antigravity Desktop Bridge (`conversation_summaries.db`, `transcript.jsonl`, `agentapi.bat`) running locally on `127.0.0.1:8790`.
- **Frontend Stack:** React 19 + TypeScript + Vite Progressive Web App (PWA) with service worker offline caching and Web Push notifications.
- **Styling & Design Tokens:** Styled exclusively via color-agnostic semantic CSS custom properties (`web/src/styles/theme.css`, `tokens.dtcg.json`, `DESIGN.md`) providing slots ready for custom design skinning. Structural presets include baseline testing (`obsidian`), daylight outdoor testing (`outdoor`), and studio wireframe (`wireframe`). Zero hardcoded colors in React components.
- **Target Viewports:**
  - `390×844` (Mobile primary — iPhone / Android standard viewports)
  - `320–420px` (Antigravity Desktop Aux Pane `?view=auxpane` sidecar)
  - `1440×900` (Desktop widescreen monitoring)
- **Accessibility Target:** WCAG 2.2 AA compliant contrast (4.5:1 minimum text contrast, 3:1 minimum on all interactive elements), visible 2px focus rings, reduced-motion media query support, and tabular-nums formatting for telemetry and countdowns.
