# Contributing to 0G

Thanks for helping build **0G**! This repository is structured so backend adapters, Windows host controls, Antigravity plugin packaging, and the React PWA stay cleanly decoupled.

## Project Layout

- `server/contracts.py` — Shared Pydantic v2 schemas across daemon, adapters, MCP, hooks, and PWA.
- `server/app.py`, `server/db.py`, `server/security.py`, `server/rules_engine.py`, `server/auth.py` — Local FastAPI bridge (`127.0.0.1:8790`), SQLite WAL store, secret redaction, Tier-3 rules, and pairing/WebAuthn/Web Push auth.
- `server/adapters/` — Multi-provider adapters (`antigravity.py` Priority #1, `claude_code.py`, `codex_cli.py`, `grok_build.py`).
- `server/mobile_tools.py` & `server/mcp_server.py` — Phone-authored tool registry + pure-stdio JSON-RPC 2.0 MCP server.
- `server/power_governor.py`, `server/host_control.py`, `server/pty_mux.py`, `server/git_ops.py`, `server/tunnel.py` — Zero-psutil Win32 host telemetry, Job Object PTY, `GIT_OPTIONAL_LOCKS=0` worktree manager, and Cloudflare/Tailscale tunnel + QR SVG generator.
- `hooks/shim.py` & `bin/hook.cmd` — Pure-stdlib hook shim (`python -I -S`).
- `plugin/0g/` — Self-contained native Antigravity plugin bundle (hooks, MCP config, rules, skills, and `0g-aux` sidecar).
- `web/` — React + TypeScript + Vite mobile PWA and Desktop Aux Pane (`?view=auxpane`).

## Development Checks

Run Python compilation, the E2E pytest suite, and the frontend production build before opening a pull request:

```powershell
python -m py_compile server/*.py server/adapters/*.py hooks/shim.py plugin/0g/hooks/shim.py
python -m pytest tests/test_0g_e2e.py -v
npm --prefix web ci
npm --prefix web run build
```

## Coding & Security Rules

1. **Never emit `print()` to stdout** in `hooks/shim.py` or `server/mcp_server.py` (stdout is reserved strictly for JSON hook output or JSON-RPC 2.0 frames).
2. **Never bind the local daemon to `0.0.0.0`** — keep HTTP/WS bound strictly to `127.0.0.1`, exposed externally only through authenticated Cloudflare Tunnel or Tailscale Serve.
3. **Never put raw hex colors in `.tsx` components** — add tokens to `tokens.dtcg.json` and `web/src/styles/theme.css` per `DESIGN.md`.
4. **Always pass `GIT_OPTIONAL_LOCKS=0`** for read-only git polling to prevent `.git/index.lock` contention with running agents.
