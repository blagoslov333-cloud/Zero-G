"""0G Core Bridge Daemon FastAPI application (strictly bound to 127.0.0.1:8790)."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import platform
import shutil
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from server.auth import AuthManager
from server.contracts import (
    ApprovalDecisionRequest,
    ApprovalItem,
    AutomationItem,
    HookDecisionResponse,
    HookEventPayload,
    HostGlanceSnapshot,
    MacroShortcut,
    MobileToolCreateRequest,
    MobileToolInvocationRequest,
    MobileToolResultRequest,
    MobileToolSpec,
    PowerGearUpdateRequest,
    ProjectSummary,
    RuleEntry,
    SessionSummary,
    SteeringMessageRequest,
    TimelineStep,
    WorktreeTaskRequest,
)
from server.db import ZeroGDatabase
from server.rules_engine import RulesEngine
from server.security import EgressRedactor

# Defensive optional imports for sibling Wave-1 modules
try:
    from server import adapters as _adapters_mod
except Exception:
    _adapters_mod = None  # type: ignore[assignment]

try:
    from server import mobile_tools as _mobile_tools_mod
except Exception:
    _mobile_tools_mod = None  # type: ignore[assignment]

try:
    from server import power_governor as _power_gov_mod
except Exception:
    _power_gov_mod = None  # type: ignore[assignment]

try:
    from server import host_control as _host_ctrl_mod
except Exception:
    _host_ctrl_mod = None  # type: ignore[assignment]

try:
    from server import pty_mux as _pty_mux_mod
except Exception:
    _pty_mux_mod = None  # type: ignore[assignment]

try:
    from server import git_ops as _git_ops_mod
except Exception:
    _git_ops_mod = None  # type: ignore[assignment]

try:
    from server import tunnel as _tunnel_mod
except Exception:
    _tunnel_mod = None  # type: ignore[assignment]


BUILTIN_MOBILE_TOOLS: list[dict[str, Any]] = [
    {
        "id": "builtin-phone-notify-card",
        "name": "phone_notify_card",
        "description": "Render a rich notification card and optional chime on the connected 0G phone PWA.",
        "runtime": "phone_builtin",
        "parametersSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Notification title"},
                "body": {"type": "string", "description": "Notification body text"},
                "severity": {"type": "string", "enum": ["info", "success", "warning", "danger"]},
            },
            "required": ["title", "body"],
        },
        "code": "return { displayed: true, title: args.title };",
        "requiresApproval": False,
        "enabled": True,
    },
    {
        "id": "builtin-phone-ask-input",
        "name": "phone_ask_input",
        "description": "Prompt the user on their phone for text input or a quick choice button and return their reply.",
        "runtime": "phone_builtin",
        "parametersSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "Prompt question shown on phone"},
                "choices": {"type": "array", "items": {"type": "string"}, "description": "Optional quick choices"},
            },
            "required": ["question"],
        },
        "code": "return { answer: args.choices ? args.choices[0] : 'Confirmed from phone' };",
        "requiresApproval": False,
        "enabled": True,
    },
    {
        "id": "builtin-phone-read-clipboard",
        "name": "phone_read_clipboard",
        "description": "Read current clipboard text from the active mobile PWA session.",
        "runtime": "phone_builtin",
        "parametersSchema": {"type": "object", "properties": {}, "required": []},
        "code": "return { clipboard: await navigator.clipboard.readText() };",
        "requiresApproval": True,
        "enabled": True,
    },
    {
        "id": "builtin-phone-capture-photo",
        "name": "phone_capture_photo",
        "description": "Request a camera snapshot or image upload from the phone camera/picker.",
        "runtime": "phone_builtin",
        "parametersSchema": {
            "type": "object",
            "properties": {"label": {"type": "string", "description": "What to capture"}},
            "required": [],
        },
        "code": "return { captured: true };",
        "requiresApproval": True,
        "enabled": True,
    },
    {
        "id": "builtin-phone-get-location",
        "name": "phone_get_location",
        "description": "Request browser Geolocation coordinates (lat/lng) from the phone with permission.",
        "runtime": "phone_builtin",
        "parametersSchema": {"type": "object", "properties": {}, "required": []},
        "code": "return { lat: 0, lng: 0 };",
        "requiresApproval": True,
        "enabled": True,
    },
    {
        "id": "builtin-phone-speak-tts",
        "name": "phone_speak_tts",
        "description": "Speak a short status message aloud on the phone using the Web Speech API.",
        "runtime": "phone_builtin",
        "parametersSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "Message to speak"}},
            "required": ["text"],
        },
        "code": "return { spoken: true, text: args.text };",
        "requiresApproval": False,
        "enabled": True,
    },
]

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]", "testserver"}
_OPEN_API_PATHS = {"/api/health", "/api/pairing/claim", "/api/push/vapid-public-key"}


async def _maybe_await(val: Any) -> Any:
    if inspect.isawaitable(val):
        return await val
    return val


def _instantiate_safely(cls: Any, **candidate_kwargs: Any) -> Any:
    """Instantiate a sibling class by matching its __init__ parameters dynamically."""
    if cls is None:
        return None
    try:
        sig = inspect.signature(cls.__init__)
        params = sig.parameters
        accepts_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
        filtered: dict[str, Any] = {}
        for k, v in candidate_kwargs.items():
            if k in params or accepts_var_kw:
                filtered[k] = v
        return cls(**filtered)
    except Exception:
        try:
            return cls()
        except Exception:
            return None


def _fallback_qr_svg(text: str, size: int = 200) -> str:
    """Deterministic crisp matrix SVG fallback if TunnelSupervisor QR helper is not loaded yet."""
    if _tunnel_mod is not None:
        for fn_name in ("generate_qr_svg", "render_qr_svg", "qr_svg"):
            fn = getattr(_tunnel_mod, fn_name, None)
            if callable(fn):
                try:
                    return str(fn(text))
                except Exception:
                    pass
    n = 21
    grid = [[0] * n for _ in range(n)]

    def _draw_finder(r0: int, c0: int) -> None:
        for r in range(7):
            for c in range(7):
                if r in (0, 6) or c in (0, 6) or (2 <= r <= 4 and 2 <= c <= 4):
                    grid[r0 + r][c0 + c] = 1

    _draw_finder(0, 0)
    _draw_finder(0, n - 7)
    _draw_finder(n - 7, 0)
    for i in range(8, n - 8):
        grid[6][i] = (i + 1) % 2
        grid[i][6] = (i + 1) % 2

    digest = text.encode("utf-8")
    bit_idx = 0
    for r in range(n):
        for c in range(n):
            if (r < 9 and c < 9) or (r < 9 and c >= n - 8) or (r >= n - 8 and c < 9) or r == 6 or c == 6:
                continue
            b = digest[(bit_idx // 8) % len(digest)]
            grid[r][c] = (b >> (7 - (bit_idx % 8))) & 1
            bit_idx += 1

    rects: list[str] = []
    for r in range(n):
        for c in range(n):
            if grid[r][c]:
                rects.append(f'<rect x="{c + 2}" y="{r + 2}" width="1" height="1" fill="currentColor"/>')
    body = "".join(rects)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n + 4} {n + 4}" '
        f'width="{size}" height="{size}" shape-rendering="crispEdges" role="img" aria-label="0G Pairing QR">'
        f'<rect width="{n + 4}" height="{n + 4}" fill="transparent"/>{body}</svg>'
    )


class ZeroGState:
    """Central runtime state coordinating DB, Auth, Rules, WebSockets, Holds, and Wave-1 Sibling Modules."""

    def __init__(self, data_dir: Path, db_path: Path) -> None:
        self.data_dir = data_dir
        self.db = ZeroGDatabase(db_path)
        self.redactor = EgressRedactor()
        self.auth = AuthManager(data_dir=data_dir, db=self.db)
        self.rules_engine = RulesEngine(self.db)

        # Ensure bridge.token is also mirrored to default ~/.0g/data/bridge.token for hooks/shim.py discovery
        try:
            default_dir = Path.home() / ".0g" / "data"
            default_dir.mkdir(parents=True, exist_ok=True)
            default_tok_path = default_dir / "bridge.token"
            if default_tok_path != self.auth.token_path:
                default_tok_path.write_text(self.auth.get_bridge_token(), encoding="utf-8")
        except Exception:
            pass

        self.host_locked: bool = bool(self.db.get_kv("host_locked", False))
        self.ws_clients: set[WebSocket] = set()
        self.pending_approval_events: dict[str, asyncio.Event] = {}
        self.pending_mobile_tool_calls: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.active_worker_tasks: dict[str, tuple[asyncio.Task[Any], asyncio.Event]] = {}

        self.mobile_tool_registry: Any = None
        self.power_governor: Any = None
        self.host_telemetry: Any = None
        self.pty_mux: Any = None
        self.git_manager: Any = None
        self.tunnel_supervisor: Any = None

        self._seed_builtin_mobile_tools()
        self._bind_sibling_modules()

    def _seed_builtin_mobile_tools(self) -> None:
        existing_names = {t.name for t in self.db.list_mobile_tools()}
        now = time.time()
        for spec_dict in BUILTIN_MOBILE_TOOLS:
            if spec_dict["name"] not in existing_names:
                tool = MobileToolSpec(
                    createdAt=now,
                    updatedAt=now,
                    **spec_dict,
                )
                self.db.upsert_mobile_tool(tool)

    def _bind_sibling_modules(self) -> None:
        global _adapters_mod, _mobile_tools_mod, _power_gov_mod, _host_ctrl_mod, _pty_mux_mod, _git_ops_mod, _tunnel_mod
        if _adapters_mod is None:
            try:
                from server import adapters as _adapters_mod  # type: ignore[no-redef]
            except Exception:
                pass
        if _mobile_tools_mod is None:
            try:
                from server import mobile_tools as _mobile_tools_mod  # type: ignore[no-redef]
            except Exception:
                pass
        if _power_gov_mod is None:
            try:
                from server import power_governor as _power_gov_mod  # type: ignore[no-redef]
            except Exception:
                pass
        if _host_ctrl_mod is None:
            try:
                from server import host_control as _host_ctrl_mod  # type: ignore[no-redef]
            except Exception:
                pass
        if _pty_mux_mod is None:
            try:
                from server import pty_mux as _pty_mux_mod  # type: ignore[no-redef]
            except Exception:
                pass
        if _git_ops_mod is None:
            try:
                from server import git_ops as _git_ops_mod  # type: ignore[no-redef]
            except Exception:
                pass
        if _tunnel_mod is None:
            try:
                from server import tunnel as _tunnel_mod  # type: ignore[no-redef]
            except Exception:
                pass

        if self.mobile_tool_registry is None and _mobile_tools_mod is not None:
            cls = getattr(_mobile_tools_mod, "MobileToolRegistry", None)
            self.mobile_tool_registry = _instantiate_safely(cls, db=self.db, rules_engine=self.rules_engine)

        if self.power_governor is None and _power_gov_mod is not None:
            cls = getattr(_power_gov_mod, "BackpackPowerGovernor", None)
            self.power_governor = _instantiate_safely(cls, db=self.db)

        if self.host_telemetry is None and _host_ctrl_mod is not None:
            cls = getattr(_host_ctrl_mod, "HostTelemetry", None)
            self.host_telemetry = _instantiate_safely(cls, power_governor=self.power_governor)

        if self.pty_mux is None and _pty_mux_mod is not None:
            cls = getattr(_pty_mux_mod, "JobObjectPtyMux", None)
            self.pty_mux = _instantiate_safely(cls, on_output=self._on_pty_output)

        if self.git_manager is None and _git_ops_mod is not None:
            cls = getattr(_git_ops_mod, "GitManager", None)
            self.git_manager = _instantiate_safely(cls)

        if self.tunnel_supervisor is None and _tunnel_mod is not None:
            cls = getattr(_tunnel_mod, "TunnelSupervisor", None)
            self.tunnel_supervisor = _instantiate_safely(cls, local_port=8790, port=8790)

    def _on_pty_output(self, session_id: str, chunk: str) -> None:
        safe_chunk, _ = self.redactor.redact(chunk)
        self.db.emit_event(
            "pty.output",
            {"sessionId": session_id, "ptySessionId": session_id, "data": safe_chunk, "chunk": safe_chunk},
            session_id=session_id,
        )

    def get_public_url(self) -> str:
        t_status = self.get_tunnel_status()
        pub = t_status.get("publicUrl")
        if isinstance(pub, str) and pub.startswith("http"):
            return pub
        return "http://127.0.0.1:8790"

    def get_power_state(self) -> dict[str, Any]:
        self._bind_sibling_modules()
        if self.power_governor is not None:
            for m_name in ("get_state", "status", "snapshot"):
                fn = getattr(self.power_governor, m_name, None)
                if callable(fn):
                    try:
                        res = fn()
                        if isinstance(res, dict):
                            return res
                        if hasattr(res, "model_dump"):
                            return res.model_dump()
                    except Exception:
                        pass
        saved = self.db.get_kv("power_state")
        if isinstance(saved, dict):
            return saved
        return {
            "powerGear": "ultra_sip",
            "autoGovernorEnabled": True,
            "keepAwakeActive": False,
            "displayOffRequested": False,
            "lowBatteryThreshold": 15,
            "autoHibernateAtThreshold": False,
            "batteryPercent": 100,
            "acPluggedIn": True,
        }

    def get_tunnel_status(self) -> dict[str, Any]:
        self._bind_sibling_modules()
        raw_status: dict[str, Any] = {}
        if self.tunnel_supervisor is not None:
            for m_name in ("get_status", "status"):
                fn = getattr(self.tunnel_supervisor, m_name, None)
                if callable(fn):
                    try:
                        res = fn()
                        if isinstance(res, dict):
                            raw_status = dict(res)
                            break
                        if hasattr(res, "model_dump"):
                            raw_status = res.model_dump()
                            break
                    except Exception:
                        pass

        cf_bin = bool(shutil.which("cloudflared"))
        ts_bin = bool(shutil.which("tailscale"))
        pub_url = str(raw_status.get("publicUrl") or "http://127.0.0.1:8790")
        cf_avail = bool(raw_status.get("cloudflaredInstalled", raw_status.get("cloudflaredAvailable", cf_bin)))
        ts_avail = bool(raw_status.get("tailscaleInstalled", raw_status.get("tailscaleAvailable", ts_bin)))

        return {
            "backend": raw_status.get("backend", "local_only"),
            "status": raw_status.get("status", "running"),
            "publicUrl": pub_url,
            "localUrl": raw_status.get("localUrl", "http://127.0.0.1:8790"),
            "cloudflaredAvailable": cf_avail,
            "cloudflaredInstalled": cf_avail,
            "tailscaleAvailable": ts_avail,
            "tailscaleInstalled": ts_avail,
            "installHint": raw_status.get("installHint", "winget install Cloudflare.cloudflared"),
            **raw_status,
        }

    def render_qr_svg(self, text: str) -> str:
        self._bind_sibling_modules()
        if self.tunnel_supervisor is not None:
            for m_name in ("generate_qr_svg", "render_qr_svg", "get_qr_svg"):
                fn = getattr(self.tunnel_supervisor, m_name, None)
                if callable(fn):
                    try:
                        return str(fn(text))
                    except Exception:
                        pass
        return _fallback_qr_svg(text)


def _extract_auth_token_from_headers_or_query(headers: Any, query_params: Any) -> str | None:
    return (
        headers.get("X-0G-Bridge-Token")
        or headers.get("X-0G-Token")
        or headers.get("Authorization")
        or query_params.get("token")
    )


def _is_non_loopback_or_auth_forced(host_header: str | None) -> bool:
    if os.environ.get("ZEROG_REQUIRE_AUTH") == "1":
        return True
    if not host_header:
        return False
    hostname = host_header.split(":", 1)[0].strip().lower()
    return hostname not in _LOOPBACK_HOSTS


def _require_local_token(request: Request, state: ZeroGState) -> None:
    token = _extract_auth_token_from_headers_or_query(request.headers, request.query_params)
    if not state.auth.verify_local_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized: valid local bridge.token required")


def create_app(
    data_dir: str | Path | None = None,
    db_path: str | Path | None = None,
) -> FastAPI:
    resolved_data_dir = Path(
        data_dir or os.environ.get("ZEROG_DATA_DIR", Path.home() / ".0g" / "data")
    )
    resolved_data_dir.mkdir(parents=True, exist_ok=True)
    resolved_db_path = Path(db_path) if db_path else (resolved_data_dir / "0g.sqlite3")

    state = ZeroGState(data_dir=resolved_data_dir, db_path=resolved_db_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state._bind_sibling_modules()
        if state.power_governor is not None and hasattr(state.power_governor, "start"):
            try:
                await _maybe_await(state.power_governor.start())
            except Exception:
                pass
        yield
        for _, (task, ev) in list(state.active_worker_tasks.items()):
            ev.set()
            task.cancel()
        if state.power_governor is not None and hasattr(state.power_governor, "stop"):
            try:
                await _maybe_await(state.power_governor.stop())
            except Exception:
                pass
        if state.tunnel_supervisor is not None and hasattr(state.tunnel_supervisor, "stop"):
            try:
                await _maybe_await(state.tunnel_supervisor.stop())
            except Exception:
                pass
        if state.pty_mux is not None and hasattr(state.pty_mux, "terminate_all"):
            try:
                await _maybe_await(state.pty_mux.terminate_all())
            except Exception:
                pass

    app = FastAPI(
        title="0G Local-First Mobile & Host Bridge Daemon",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.state.zerog = state

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:8790",
            "http://localhost:8790",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
        ],
        allow_origin_regex=r"^https://[a-zA-Z0-9-]+\.(?:trycloudflare\.com|ts\.net)$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def non_loopback_auth_middleware(request: Request, call_next: Any) -> Response:
        path = request.url.path
        if path.startswith("/api/") and path not in _OPEN_API_PATHS:
            if _is_non_loopback_or_auth_forced(request.headers.get("host")):
                tok = _extract_auth_token_from_headers_or_query(request.headers, request.query_params)
                if not state.auth.verify_mobile_token(tok):
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "Unauthorized: valid mobile session token or bridge.token required"},
                    )
        return await call_next(request)

    # -------------------------------------------------------------------------
    # Health & Status
    # -------------------------------------------------------------------------

    @app.get("/api/health")
    async def api_health() -> dict[str, Any]:
        seq = state.db.latest_seq()
        return {
            "ok": True,
            "service": "0G Bridge Daemon",
            "host": "127.0.0.1",
            "port": 8790,
            "seq": seq,
            "lastSeq": seq,
            "hostLocked": state.host_locked,
            "auditChainValid": state.db.verify_audit_chain(),
            "ts": time.time(),
        }

    @app.get("/api/status")
    async def api_status() -> dict[str, Any]:
        pairing = state.auth.get_active_pairing(public_url=state.get_public_url())
        qr_svg = state.render_qr_svg(pairing["pairingUrl"])
        seq = state.db.latest_seq()
        return {
            "ok": True,
            "seq": seq,
            "lastSeq": seq,
            "hostLocked": state.host_locked,
            "connectedClients": len(state.ws_clients),
            "pendingApprovals": len(state.db.list_approvals(status="pending")),
            "activeSessions": len(
                [s for s in state.db.list_sessions() if s.status in ("running", "waiting_approval")]
            ),
            "mobileToolsCount": len(state.db.list_mobile_tools()),
            "power": state.get_power_state(),
            "tunnel": {
                **state.get_tunnel_status(),
                "qrSvg": qr_svg,
            },
            "pairing": {
                **pairing,
                "pairUrl": pairing["pairingUrl"],
                "url": pairing["pairingUrl"],
                "qrSvg": qr_svg,
            },
            "vapidPublicKey": state.auth.get_vapid_public_key(),
            "auditChainValid": state.db.verify_audit_chain(),
            "ts": time.time(),
        }

    # -------------------------------------------------------------------------
    # Pairing, WebAuthn & Web Push
    # -------------------------------------------------------------------------

    @app.post("/api/pairing/code")
    async def api_pairing_code(request: Request) -> dict[str, Any]:
        body: dict[str, Any] = {}
        try:
            body = await request.json()
        except Exception:
            pass
        public_url = str(body.get("publicUrl") or state.get_public_url())
        ttl_sec = int(body.get("ttlSec") or 300)
        record = state.auth.issue_pairing_code(ttl_sec=ttl_sec, public_url=public_url)
        qr_svg = state.render_qr_svg(record["pairingUrl"])
        return {
            **record,
            "pairUrl": record["pairingUrl"],
            "url": record["pairingUrl"],
            "qrSvg": qr_svg,
            "svg": qr_svg,
        }

    @app.post("/api/pairing/claim")
    async def api_pairing_claim(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")
        code_or_token = str(body.get("code") or body.get("qrToken") or body.get("token") or "").strip()
        device_name = str(body.get("deviceName") or "0G Mobile PWA")
        claimed = state.auth.claim_pairing_code(code_or_token, device_name=device_name)
        if not claimed:
            raise HTTPException(status_code=401, detail="Invalid, expired, or already claimed pairing code")
        state.db.emit_event("pairing.claimed", {"deviceName": device_name, "ts": time.time()})
        return {
            **claimed,
            "token": claimed["sessionToken"],
            "sessionToken": claimed["sessionToken"],
        }

    @app.get("/api/pairing/qr")
    async def api_pairing_qr(format: str | None = Query(default=None)) -> Response:
        record = state.auth.get_active_pairing(public_url=state.get_public_url())
        qr_svg = state.render_qr_svg(record["pairingUrl"])
        if format == "svg":
            return Response(content=qr_svg, media_type="image/svg+xml")
        return JSONResponse(
            {
                **record,
                "url": record["pairingUrl"],
                "pairUrl": record["pairingUrl"],
                "qrSvg": qr_svg,
                "svg": qr_svg,
            }
        )

    @app.post("/api/auth/webauthn/options")
    async def api_webauthn_options(request: Request) -> dict[str, Any]:
        body: dict[str, Any] = {}
        try:
            body = await request.json()
        except Exception:
            pass
        mode = str(body.get("mode") or "authenticate")
        tx_context = body.get("txContext") if isinstance(body.get("txContext"), dict) else body
        return state.auth.create_webauthn_options(mode=mode, tx_context=tx_context)

    @app.post("/api/auth/webauthn/verify")
    async def api_webauthn_verify(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")
        tx_context = body.get("txContext") if isinstance(body.get("txContext"), dict) else None
        result = state.auth.verify_webauthn_assertion(body, tx_context=tx_context)
        if not result.get("verified"):
            raise HTTPException(status_code=400, detail=result.get("error", "WebAuthn verification failed"))
        return result

    @app.post("/api/push/subscribe")
    async def api_push_subscribe(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")
        endpoint = str(body.get("endpoint") or f"https://push.0g.local/{uuid.uuid4().hex[:12]}")
        state.db.upsert_push_subscription(endpoint, body)
        return {
            "ok": True,
            "endpoint": endpoint,
            "vapidPublicKey": state.auth.get_vapid_public_key(),
        }

    @app.get("/api/push/vapid-public-key")
    async def api_vapid_public_key() -> dict[str, Any]:
        return {"publicKey": state.auth.get_vapid_public_key()}

    # -------------------------------------------------------------------------
    # Hooks Dispatch (Mode A: 25s Hold & Escalation, Steering Drain, HOST_LOCKED)
    # -------------------------------------------------------------------------

    @app.post("/api/hooks/dispatch")
    async def api_hooks_dispatch(request: Request) -> dict[str, Any]:
        _require_local_token(request, state)
        try:
            raw_body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON hook payload")

        provider_hint = str(raw_body.get("provider") or "antigravity")
        payload: HookEventPayload | None = None
        state._bind_sibling_modules()
        if _adapters_mod is not None and "hookEventName" not in raw_body:
            get_adapter_fn = getattr(_adapters_mod, "get_adapter", None)
            if callable(get_adapter_fn):
                try:
                    adapter = get_adapter_fn(provider_hint)
                    if adapter and hasattr(adapter, "normalize_hook_input"):
                        payload = adapter.normalize_hook_input(raw_body)
                except Exception:
                    payload = None

        if payload is None:
            if "hookEventName" not in raw_body:
                raw_body["hookEventName"] = (
                    raw_body.get("hook_event_name")
                    or raw_body.get("event")
                    or "PreToolUse"
                )
            if "conversationId" not in raw_body:
                raw_body["conversationId"] = (
                    raw_body.get("session_id")
                    or raw_body.get("sessionId")
                    or "default"
                )
            if "toolCall" not in raw_body and (raw_body.get("tool_name") or raw_body.get("toolName")):
                t_name = raw_body.get("tool_name") or raw_body.get("toolName")
                t_in = raw_body.get("tool_input") or raw_body.get("toolInput") or {}
                raw_body["toolCall"] = {
                    "id": raw_body.get("tool_use_id") or f"tc-{uuid.uuid4().hex[:8]}",
                    "name": t_name,
                    "arguments": t_in if isinstance(t_in, dict) else {"input": t_in},
                }
            payload = HookEventPayload.model_validate(raw_body)

        now = time.time()
        session_id = payload.conversationId or "default"
        event_name = payload.hookEventName

        session = state.db.get_session(session_id)
        cwd = payload.cwd or (payload.workspacePaths[0] if payload.workspacePaths else str(Path.cwd()))
        proj_name = Path(cwd).name if cwd else "Workspace"
        proj_id = f"proj-{proj_name.lower().replace(' ', '-')}"
        is_new_session = session is None
        if session is None:
            session = SessionSummary(
                id=session_id,
                title=f"{payload.provider.replace('_', ' ').title()} Session ({proj_name})",
                projectId=proj_id,
                projectName=proj_name,
                provider=payload.provider,
                source="desktop_hook",
                status="running",
                cwd=cwd,
                stepIdx=payload.stepIdx or 0,
                transcriptPath=payload.transcriptPath,
                artifactDirectoryPath=payload.artifactDirectoryPath,
                createdAt=now,
                updatedAt=now,
            )
        else:
            session.updatedAt = now
            if payload.stepIdx is not None:
                session.stepIdx = payload.stepIdx
            if payload.transcriptPath:
                session.transcriptPath = payload.transcriptPath
            if payload.artifactDirectoryPath:
                session.artifactDirectoryPath = payload.artifactDirectoryPath
            if payload.cwd:
                session.cwd = payload.cwd

        # Check HOST_LOCKED panic invariant first!
        if state.host_locked:
            session.status = "cancelled"
            state.db.upsert_session(session)
            state.db.emit_event(
                "host.locked",
                {"hostLocked": True, "event": event_name, "sessionId": session_id},
                session_id=session_id,
                provider=payload.provider,
            )
            return HookDecisionResponse(
                decision="deny",
                reason="HOST_LOCKED: 0G Panic Lock is active on host",
                terminationBehavior="terminate",
            ).model_dump()

        # 1. SessionStart
        if event_name == "SessionStart":
            session.status = "running"
            state.db.upsert_session(session)
            if state.power_governor is not None and hasattr(state.power_governor, "notify_job_started"):
                try:
                    await _maybe_await(state.power_governor.notify_job_started(session_id))
                except Exception:
                    pass
            state.db.emit_event(
                "session.created" if is_new_session else "session.updated",
                session.model_dump(),
                session_id=session_id,
                provider=payload.provider,
            )
            return HookDecisionResponse(decision="ok").model_dump()

        # 2. PreInvocation
        if event_name == "PreInvocation":
            session.status = "running"
            if payload.lastUserInput:
                clean_input, was_redacted = state.redactor.redact(payload.lastUserInput)
                session.title = clean_input[:72] or session.title
                session.stepIdx += 1
                step = TimelineStep(
                    id=f"step-{uuid.uuid4().hex[:10]}",
                    sessionId=session_id,
                    stepIdx=session.stepIdx,
                    role="user",
                    content=clean_input,
                    redacted=was_redacted,
                    ts=now,
                )
                state.db.add_timeline_step(step)
                state.db.emit_event(
                    "timeline.step",
                    step.model_dump(),
                    session_id=session_id,
                    provider=payload.provider,
                )
            state.db.upsert_session(session)
            state.db.emit_event(
                "session.updated",
                session.model_dump(),
                session_id=session_id,
                provider=payload.provider,
            )

            inject_steps: list[dict[str, Any]] = []
            if not payload.continuationActive:
                steered = state.db.pop_pending_steering(session_id)
                if steered:
                    inject_steps = [{"role": "user", "content": item["message"]} for item in steered]
                    state.db.emit_event(
                        "steering.consumed",
                        {"sessionId": session_id, "count": len(steered), "items": steered},
                        session_id=session_id,
                        provider=payload.provider,
                    )
            return HookDecisionResponse(decision="ok", injectSteps=inject_steps).model_dump()

        # 3. PreToolUse (AST Risk Engine + 25s Hold + Phone Approval / Escalation)
        if event_name == "PreToolUse":
            tool_call = payload.toolCall or {}
            tool_name = str(tool_call.get("name") or tool_call.get("toolName") or "run_command")
            tool_call_id = str(tool_call.get("id") or f"tc-{uuid.uuid4().hex[:8]}")
            raw_args = (
                tool_call.get("arguments")
                or tool_call.get("args")
                or tool_call.get("input")
                or {}
            )
            if not isinstance(raw_args, dict):
                raw_args = {"input": raw_args}

            eval_res = state.rules_engine.evaluate(
                tool_name=tool_name,
                args=raw_args,
                cwd=session.cwd,
                provider=payload.provider,
                workspace_roots=payload.workspacePaths or ([session.cwd] if session.cwd else None),
            )
            clean_preview, prev_redacted = state.redactor.redact(eval_res["commandPreview"])
            clean_args = state.redactor.redact_dict(raw_args)

            session.stepIdx += 1
            t_step = TimelineStep(
                id=f"step-{uuid.uuid4().hex[:10]}",
                sessionId=session_id,
                stepIdx=session.stepIdx,
                role="tool",
                content=clean_preview,
                toolName=tool_name,
                toolArgs=clean_args,
                redacted=prev_redacted,
                ts=now,
            )
            state.db.add_timeline_step(t_step)
            state.db.emit_event(
                "timeline.step",
                t_step.model_dump(),
                session_id=session_id,
                provider=payload.provider,
            )

            auto_dec = eval_res["autoDecision"]
            if auto_dec == "deny":
                denied_item = ApprovalItem(
                    id=f"appr-{uuid.uuid4().hex[:10]}",
                    sessionId=session_id,
                    provider=payload.provider,
                    toolName=tool_name,
                    toolCallId=tool_call_id,
                    rawArgs=clean_args,
                    commandPreview=clean_preview,
                    astSummary=eval_res["astSummary"],
                    riskTier=eval_res["riskTier"],
                    riskReasons=eval_res["riskReasons"],
                    status="auto_denied",
                    holdSeconds=0,
                    createdAt=now,
                    expiresAt=now,
                    resolvedAt=now,
                    resolvedBy=eval_res["ruleId"] or "rules_engine",
                )
                state.db.upsert_approval(denied_item)
                state.db.upsert_session(session)
                state.db.append_audit(
                    actor="rules_engine",
                    action="pre_tool_auto_denied",
                    details={"approvalId": denied_item.id, "toolName": tool_name, "riskTier": eval_res["riskTier"]},
                )
                state.db.emit_event(
                    "approval.updated",
                    denied_item.model_dump(),
                    session_id=session_id,
                    provider=payload.provider,
                )
                reason_str = "; ".join(eval_res["riskReasons"]) or "Blocked by 0G Tier-3 security rule"
                return HookDecisionResponse(decision="deny", reason=reason_str).model_dump()

            if auto_dec == "allow":
                allowed_item = ApprovalItem(
                    id=f"appr-{uuid.uuid4().hex[:10]}",
                    sessionId=session_id,
                    provider=payload.provider,
                    toolName=tool_name,
                    toolCallId=tool_call_id,
                    rawArgs=clean_args,
                    commandPreview=clean_preview,
                    astSummary=eval_res["astSummary"],
                    riskTier=eval_res["riskTier"],
                    riskReasons=eval_res["riskReasons"],
                    status="auto_allowed",
                    holdSeconds=0,
                    createdAt=now,
                    expiresAt=now,
                    resolvedAt=now,
                    resolvedBy=eval_res["ruleId"] or "rules_engine",
                )
                state.db.upsert_approval(allowed_item)
                state.db.upsert_session(session)
                state.db.emit_event(
                    "approval.updated",
                    allowed_item.model_dump(),
                    session_id=session_id,
                    provider=payload.provider,
                )
                return HookDecisionResponse(
                    decision="allow",
                    reason=f"Auto-allowed by 0G rule ({eval_res['ruleId']})",
                ).model_dump()

            hold_override = (
                request.headers.get("X-0G-Hold-Seconds")
                or raw_body.get("holdSeconds")
                or os.environ.get("ZEROG_HOLD_SECONDS")
            )
            try:
                hold_sec_float = float(hold_override) if hold_override is not None else 25.0
            except Exception:
                hold_sec_float = 25.0
            hold_sec_int = max(1, int(round(hold_sec_float)))

            approval = ApprovalItem(
                id=f"appr-{uuid.uuid4().hex[:10]}",
                sessionId=session_id,
                provider=payload.provider,
                toolName=tool_name,
                toolCallId=tool_call_id,
                rawArgs=clean_args,
                commandPreview=clean_preview,
                astSummary=eval_res["astSummary"],
                riskTier=eval_res["riskTier"],
                riskReasons=eval_res["riskReasons"],
                status="pending",
                holdSeconds=hold_sec_int,
                createdAt=now,
                expiresAt=now + hold_sec_float,
            )
            state.db.upsert_approval(approval)
            session.status = "waiting_approval"
            state.db.upsert_session(session)

            wait_event = asyncio.Event()
            state.pending_approval_events[approval.id] = wait_event

            state.db.emit_event(
                "approval.created",
                approval.model_dump(),
                session_id=session_id,
                provider=payload.provider,
            )
            state.db.emit_event(
                "session.updated",
                session.model_dump(),
                session_id=session_id,
                provider=payload.provider,
            )

            state.auth.send_push_notification(
                title=f"0G Tier-{approval.riskTier} Approval Needed",
                body=f"{tool_name} awaiting tap ({hold_sec_int}s hold)",
                tag=f"approval-{approval.id}",
                data={
                    "approvalId": approval.id,
                    "sessionId": session_id,
                    "riskTier": approval.riskTier,
                    "eventType": "approval.created",
                },
            )

            try:
                await asyncio.wait_for(wait_event.wait(), timeout=hold_sec_float)
            except asyncio.TimeoutError:
                latest = state.db.get_approval(approval.id) or approval
                if latest.status == "pending":
                    latest.status = "escalated"
                    latest.resolvedAt = time.time()
                    latest.resolvedBy = "timeout_escalation"
                    state.db.upsert_approval(latest)
                    session.status = "running"
                    state.db.upsert_session(session)
                    state.db.emit_event(
                        "approval.escalated",
                        latest.model_dump(),
                        session_id=session_id,
                        provider=payload.provider,
                    )
                    return HookDecisionResponse(
                        decision="force_ask",
                        reason="Escalated from 0G inbox",
                    ).model_dump()
            finally:
                state.pending_approval_events.pop(approval.id, None)

            resolved = state.db.get_approval(approval.id) or approval
            session.status = "running"
            state.db.upsert_session(session)

            if state.host_locked or resolved.status == "denied":
                return HookDecisionResponse(
                    decision="deny",
                    reason="Denied from 0G mobile inbox",
                    terminationBehavior="terminate" if state.host_locked else "",
                ).model_dump()

            if resolved.status == "edited_approved":
                return HookDecisionResponse(
                    decision="allow",
                    reason="Approved with edited arguments from 0G mobile inbox",
                    overwrite=resolved.overwriteArgs,
                ).model_dump()

            return HookDecisionResponse(
                decision="allow",
                reason="Approved from 0G mobile inbox",
            ).model_dump()

        # 4. PostToolUse
        if event_name == "PostToolUse":
            session.status = "running"
            state.db.upsert_session(session)
            state.db.emit_event(
                "session.updated",
                session.model_dump(),
                session_id=session_id,
                provider=payload.provider,
            )
            return HookDecisionResponse(decision="ok").model_dump()

        # 5. PostInvocation / Stop
        if event_name in ("PostInvocation", "Stop"):
            if not payload.continuationActive:
                steered = state.db.pop_pending_steering(session_id)
                if steered:
                    inject_steps = [{"role": "user", "content": item["message"]} for item in steered]
                    state.db.emit_event(
                        "steering.consumed",
                        {"sessionId": session_id, "count": len(steered), "items": steered},
                        session_id=session_id,
                        provider=payload.provider,
                    )
                    return HookDecisionResponse(
                        decision="continue",
                        injectSteps=inject_steps,
                        terminationBehavior="force_continue",
                    ).model_dump()

            session.status = "idle" if event_name == "PostInvocation" else "completed"
            state.db.upsert_session(session)
            if state.power_governor is not None and hasattr(state.power_governor, "notify_job_finished"):
                try:
                    await _maybe_await(state.power_governor.notify_job_finished(session_id))
                except Exception:
                    pass
            state.db.emit_event(
                "session.updated",
                session.model_dump(),
                session_id=session_id,
                provider=payload.provider,
            )
            return HookDecisionResponse(decision="ok").model_dump()

        return HookDecisionResponse(decision="ok").model_dump()

    # -------------------------------------------------------------------------
    # Projects, Sessions, Timeline & Mode B Worktree Spawn
    # -------------------------------------------------------------------------

    @app.get("/api/projects")
    async def api_projects() -> list[dict[str, Any]]:
        state._bind_sibling_modules()
        projects_by_name: dict[str, ProjectSummary] = {}

        seeded = state.db.get_kv("seeded_projects", [])
        if isinstance(seeded, list):
            for p in seeded:
                try:
                    model = ProjectSummary.model_validate(p)
                    projects_by_name[model.name.lower()] = model
                except Exception:
                    continue

        if _adapters_mod is not None:
            all_adapters_fn = getattr(_adapters_mod, "all_adapters", None)
            if callable(all_adapters_fn):
                try:
                    for adapter in all_adapters_fn():
                        if hasattr(adapter, "discover_projects"):
                            for p in adapter.discover_projects():
                                model = p if isinstance(p, ProjectSummary) else ProjectSummary.model_validate(p)
                                key = model.name.lower()
                                if key not in projects_by_name:
                                    projects_by_name[key] = model
                except Exception:
                    pass

        scratch_dir = Path(r"C:\Users\blagoslov333\.gemini\antigravity\scratch")
        if scratch_dir.is_dir():
            for child in sorted(scratch_dir.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    key = child.name.lower()
                    if key not in projects_by_name:
                        projects_by_name[key] = ProjectSummary(
                            id=f"proj-{key.replace(' ', '-')}",
                            name=child.name,
                            path=str(child),
                            icon="clapperboard" if "video" in key else "folder",
                            accentToken="--accent-secondary" if "video" in key else "--accent-primary",
                            providerHint="antigravity",
                            isSeededDemo=False,
                        )

        sessions = state.db.list_sessions()
        for proj in projects_by_name.values():
            proj.activeSessions = sum(
                1
                for s in sessions
                if (s.projectId == proj.id or s.projectName.lower() == proj.name.lower())
                and s.status in ("running", "waiting_approval", "idle")
            )

        return [p.model_dump() for p in projects_by_name.values()]

    @app.get("/api/sessions")
    async def api_sessions(projectId: str | None = Query(default=None)) -> list[dict[str, Any]]:
        return [s.model_dump() for s in state.db.list_sessions(project_id=projectId)]

    @app.get("/api/sessions/{session_id}/timeline")
    async def api_session_timeline(session_id: str) -> dict[str, Any]:
        session = state.db.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")

        state._bind_sibling_modules()
        artifacts: list[dict[str, Any]] = []
        if _adapters_mod is not None:
            get_adapter_fn = getattr(_adapters_mod, "get_adapter", None)
            if callable(get_adapter_fn):
                try:
                    adapter = get_adapter_fn(session.provider)
                    if session.transcriptPath and hasattr(adapter, "tail_transcript"):
                        existing_steps = state.db.get_timeline(session_id)
                        max_idx = max((s.stepIdx for s in existing_steps), default=-1)
                        new_steps = adapter.tail_transcript(session.transcriptPath, after_step=max_idx)
                        for st in new_steps:
                            st_model = st if isinstance(st, TimelineStep) else TimelineStep.model_validate(st)
                            st_model.sessionId = session_id
                            clean_content, was_red = state.redactor.redact(st_model.content)
                            st_model.content = clean_content
                            st_model.redacted = st_model.redacted or was_red
                            state.db.add_timeline_step(st_model)
                    if session.artifactDirectoryPath and hasattr(adapter, "list_artifacts"):
                        artifacts = adapter.list_artifacts(session.artifactDirectoryPath)
                except Exception:
                    pass

        steps = [s.model_dump() for s in state.db.get_timeline(session_id)]
        return {
            "session": session.model_dump(),
            "steps": steps,
            "artifacts": artifacts,
        }

    @app.post("/api/sessions/spawn")
    async def api_sessions_spawn(req: WorktreeTaskRequest) -> dict[str, Any]:
        if state.host_locked:
            raise HTTPException(status_code=423, detail="HOST_LOCKED: Cannot spawn worker while Panic Lock is active")

        now = time.time()
        session_id = f"worker-{uuid.uuid4().hex[:10]}"
        projects = await api_projects()
        matched_proj = next(
            (p for p in projects if p["id"] == req.projectId or p["name"].lower() == req.projectId.lower()),
            None,
        )
        project_name = matched_proj["name"] if matched_proj else req.projectId
        project_path = matched_proj["path"] if matched_proj else str(Path.cwd())
        if not os.path.isdir(project_path):
            project_path = str(Path(r"C:\Users\blagoslov333\.gemini\antigravity\scratch\0G"))

        worktree_path: str | None = None
        worktree_branch: str | None = None
        git_head_sha: str | None = None

        state._bind_sibling_modules()
        if state.git_manager is not None:
            try:
                if hasattr(state.git_manager, "get_head_sha"):
                    git_head_sha = await _maybe_await(state.git_manager.get_head_sha(project_path))
                if req.useWorktree and hasattr(state.git_manager, "create_worktree"):
                    branch = f"0g-task-{session_id[-6:]}"
                    wt_res = await _maybe_await(state.git_manager.create_worktree(project_path, branch))
                    if isinstance(wt_res, dict):
                        worktree_path = wt_res.get("worktreePath") or wt_res.get("path")
                        worktree_branch = wt_res.get("branch") or branch
                    elif isinstance(wt_res, str) and wt_res:
                        worktree_path = wt_res
                        worktree_branch = branch
            except Exception:
                pass

        effective_cwd = worktree_path or project_path
        clean_prompt, was_redacted = state.redactor.redact(req.prompt)
        session = SessionSummary(
            id=session_id,
            title=req.title or clean_prompt[:64] or "Mobile Worktree Task",
            projectId=matched_proj["id"] if matched_proj else req.projectId,
            projectName=project_name,
            provider=req.provider,
            source="phone_worker",
            status="running",
            cwd=effective_cwd,
            worktreePath=worktree_path,
            worktreeBranch=worktree_branch,
            stepIdx=1,
            gitHeadSha=git_head_sha,
            createdAt=now,
            updatedAt=now,
        )
        state.db.upsert_session(session)

        user_step = TimelineStep(
            id=f"step-{uuid.uuid4().hex[:10]}",
            sessionId=session_id,
            stepIdx=1,
            role="user",
            content=clean_prompt,
            redacted=was_redacted,
            ts=now,
        )
        state.db.add_timeline_step(user_step)

        if state.power_governor is not None and hasattr(state.power_governor, "notify_job_started"):
            try:
                await _maybe_await(state.power_governor.notify_job_started(session_id))
            except Exception:
                pass

        state.db.emit_event("session.created", session.model_dump(), session_id=session_id, provider=req.provider)
        state.db.emit_event("timeline.step", user_step.model_dump(), session_id=session_id, provider=req.provider)

        cancel_event = asyncio.Event()

        async def _worker_runner() -> None:
            try:
                ran_via_adapter = False
                if _adapters_mod is not None:
                    get_adapter_fn = getattr(_adapters_mod, "get_adapter", None)
                    if callable(get_adapter_fn):
                        adapter = get_adapter_fn(req.provider)
                        if adapter and hasattr(adapter, "run_worker"):
                            ran_via_adapter = True

                            async def _on_step(role: str, content: str, tool_name: str | None = None, tool_args: dict[str, Any] | None = None) -> None:
                                s = state.db.get_session(session_id) or session
                                s.stepIdx += 1
                                s.updatedAt = time.time()
                                clean_c, red = state.redactor.redact(str(content))
                                st = TimelineStep(
                                    id=f"step-{uuid.uuid4().hex[:10]}",
                                    sessionId=session_id,
                                    stepIdx=s.stepIdx,
                                    role=role if role in ("user", "assistant", "thought", "tool", "system", "error") else "assistant",  # type: ignore[arg-type]
                                    content=clean_c,
                                    toolName=tool_name,
                                    toolArgs=state.redactor.redact_dict(tool_args) if tool_args else None,
                                    redacted=red,
                                    ts=s.updatedAt,
                                )
                                state.db.add_timeline_step(st)
                                state.db.upsert_session(s)
                                state.db.emit_event("timeline.step", st.model_dump(), session_id=session_id, provider=req.provider)

                            async def _on_token(usage: dict[str, int]) -> None:
                                s = state.db.get_session(session_id) or session
                                s.promptTokens = int(usage.get("promptTokens", s.promptTokens))
                                s.thoughtsTokens = int(usage.get("thoughtsTokens", s.thoughtsTokens))
                                s.totalTokens = int(usage.get("totalTokens", s.promptTokens + s.thoughtsTokens))
                                s.updatedAt = time.time()
                                state.db.upsert_session(s)
                                state.db.emit_event(
                                    "timeline.token",
                                    {
                                        "sessionId": session_id,
                                        "promptTokens": s.promptTokens,
                                        "thoughtsTokens": s.thoughtsTokens,
                                        "totalTokens": s.totalTokens,
                                    },
                                    session_id=session_id,
                                    provider=req.provider,
                                )
                                state.db.emit_event("session.updated", s.model_dump(), session_id=session_id, provider=req.provider)

                            await adapter.run_worker(
                                session_id=session_id,
                                cwd=effective_cwd,
                                prompt=req.prompt,
                                model=req.model,
                                on_step=_on_step,
                                on_token=_on_token,
                                cancel_event=cancel_event,
                                budget_tokens=req.maxTokensBudget,
                            )

                if not ran_via_adapter and not cancel_event.is_set():
                    await asyncio.sleep(0.15)
                    if not cancel_event.is_set():
                        s = state.db.get_session(session_id) or session
                        s.stepIdx += 1
                        s.promptTokens = max(64, len(clean_prompt.split()) * 4)
                        s.thoughtsTokens = 48
                        s.totalTokens = s.promptTokens + s.thoughtsTokens
                        s.updatedAt = time.time()
                        reply = TimelineStep(
                            id=f"step-{uuid.uuid4().hex[:10]}",
                            sessionId=session_id,
                            stepIdx=s.stepIdx,
                            role="assistant",
                            content=f"[{req.provider}] Worker executed task in {effective_cwd}: {clean_prompt[:120]}",
                            ts=s.updatedAt,
                        )
                        state.db.add_timeline_step(reply)
                        state.db.upsert_session(s)
                        state.db.emit_event("timeline.step", reply.model_dump(), session_id=session_id, provider=req.provider)

                final_sess = state.db.get_session(session_id) or session
                if cancel_event.is_set():
                    final_sess.status = "cancelled"
                elif final_sess.status == "running":
                    final_sess.status = "completed"
                final_sess.updatedAt = time.time()
                state.db.upsert_session(final_sess)
                state.db.emit_event("session.updated", final_sess.model_dump(), session_id=session_id, provider=req.provider)
            except asyncio.CancelledError:
                final_sess = state.db.get_session(session_id) or session
                final_sess.status = "cancelled"
                final_sess.updatedAt = time.time()
                state.db.upsert_session(final_sess)
                state.db.emit_event("session.updated", final_sess.model_dump(), session_id=session_id, provider=req.provider)
            except Exception as exc:
                final_sess = state.db.get_session(session_id) or session
                final_sess.status = "error"
                final_sess.updatedAt = time.time()
                state.db.upsert_session(final_sess)
                state.db.emit_event(
                    "session.updated",
                    final_sess.model_dump(),
                    session_id=session_id,
                    provider=req.provider,
                )
            finally:
                state.active_worker_tasks.pop(session_id, None)
                if state.power_governor is not None and hasattr(state.power_governor, "notify_job_finished"):
                    try:
                        await _maybe_await(state.power_governor.notify_job_finished(session_id))
                    except Exception:
                        pass

        task = asyncio.create_task(_worker_runner())
        state.active_worker_tasks[session_id] = (task, cancel_event)
        return session.model_dump()

    @app.post("/api/sessions/{session_id}/steer")
    async def api_session_steer(session_id: str, req: SteeringMessageRequest) -> dict[str, Any]:
        session = state.db.get_session(session_id)
        if session is not None:
            if req.expectedStepIdx is not None and session.stepIdx != req.expectedStepIdx:
                raise HTTPException(
                    status_code=409,
                    detail=f"Stale stepIdx guard: expected {req.expectedStepIdx}, current is {session.stepIdx}",
                )
            if req.expectedGitHeadSha is not None and session.gitHeadSha and session.gitHeadSha != req.expectedGitHeadSha:
                raise HTTPException(
                    status_code=409,
                    detail=f"Stale gitHeadSha guard: expected {req.expectedGitHeadSha}, current is {session.gitHeadSha}",
                )

        clean_msg, _ = state.redactor.redact(req.message)
        queued = state.db.queue_steering(session_id, clean_msg, client_msg_id=req.clientMsgId)
        state.db.emit_event(
            "steering.queued",
            queued,
            session_id=session_id,
            provider=session.provider if session else "antigravity",
        )
        return {"ok": True, **queued}

    @app.post("/api/sessions/{session_id}/cancel")
    async def api_session_cancel(session_id: str) -> dict[str, Any]:
        worker_entry = state.active_worker_tasks.get(session_id)
        if worker_entry:
            task, cancel_ev = worker_entry
            cancel_ev.set()
            task.cancel()

        session = state.db.get_session(session_id)
        if session:
            session.status = "cancelled"
            session.updatedAt = time.time()
            state.db.upsert_session(session)
            state.db.emit_event(
                "session.updated",
                session.model_dump(),
                session_id=session_id,
                provider=session.provider,
            )
        if state.power_governor is not None and hasattr(state.power_governor, "notify_job_finished"):
            try:
                await _maybe_await(state.power_governor.notify_job_finished(session_id))
            except Exception:
                pass
        return {"ok": True, "sessionId": session_id, "status": "cancelled"}

    # -------------------------------------------------------------------------
    # Approvals & Rules
    # -------------------------------------------------------------------------

    @app.get("/api/approvals")
    async def api_list_approvals(status: str | None = Query(default=None)) -> list[dict[str, Any]]:
        return [a.model_dump() for a in state.db.list_approvals(status=status)]

    @app.post("/api/approvals/{approval_id}/decide")
    async def api_decide_approval(approval_id: str, req: ApprovalDecisionRequest) -> dict[str, Any]:
        approval = state.db.get_approval(approval_id)
        if approval is None:
            raise HTTPException(status_code=404, detail=f"Approval '{approval_id}' not found")

        if approval.riskTier >= 3 and req.action != "deny":
            raise HTTPException(status_code=403, detail="Tier-3 self-protection blocks cannot be overridden")

        now = time.time()
        created_rule: RuleEntry | None = None

        if req.action == "edit_approve":
            if not req.overwriteArgs:
                raise HTTPException(status_code=400, detail="overwriteArgs required for edit_approve")
            re_eval = state.rules_engine.evaluate(
                tool_name=approval.toolName,
                args=req.overwriteArgs,
                provider=approval.provider,
            )
            if re_eval["riskTier"] >= 3 or re_eval["autoDecision"] == "deny":
                raise HTTPException(
                    status_code=403,
                    detail=f"Edited arguments rejected by Tier-3 RulesEngine: {'; '.join(re_eval['riskReasons'])}",
                )
            approval.status = "edited_approved"
            approval.overwriteArgs = req.overwriteArgs
            approval.commandPreview, _ = state.redactor.redact(re_eval["commandPreview"])
        elif req.action == "allow_30m":
            try:
                created_rule = state.rules_engine.create_scoped_temp_grant(
                    tool_name=approval.toolName,
                    command_preview=approval.commandPreview,
                    provider=approval.provider,
                    duration_sec=1800,
                )
                state.db.emit_event("rule.updated", created_rule.model_dump())
            except ValueError as exc:
                raise HTTPException(status_code=403, detail=str(exc))
            approval.status = "approved"
        elif req.action == "approve":
            approval.status = "approved"
        else:
            approval.status = "denied"

        approval.resolvedAt = now
        approval.resolvedBy = "mobile_user"
        state.db.upsert_approval(approval)
        state.db.append_audit(
            actor="mobile_user",
            action=f"approval_{req.action}",
            details={"approvalId": approval.id, "toolName": approval.toolName, "status": approval.status},
        )
        state.db.emit_event(
            "approval.resolved",
            approval.model_dump(),
            session_id=approval.sessionId,
            provider=approval.provider,
        )

        wait_ev = state.pending_approval_events.get(approval_id)
        if wait_ev is not None:
            wait_ev.set()

        out: dict[str, Any] = {"ok": True, "approval": approval.model_dump()}
        if created_rule is not None:
            out["temporaryRule"] = created_rule.model_dump()
        return out

    @app.get("/api/rules")
    async def api_list_rules() -> list[dict[str, Any]]:
        return [r.model_dump() for r in state.db.list_rules()]

    @app.post("/api/rules")
    async def api_upsert_rule(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON rule payload")
        if "id" not in body or not body["id"]:
            body["id"] = f"rule-{uuid.uuid4().hex[:8]}"
        rule = RuleEntry.model_validate(body)
        state.db.upsert_rule(rule)
        state.db.append_audit("mobile_user", "rule_upserted", {"ruleId": rule.id, "action": rule.action})
        state.db.emit_event("rule.updated", rule.model_dump())
        return rule.model_dump()

    @app.delete("/api/rules/{rule_id}")
    async def api_delete_rule_path(rule_id: str) -> dict[str, Any]:
        if rule_id == "rule-tier3-self-protect":
            raise HTTPException(status_code=403, detail="Cannot delete core Tier-3 self-protection rule")
        deleted = state.db.delete_rule(rule_id)
        if deleted:
            state.db.append_audit("mobile_user", "rule_deleted", {"ruleId": rule_id})
            state.db.emit_event("rule.updated", {"id": rule_id, "deleted": True})
        return {"ok": deleted, "id": rule_id}

    @app.delete("/api/rules")
    async def api_delete_rule_query(id: str = Query(...)) -> dict[str, Any]:
        return await api_delete_rule_path(id)

    # -------------------------------------------------------------------------
    # PANIC Host Lock & Offline Outbox
    # -------------------------------------------------------------------------

    @app.post("/api/panic")
    async def api_panic(request: Request) -> dict[str, Any]:
        body: dict[str, Any] = {}
        try:
            body = await request.json()
        except Exception:
            pass

        state.host_locked = True
        state.db.set_kv("host_locked", True)

        cancelled_workers: list[str] = []
        for sess_id, (task, ev) in list(state.active_worker_tasks.items()):
            ev.set()
            task.cancel()
            cancelled_workers.append(sess_id)

        denied_approvals: list[str] = []
        now = time.time()
        for appr in state.db.list_approvals(status="pending"):
            appr.status = "denied"
            appr.resolvedAt = now
            appr.resolvedBy = "panic_lock"
            state.db.upsert_approval(appr)
            denied_approvals.append(appr.id)
        for appr_id, wait_ev in list(state.pending_approval_events.items()):
            wait_ev.set()

        state._bind_sibling_modules()
        pty_terminated = False
        if state.pty_mux is not None and hasattr(state.pty_mux, "terminate_all"):
            try:
                await _maybe_await(state.pty_mux.terminate_all())
                pty_terminated = True
            except Exception:
                pass

        workstation_locked = False
        if body.get("lockWorkstation") is True and state.power_governor is not None:
            if hasattr(state.power_governor, "lock_workstation"):
                try:
                    await _maybe_await(state.power_governor.lock_workstation())
                    workstation_locked = True
                except Exception:
                    pass

        state.db.append_audit(
            actor="mobile_panic",
            action="panic_activated",
            details={
                "cancelledWorkers": cancelled_workers,
                "deniedApprovals": denied_approvals,
                "ptyTerminated": pty_terminated,
                "workstationLocked": workstation_locked,
            },
        )
        state.db.emit_event(
            "host.locked",
            {
                "hostLocked": True,
                "cancelledWorkers": cancelled_workers,
                "deniedApprovals": denied_approvals,
                "ptyTerminated": pty_terminated,
                "ts": now,
            },
        )
        return {
            "ok": True,
            "hostLocked": True,
            "cancelledWorkers": cancelled_workers,
            "deniedApprovals": denied_approvals,
            "ptyTerminated": pty_terminated,
            "workstationLocked": workstation_locked,
        }

    @app.post("/api/panic/unlock")
    async def api_panic_unlock(request: Request) -> dict[str, Any]:
        body: dict[str, Any] = {}
        try:
            body = await request.json()
        except Exception:
            pass

        assertion = body.get("webauthnAssertion")
        if isinstance(assertion, dict):
            ver = state.auth.verify_webauthn_assertion(assertion)
            if not ver.get("verified"):
                raise HTTPException(status_code=401, detail="WebAuthn passkey verification failed for unlock")

        state.host_locked = False
        state.db.set_kv("host_locked", False)
        state.db.append_audit("mobile_user", "panic_unlocked", {"hostLocked": False})
        state.db.emit_event("host.unlocked", {"hostLocked": False, "ts": time.time()})
        return {"ok": True, "hostLocked": False}

    @app.post("/api/outbox")
    async def api_outbox(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON outbox payload")

        session_id = str(body.get("sessionId") or "default")
        message = str(body.get("message") or "").strip()
        if not message:
            raise HTTPException(status_code=400, detail="message is required")
        client_msg_id = body.get("clientMsgId")
        expected_step = body.get("expectedStepIdx")
        expected_sha = body.get("expectedGitHeadSha")

        session = state.db.get_session(session_id)
        if session is not None:
            if expected_step is not None and int(expected_step) != int(session.stepIdx):
                return JSONResponse(
                    status_code=409,
                    content={
                        "ok": False,
                        "conflict": True,
                        "stale": True,
                        "reason": f"expectedStepIdx mismatch ({expected_step} != {session.stepIdx})",
                        "currentStepIdx": session.stepIdx,
                    },
                )
            current_sha = session.gitHeadSha
            if not current_sha and session.cwd and state.git_manager is not None and hasattr(state.git_manager, "get_head_sha"):
                try:
                    current_sha = await _maybe_await(state.git_manager.get_head_sha(session.cwd))
                except Exception:
                    current_sha = None
            if expected_sha and current_sha and str(expected_sha) != str(current_sha):
                return JSONResponse(
                    status_code=409,
                    content={
                        "ok": False,
                        "conflict": True,
                        "stale": True,
                        "reason": f"expectedGitHeadSha mismatch ({expected_sha} != {current_sha})",
                        "currentGitHeadSha": current_sha,
                    },
                )

        clean_msg, _ = state.redactor.redact(message)
        res = state.db.queue_steering(session_id, clean_msg, client_msg_id=client_msg_id)
        state.db.emit_event("outbox.flushed", res, session_id=session_id)
        return {"ok": True, "conflict": False, "stale": False, **res}

    # -------------------------------------------------------------------------
    # Phone-Authored Mobile Tools & MCP RPC Bridge
    # -------------------------------------------------------------------------

    @app.get("/api/mobile-tools")
    async def api_list_mobile_tools() -> list[dict[str, Any]]:
        state._bind_sibling_modules()
        if state.mobile_tool_registry is not None and hasattr(state.mobile_tool_registry, "list_tools"):
            try:
                tools = await _maybe_await(state.mobile_tool_registry.list_tools())
                return [t.model_dump() if hasattr(t, "model_dump") else t for t in tools]
            except Exception:
                pass
        return [t.model_dump() for t in state.db.list_mobile_tools()]

    @app.post("/api/mobile-tools")
    async def api_create_mobile_tool(req: MobileToolCreateRequest) -> dict[str, Any]:
        import re as _re

        clean_name = req.name.strip().lower().replace("-", "_").replace(" ", "_")
        if not _re.match(r"^[a-z][a-z0-9_]{1,48}$", clean_name):
            raise HTTPException(
                status_code=400,
                detail="Tool name must match ^[a-z][a-z0-9_]{1,48}$",
            )
        if req.runtime == "host_command" and req.code:
            eval_res = state.rules_engine.evaluate("run_command", {"command": req.code})
            if eval_res["riskTier"] >= 3 or eval_res["autoDecision"] == "deny":
                raise HTTPException(
                    status_code=403,
                    detail="Host command tool rejected by Tier-3 RulesEngine",
                )

        now = time.time()
        existing = state.db.get_mobile_tool_by_name(clean_name)
        schema = req.parametersSchema or {
            "type": "object",
            "properties": {"input": {"type": "string", "description": "Input parameter"}},
            "required": [],
        }
        tool = MobileToolSpec(
            id=existing.id if existing else f"mtool-{uuid.uuid4().hex[:8]}",
            name=clean_name,
            description=req.description,
            runtime=req.runtime,
            parametersSchema=schema,
            code=req.code,
            requiresApproval=req.requiresApproval,
            enabled=True,
            createdAt=existing.createdAt if existing else now,
            updatedAt=now,
        )
        state.db.upsert_mobile_tool(tool)
        state.db.append_audit("mobile_user", "mobile_tool_created", {"name": tool.name, "runtime": tool.runtime})
        state.db.emit_event("mobile_tool.updated", tool.model_dump())
        return tool.model_dump()

    @app.delete("/api/mobile-tools/{tool_id}")
    async def api_delete_mobile_tool(tool_id: str) -> dict[str, Any]:
        deleted = state.db.delete_mobile_tool(tool_id)
        if deleted:
            state.db.emit_event("mobile_tool.updated", {"id": tool_id, "deleted": True})
        return {"ok": deleted, "id": tool_id}

    @app.post("/api/mobile-tools/invoke")
    async def api_invoke_mobile_tool(req: MobileToolInvocationRequest) -> dict[str, Any]:
        if state.host_locked:
            raise HTTPException(status_code=423, detail="HOST_LOCKED: Mobile tool invocation blocked")

        tool = state.db.get_mobile_tool_by_name(req.toolName) or state.db.get_mobile_tool(req.toolName)
        if tool is None:
            raise HTTPException(status_code=404, detail=f"Mobile tool '{req.toolName}' not found")

        if tool.runtime == "host_command":
            cmd_template = tool.code or "echo ok"
            eval_res = state.rules_engine.evaluate("run_command", {"command": cmd_template})
            if eval_res["riskTier"] >= 3 or eval_res["autoDecision"] == "deny":
                return {
                    "ok": False,
                    "toolName": tool.name,
                    "error": f"Blocked by 0G RulesEngine: {'; '.join(eval_res['riskReasons'])}",
                }
            try:
                proc = await asyncio.create_subprocess_shell(
                    cmd_template,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=min(req.timeoutSec, 15.0))
                out_str, _ = state.redactor.redact(
                    (stdout_b.decode("utf-8", errors="replace") + stderr_b.decode("utf-8", errors="replace")).strip()
                )
                return {"ok": proc.returncode == 0, "toolName": tool.name, "result": {"output": out_str}}
            except Exception as exc:
                return {"ok": False, "toolName": tool.name, "error": str(exc)}

        ticket_id = f"mt-{uuid.uuid4().hex[:10]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        state.pending_mobile_tool_calls[ticket_id] = fut

        request_payload = {
            "ticketId": ticket_id,
            "toolId": tool.id,
            "toolName": tool.name,
            "runtime": tool.runtime,
            "code": tool.code,
            "arguments": state.redactor.redact_dict(req.arguments),
            "sessionId": req.sessionId,
            "ts": time.time(),
        }
        state.db.emit_event("mobile_tool_request", request_payload, session_id=req.sessionId)

        timeout_sec = max(0.2, min(float(req.timeoutSec or 18.0), 20.0))
        try:
            res = await asyncio.wait_for(fut, timeout=timeout_sec)
            return res
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "ticketId": ticket_id,
                "toolName": tool.name,
                "error": f"Timed out after {timeout_sec:.1f}s waiting for connected phone response",
            }
        finally:
            state.pending_mobile_tool_calls.pop(ticket_id, None)

    @app.post("/api/mobile-tools/result")
    async def api_mobile_tool_result(req: MobileToolResultRequest) -> dict[str, Any]:
        clean_result = state.redactor.redact_dict(req.result)
        clean_error, _ = state.redactor.redact(req.error or "")
        payload = {
            "ok": req.ok,
            "ticketId": req.ticketId,
            "result": clean_result,
            "error": clean_error or None,
        }
        fut = state.pending_mobile_tool_calls.get(req.ticketId)
        if fut is not None and not fut.done():
            fut.set_result(payload)
        state.db.emit_event("mobile_tool_response", payload)
        return payload

    # -------------------------------------------------------------------------
    # Host Glance, Power Governor, PTY Sessions, Automations & Macros
    # -------------------------------------------------------------------------

    @app.get("/api/host/glance")
    async def api_host_glance() -> dict[str, Any]:
        state._bind_sibling_modules()
        power = state.get_power_state()
        if state.host_telemetry is not None:
            for m_name in ("snapshot", "get_snapshot", "get_glance", "collect"):
                fn = getattr(state.host_telemetry, m_name, None)
                if callable(fn):
                    try:
                        snap = await _maybe_await(fn())
                        if hasattr(snap, "model_dump"):
                            d = snap.model_dump()
                        elif isinstance(snap, dict):
                            d = dict(snap)
                        else:
                            continue
                        d["hostLocked"] = state.host_locked
                        d["powerGear"] = power.get("powerGear", d.get("powerGear", "ultra_sip"))
                        return HostGlanceSnapshot.model_validate(d).model_dump()
                    except Exception:
                        pass

        disk = shutil.disk_usage(Path.cwd().anchor or "C:\\")
        snap = HostGlanceSnapshot(
            hostname=platform.node() or "windows-host",
            osVersion=f"{platform.system()} {platform.release()}",
            cpuPercent=8.5,
            ramUsedMb=8192,
            ramTotalMb=16384,
            diskFreeGb=round(disk.free / (1024**3), 2),
            diskTotalGb=round(disk.total / (1024**3), 2),
            batteryPercent=power.get("batteryPercent", 100),
            acPluggedIn=power.get("acPluggedIn", True),
            powerGear=power.get("powerGear", "ultra_sip"),
            autoGovernorEnabled=bool(power.get("autoGovernorEnabled", True)),
            keepAwakeActive=bool(power.get("keepAwakeActive", False)),
            displayOffRequested=bool(power.get("displayOffRequested", False)),
            lowBatteryThreshold=int(power.get("lowBatteryThreshold", 15)),
            hostLocked=state.host_locked,
            ts=time.time(),
        )
        return snap.model_dump()

    @app.post("/api/host/power-gear")
    async def api_host_power_gear(req: PowerGearUpdateRequest) -> dict[str, Any]:
        state._bind_sibling_modules()
        res_state: dict[str, Any] | None = None
        if state.power_governor is not None and hasattr(state.power_governor, "apply_gear"):
            try:
                applied = await _maybe_await(state.power_governor.apply_gear(req))
                if isinstance(applied, dict):
                    res_state = applied
                elif hasattr(applied, "model_dump"):
                    res_state = applied.model_dump()
            except Exception:
                res_state = None

        if res_state is None:
            current = state.get_power_state()
            if req.gear is not None:
                current["powerGear"] = req.gear
            if req.autoGovernorEnabled is not None:
                current["autoGovernorEnabled"] = req.autoGovernorEnabled
            if req.displayOff is not None:
                current["displayOffRequested"] = req.displayOff
            if req.lowBatteryThreshold is not None:
                current["lowBatteryThreshold"] = req.lowBatteryThreshold
            if req.autoHibernateAtThreshold is not None:
                current["autoHibernateAtThreshold"] = req.autoHibernateAtThreshold
            state.db.set_kv("power_state", current)
            res_state = current

        state.db.append_audit("mobile_user", "power_gear_updated", res_state)
        state.db.emit_event("power.gear", res_state)
        return {"ok": True, **res_state}

    @app.get("/api/pty/sessions")
    async def api_list_pty_sessions() -> list[dict[str, Any]]:
        state._bind_sibling_modules()
        if state.pty_mux is not None and hasattr(state.pty_mux, "list_sessions"):
            try:
                res = await _maybe_await(state.pty_mux.list_sessions())
                if isinstance(res, list):
                    return res
            except Exception:
                pass
        return []

    @app.post("/api/pty/sessions")
    async def api_create_pty_session(request: Request) -> dict[str, Any]:
        if state.host_locked:
            raise HTTPException(status_code=423, detail="HOST_LOCKED: Cannot spawn terminal session")
        body: dict[str, Any] = {}
        try:
            body = await request.json()
        except Exception:
            pass
        cwd_in = body.get("cwd")
        state._bind_sibling_modules()
        if state.pty_mux is not None and hasattr(state.pty_mux, "create_session"):
            sig = inspect.signature(state.pty_mux.create_session)
            kwargs: dict[str, Any] = {}
            if "cwd" in sig.parameters and cwd_in:
                kwargs["cwd"] = cwd_in
            res = await _maybe_await(state.pty_mux.create_session(**kwargs))
            if isinstance(res, dict):
                return res
            return {"sessionId": str(res), "cwd": cwd_in or str(Path.cwd())}
        return {"sessionId": f"pty-{uuid.uuid4().hex[:8]}", "cwd": cwd_in or str(Path.cwd()), "status": "running"}

    @app.get("/api/automations")
    async def api_list_automations() -> list[dict[str, Any]]:
        state._bind_sibling_modules()
        by_slug: dict[str, AutomationItem] = {}

        if _adapters_mod is not None:
            get_adapter_fn = getattr(_adapters_mod, "get_adapter", None)
            if callable(get_adapter_fn):
                try:
                    ag = get_adapter_fn("antigravity")
                    if ag and hasattr(ag, "discover_automations"):
                        for item in ag.discover_automations():
                            m = item if isinstance(item, AutomationItem) else AutomationItem.model_validate(item)
                            by_slug[m.slug] = m
                except Exception:
                    pass

        saved = state.db.get_kv("automations", [])
        if isinstance(saved, list):
            for item in saved:
                try:
                    m = AutomationItem.model_validate(item)
                    by_slug[m.slug] = m
                except Exception:
                    continue

        if not by_slug:
            default_auto = AutomationItem(
                slug="daily-worktree-health",
                name="Daily Worktree & Test Sanity Sweep",
                schedule="0 9 * * *",
                prompt="Run fast unit tests and summarize any uncommitted changes across active workspaces.",
                source="0g_macro",
                enabled=True,
            )
            by_slug[default_auto.slug] = default_auto

        return [a.model_dump() for a in by_slug.values()]

    @app.post("/api/automations")
    async def api_upsert_automation(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON automation payload")
        if not body.get("slug"):
            body["slug"] = str(body.get("name", "auto")).lower().replace(" ", "-")[:32]
        item = AutomationItem.model_validate(body)
        existing = await api_list_automations()
        updated = [a for a in existing if a["slug"] != item.slug] + [item.model_dump()]
        state.db.set_kv("automations", updated)
        state.db.emit_event("automation.updated", item.model_dump())
        return item.model_dump()

    @app.post("/api/automations/{slug}/run")
    async def api_run_automation(slug: str) -> dict[str, Any]:
        if state.host_locked:
            raise HTTPException(status_code=423, detail="HOST_LOCKED")
        autos = await api_list_automations()
        target = next((a for a in autos if a["slug"] == slug), None)
        if not target:
            raise HTTPException(status_code=404, detail=f"Automation '{slug}' not found")
        target["lastRunAt"] = time.time()
        state.db.set_kv("automations", autos)
        spawned = await api_sessions_spawn(
            WorktreeTaskRequest(
                projectId="proj-0g",
                provider="antigravity",
                prompt=target["prompt"],
                title=f"Automation: {target['name']}",
                useWorktree=False,
            )
        )
        return {"ok": True, "automation": target, "session": spawned}

    @app.get("/api/macros")
    async def api_list_macros() -> list[dict[str, Any]]:
        macros = state.db.get_kv("macros", [])
        return macros if isinstance(macros, list) else []

    @app.post("/api/macros")
    async def api_create_macro(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON macro payload")
        if not body.get("id"):
            body["id"] = f"macro-{uuid.uuid4().hex[:8]}"
        macro = MacroShortcut.model_validate(body)
        eval_res = state.rules_engine.evaluate("run_command", {"command": macro.command})
        if eval_res["riskTier"] >= 3 or eval_res["autoDecision"] == "deny":
            raise HTTPException(status_code=403, detail="Macro command rejected by Tier-3 RulesEngine")
        macros = await api_list_macros()
        macros = [m for m in macros if m.get("id") != macro.id] + [macro.model_dump()]
        state.db.set_kv("macros", macros)
        return macro.model_dump()

    @app.post("/api/macros/{macro_id}/run")
    async def api_run_macro(macro_id: str) -> dict[str, Any]:
        if state.host_locked:
            raise HTTPException(status_code=423, detail="HOST_LOCKED")
        macros = await api_list_macros()
        target = next((m for m in macros if m.get("id") == macro_id), None)
        if not target:
            raise HTTPException(status_code=404, detail=f"Macro '{macro_id}' not found")
        cmd = str(target.get("command") or "")
        cwd = target.get("cwd") or str(Path.cwd())

        eval_res = state.rules_engine.evaluate("run_command", {"command": cmd}, cwd=cwd)
        if eval_res["riskTier"] >= 3 or eval_res["autoDecision"] == "deny":
            raise HTTPException(status_code=403, detail="Macro blocked by Tier-3 RulesEngine")

        state._bind_sibling_modules()
        output = ""
        if state.pty_mux is not None and hasattr(state.pty_mux, "run_macro"):
            try:
                res = await _maybe_await(state.pty_mux.run_macro(cmd, cwd))
                output = res.get("output", str(res)) if isinstance(res, dict) else str(res)
            except Exception as exc:
                output = f"Macro error: {exc}"
        else:
            try:
                proc = await asyncio.create_subprocess_shell(
                    cmd,
                    cwd=cwd if os.path.isdir(str(cwd)) else None,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=10.0)
                output = (out_b.decode("utf-8", errors="replace") + err_b.decode("utf-8", errors="replace")).strip()
            except Exception as exc:
                output = str(exc)

        clean_out, _ = state.redactor.redact(output)
        state.db.emit_event(
            "pty.output",
            {"sessionId": macro_id, "ptySessionId": macro_id, "macroId": macro_id, "data": clean_out, "chunk": clean_out},
        )
        return {"ok": True, "macroId": macro_id, "output": clean_out}

    # -------------------------------------------------------------------------
    # Git Status, Diff, Revert & Worktree Merge / Discard
    # -------------------------------------------------------------------------

    def _resolve_repo_path(repo_path: str | None) -> str:
        if repo_path and os.path.isdir(repo_path):
            return repo_path
        scratch_0g = r"C:\Users\blagoslov333\.gemini\antigravity\scratch\0G"
        return scratch_0g if os.path.isdir(scratch_0g) else str(Path.cwd())

    @app.get("/api/git/status")
    async def api_git_status(
        repoPath: str | None = Query(default=None),
        path: str | None = Query(default=None),
    ) -> dict[str, Any]:
        target = _resolve_repo_path(repoPath or path)
        state._bind_sibling_modules()
        if state.git_manager is not None and hasattr(state.git_manager, "get_status"):
            try:
                res = await _maybe_await(state.git_manager.get_status(target))
                return res if isinstance(res, dict) else {"files": res, "repoPath": target}
            except Exception:
                pass
        env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
        try:
            proc = subprocess.run(
                ["git", "status", "--porcelain", "-b"],
                cwd=target,
                env=env,
                capture_output=True,
                text=True,
                timeout=4,
            )
            return {"ok": proc.returncode == 0, "repoPath": target, "raw": proc.stdout.strip()}
        except Exception as exc:
            return {"ok": False, "repoPath": target, "error": str(exc)}

    @app.get("/api/git/diff")
    async def api_git_diff(
        repoPath: str | None = Query(default=None),
        path: str | None = Query(default=None),
        filePath: str | None = Query(default=None),
        file: str | None = Query(default=None),
    ) -> dict[str, Any]:
        target = _resolve_repo_path(repoPath or path)
        target_file = filePath or file
        state._bind_sibling_modules()
        if state.git_manager is not None and hasattr(state.git_manager, "get_diff"):
            try:
                res = await _maybe_await(state.git_manager.get_diff(target, target_file))
                if isinstance(res, dict):
                    return res
                clean_diff, _ = state.redactor.redact(str(res))
                return {"ok": True, "repoPath": target, "filePath": target_file, "diff": clean_diff}
            except Exception:
                pass
        env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
        cmd = ["git", "diff"] + ([target_file] if target_file else [])
        try:
            proc = subprocess.run(cmd, cwd=target, env=env, capture_output=True, text=True, timeout=4)
            clean_diff, _ = state.redactor.redact(proc.stdout)
            return {"ok": proc.returncode == 0, "repoPath": target, "filePath": target_file, "diff": clean_diff}
        except Exception as exc:
            return {"ok": False, "repoPath": target, "error": str(exc), "diff": ""}

    @app.post("/api/git/revert")
    async def api_git_revert(request: Request) -> dict[str, Any]:
        if state.host_locked:
            raise HTTPException(status_code=423, detail="HOST_LOCKED")
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")
        repo_path = _resolve_repo_path(body.get("repoPath") or body.get("path"))
        file_path = str(body.get("filePath") or body.get("file") or "").strip()
        if not file_path:
            raise HTTPException(status_code=400, detail="filePath is required")

        real_repo = os.path.normcase(os.path.realpath(repo_path))
        real_target = os.path.normcase(os.path.realpath(os.path.join(repo_path, file_path)))
        if not real_target.startswith(real_repo):
            raise HTTPException(status_code=403, detail="Path traversal outside repository is forbidden")

        state._bind_sibling_modules()
        if state.git_manager is not None and hasattr(state.git_manager, "revert_file"):
            try:
                res = await _maybe_await(state.git_manager.revert_file(repo_path, file_path))
                return res if isinstance(res, dict) else {"ok": bool(res), "filePath": file_path}
            except Exception as exc:
                raise HTTPException(status_code=400, detail=str(exc))

        proc = subprocess.run(
            ["git", "checkout", "--", file_path],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return {"ok": proc.returncode == 0, "filePath": file_path, "stderr": proc.stderr.strip()}

    @app.post("/api/git/worktree/merge")
    async def api_git_worktree_merge(request: Request) -> dict[str, Any]:
        if state.host_locked:
            raise HTTPException(status_code=423, detail="HOST_LOCKED")
        body = await request.json()
        repo_path = _resolve_repo_path(body.get("repoPath") or body.get("path"))
        worktree_path = str(body.get("worktreePath") or "")
        branch_name = str(body.get("branchName") or body.get("branch") or "")
        state._bind_sibling_modules()
        if state.git_manager is not None and hasattr(state.git_manager, "merge_worktree"):
            res = await _maybe_await(state.git_manager.merge_worktree(repo_path, worktree_path, branch_name))
            return res if isinstance(res, dict) else {"ok": bool(res)}
        return {"ok": True, "repoPath": repo_path, "branchName": branch_name}

    @app.post("/api/git/worktree/discard")
    async def api_git_worktree_discard(request: Request) -> dict[str, Any]:
        if state.host_locked:
            raise HTTPException(status_code=423, detail="HOST_LOCKED")
        body = await request.json()
        repo_path = _resolve_repo_path(body.get("repoPath") or body.get("path"))
        worktree_path = str(body.get("worktreePath") or "")
        branch_name = str(body.get("branchName") or body.get("branch") or "")
        state._bind_sibling_modules()
        if state.git_manager is not None and hasattr(state.git_manager, "discard_worktree"):
            res = await _maybe_await(state.git_manager.discard_worktree(repo_path, worktree_path, branch_name))
            return res if isinstance(res, dict) else {"ok": bool(res)}
        return {"ok": True, "repoPath": repo_path, "discarded": True}

    # -------------------------------------------------------------------------
    # Tunnel Supervisor & Provider Hook Config Snippets
    # -------------------------------------------------------------------------

    @app.get("/api/tunnel/status")
    @app.post("/api/tunnel/status")
    async def api_tunnel_status() -> dict[str, Any]:
        status = state.get_tunnel_status()
        pairing = state.auth.get_active_pairing(public_url=status.get("publicUrl") or "http://127.0.0.1:8790")
        qr_svg = state.render_qr_svg(pairing["pairingUrl"])
        return {
            **status,
            "pairing": {
                **pairing,
                "pairUrl": pairing["pairingUrl"],
                "url": pairing["pairingUrl"],
                "qrSvg": qr_svg,
            },
            "qrSvg": qr_svg,
        }

    @app.post("/api/tunnel/start")
    async def api_tunnel_start(request: Request) -> dict[str, Any]:
        body: dict[str, Any] = {}
        try:
            body = await request.json()
        except Exception:
            pass
        backend = str(body.get("backend") or "cloudflare")
        token = body.get("token")
        state._bind_sibling_modules()
        if state.tunnel_supervisor is not None and hasattr(state.tunnel_supervisor, "start"):
            try:
                sig = inspect.signature(state.tunnel_supervisor.start)
                kwargs: dict[str, Any] = {}
                if "backend" in sig.parameters:
                    kwargs["backend"] = backend
                if "token" in sig.parameters and token:
                    kwargs["token"] = token
                await _maybe_await(state.tunnel_supervisor.start(**kwargs))
            except Exception:
                pass
        status = await api_tunnel_status()
        state.db.emit_event("tunnel.updated", status)
        return status

    @app.post("/api/tunnel/stop")
    async def api_tunnel_stop() -> dict[str, Any]:
        state._bind_sibling_modules()
        if state.tunnel_supervisor is not None and hasattr(state.tunnel_supervisor, "stop"):
            try:
                await _maybe_await(state.tunnel_supervisor.stop())
            except Exception:
                pass
        status = await api_tunnel_status()
        state.db.emit_event("tunnel.updated", status)
        return status

    @app.get("/api/adapters/hook-configs")
    async def api_adapters_hook_configs() -> dict[str, Any]:
        shim_cmd = str((Path(__file__).resolve().parent.parent / "bin" / "hook.cmd"))
        state._bind_sibling_modules()
        providers: dict[str, Any] = {}
        configs_list: list[dict[str, Any]] = []
        if _adapters_mod is not None:
            all_adapters_fn = getattr(_adapters_mod, "all_adapters", None)
            if callable(all_adapters_fn):
                try:
                    for adapter in all_adapters_fn():
                        pid = str(getattr(adapter, "provider_id", "unknown"))
                        d_name = str(getattr(adapter, "display_name", pid))
                        if hasattr(adapter, "generate_hook_snippet"):
                            snip = adapter.generate_hook_snippet(shim_cmd)
                            providers[pid] = snip
                            if isinstance(snip, dict):
                                configs_list.append(
                                    {
                                        "provider": pid,
                                        "displayName": snip.get("displayName", d_name),
                                        "configPath": snip.get("configPath") or snip.get("targetFile") or "",
                                        "snippet": snip.get("snippet") or json.dumps(snip, indent=2),
                                        **snip,
                                    }
                                )
                except Exception:
                    pass
        if "antigravity" not in providers:
            ag_snip = {
                "provider": "antigravity",
                "displayName": "Antigravity (0G Priority #1)",
                "configPath": "~/.gemini/hooks.json",
                "targetFile": "~/.gemini/hooks.json (or <workspace>/.gemini/hooks.json)",
                "command": f'"{shim_cmd}" --provider antigravity --event PreToolUse',
                "snippet": json.dumps(
                    {
                        "hooks": {
                            "PreToolUse": [{"command": f'"{shim_cmd}" --provider antigravity --event PreToolUse'}]
                        }
                    },
                    indent=2,
                ),
            }
            providers["antigravity"] = ag_snip
            configs_list.append(ag_snip)
        return {"shimCommand": shim_cmd, "providers": providers, "configs": configs_list}

    # -------------------------------------------------------------------------
    # Always-On Two-Way WebSocket State Stream (/ws/stream?since=0)
    # -------------------------------------------------------------------------

    @app.websocket("/ws/stream")
    async def ws_stream(websocket: WebSocket, since: int = Query(default=0)) -> None:
        if _is_non_loopback_or_auth_forced(websocket.headers.get("host")):
            tok = _extract_auth_token_from_headers_or_query(websocket.headers, websocket.query_params)
            if not state.auth.verify_mobile_token(tok):
                await websocket.close(code=4401)
                return

        await websocket.accept()
        state.ws_clients.add(websocket)
        last_seq = int(since)

        try:
            missed = state.db.events_since(last_seq, limit=500)
            for env in missed:
                await websocket.send_json(env.model_dump())
                last_seq = max(last_seq, env.seq)
        except Exception:
            state.ws_clients.discard(websocket)
            return

        stop_flag = asyncio.Event()

        async def _outbound_loop() -> None:
            nonlocal last_seq
            while not stop_flag.is_set():
                new_events = await state.db.wait_for_events(last_seq, timeout=15.0)
                if stop_flag.is_set():
                    break
                if new_events:
                    for env in new_events:
                        await websocket.send_json(env.model_dump())
                        last_seq = max(last_seq, env.seq)
                else:
                    await websocket.send_json(
                        {
                            "seq": last_seq,
                            "ts": time.time(),
                            "eventType": "heartbeat",
                            "payload": {"hostLocked": state.host_locked},
                        }
                    )

        async def _inbound_loop() -> None:
            while not stop_flag.is_set():
                msg = await websocket.receive_json()
                if not isinstance(msg, dict):
                    continue
                msg_type = str(msg.get("type") or msg.get("eventType") or "")

                if msg_type in ("ping", "heartbeat"):
                    await websocket.send_json(
                        {
                            "seq": state.db.latest_seq(),
                            "ts": time.time(),
                            "eventType": "pong",
                            "payload": {"hostLocked": state.host_locked},
                        }
                    )
                elif msg_type == "pty_input":
                    pty_sid = str(msg.get("sessionId") or msg.get("ptySessionId") or "default")
                    data_in = str(msg.get("data") or "")
                    state._bind_sibling_modules()
                    if not state.host_locked and state.pty_mux is not None and hasattr(state.pty_mux, "write_input"):
                        try:
                            await _maybe_await(state.pty_mux.write_input(pty_sid, data_in))
                        except Exception:
                            pass
                elif msg_type == "pty_create":
                    cwd_in = msg.get("cwd")
                    state._bind_sibling_modules()
                    if not state.host_locked and state.pty_mux is not None and hasattr(state.pty_mux, "create_session"):
                        try:
                            res = await _maybe_await(state.pty_mux.create_session(cwd=cwd_in))
                            await websocket.send_json(
                                {
                                    "seq": state.db.latest_seq(),
                                    "ts": time.time(),
                                    "eventType": "pty.created",
                                    "payload": {"ptySession": res},
                                }
                            )
                        except Exception:
                            pass
                elif msg_type == "steer":
                    sid = str(msg.get("sessionId") or "default")
                    text_in, _ = state.redactor.redact(str(msg.get("message") or ""))
                    if text_in:
                        queued = state.db.queue_steering(sid, text_in, client_msg_id=msg.get("clientMsgId"))
                        state.db.emit_event("steering.queued", queued, session_id=sid)
                elif msg_type in ("mobile_tool_result", "mobile_tool_response"):
                    ticket_id = str(msg.get("ticketId") or "")
                    ok = bool(msg.get("ok", True))
                    result_val = state.redactor.redact_dict(msg.get("result"))
                    err_val, _ = state.redactor.redact(str(msg.get("error") or ""))
                    resp_payload = {
                        "ok": ok,
                        "ticketId": ticket_id,
                        "result": result_val,
                        "error": err_val or None,
                    }
                    fut = state.pending_mobile_tool_calls.get(ticket_id)
                    if fut is not None and not fut.done():
                        fut.set_result(resp_payload)
                    state.db.emit_event("mobile_tool_response", resp_payload)

        outbound_task = asyncio.create_task(_outbound_loop())
        inbound_task = asyncio.create_task(_inbound_loop())
        try:
            await asyncio.wait(
                [outbound_task, inbound_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            stop_flag.set()
            outbound_task.cancel()
            inbound_task.cancel()
            state.ws_clients.discard(websocket)

    # -------------------------------------------------------------------------
    # Static PWA & Desktop Aux Pane (?view=auxpane) Serving
    # -------------------------------------------------------------------------

    web_dist = Path(__file__).resolve().parent.parent / "web" / "dist"
    if (web_dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=str(web_dist / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_pwa(full_path: str, request: Request) -> Response:
        if full_path.startswith("api/") or full_path.startswith("ws/"):
            raise HTTPException(status_code=404, detail="API endpoint not found")

        dist_dir = Path(__file__).resolve().parent.parent / "web" / "dist"
        if full_path and (dist_dir / full_path).is_file():
            return FileResponse(str(dist_dir / full_path))
        if (dist_dir / "index.html").is_file():
            return FileResponse(str(dist_dir / "index.html"))

        view = request.query_params.get("view", "mobile")
        return HTMLResponse(
            f"""<!doctype html>
<html lang="en" data-theme="obsidian">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>0G — Mobile Remote &amp; Host Control ({view})</title>
</head>
<body style="background:#09090B;color:#F4F4F5;font-family:sans-serif;padding:24px;">
  <h1>0G Bridge Daemon Online (127.0.0.1:8790)</h1>
  <p>Mode: <code>{view}</code> · Run <code>npm run build</code> in <code>web/</code> to serve full PWA assets.</p>
</body>
</html>"""
        )

    return app


app = create_app()


def main() -> None:
    """Entrypoint binding strictly to 127.0.0.1:8790 (never 0.0.0.0)."""
    import uvicorn

    host = "127.0.0.1"
    port = int(os.environ.get("ZEROG_PORT", "8790"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
