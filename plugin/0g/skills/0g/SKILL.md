---
name: 0g
description: Manage the 0G multi-agent mobile remote, Desktop Aux Pane, hotspot-safe Cloudflare/Tailscale tunnel, adaptive backpack power governor, and multi-provider hooks.
---

# 0G — Zero-Weight Mobile Remote & Host Control

Use this skill when the user wants to pair their phone with Antigravity (or Claude Code, OpenAI Codex CLI, xAI Grok Build), start/inspect the Cloudflare or Tailscale tunnel, adjust the Windows Backpack Power Governor (`ultra_sip` / `auto_turbo`), manage phone-authored MCP tools, or open the Desktop Aux Pane.

## Opening the 0G Desktop Aux Pane

Link directly to the sidecar Aux Pane in your reply when helpful:
- [0G](sidecar://0g/0g-aux/)

The Aux Pane exposes:
1. **Tunnel & QR Pairing Card**: Live `*.trycloudflare.com` or `tailscale serve` HTTPS/WSS URL, 6-digit pairing code, and scannable SVG QR code.
2. **Backpack Power Governor**: Live battery %, AC/DC state, active gear (`ultra_sip`, `auto_turbo`, `balanced`, `max_turbo`, `low_battery_guard`), and `SetThreadExecutionState` keep-awake status.
3. **Pending Approvals & Phone Tools Summary**: Active 25-second hold approvals and registered `0g_mobile` tools.
4. **PANIC Host Lock**: Immediate `HOST_LOCKED` switch that blocks writes across all hooked agents and terminates spawned PTY/worker processes.

## Daemon & Tunnel Setup

- Local daemon binds strictly to `127.0.0.1:8790` (`python -m server.app`).
- Primary hotspot-safe tunnel: `cloudflared tunnel --url http://127.0.0.1:8790` (outbound HTTPS/WSS, works behind CGNAT / mobile hotspots).
- Secondary tunnel: `tailscale serve` for private tailnet devices.
- All pairing tokens and `bridge.token` secrets stay local (`~/.0g/data/`); egress logs and timelines are scrubbed by `EgressRedactor`.

## Multi-Provider Hooks

Use `GET /api/adapters/hook-configs` (or the **Host** tab in the 0G PWA) to copy hook snippets for:
- **Antigravity (Priority #1)**: `~/.gemini/antigravity/hooks.json` (or this native `plugin/0g` bundle)
- **Claude Code**: `~/.claude/settings.json`
- **OpenAI Codex CLI**: `~/.codex/hooks.json`
- **xAI Grok Build**: `~/.grok/hooks.json`
