"""End-to-end verification suite for 0G core daemon, security, hooks, MCP, and Windows host controls."""

from __future__ import annotations

import asyncio
import base64
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

import pytest
import uvicorn
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from server.app import create_app
from server.db import ZeroGDatabase
from server.git_ops import GitManager
from server.host_control import HostTelemetry, _parse_proc_meminfo
from server.power_governor import BackpackPowerGovernor
from server.pty_mux import JobObjectPtyMux
from server.rules_engine import RulesEngine
from server.security import EgressRedactor, decode_powershell_encoded
from server.tunnel import TunnelSupervisor, _build_qr_matrix, generate_qr_svg


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _read_bridge_token(data_dir: Path) -> str:
    return (data_dir / "bridge.token").read_text(encoding="utf-8").strip()


# ---------------------------------------------------------------------------
# 1. EgressRedactor & PowerShell Decoder
# ---------------------------------------------------------------------------


def test_egress_redactor_and_powershell_decoder() -> None:
    redactor = EgressRedactor()
    sample = "\n".join(
        [
            "\x1b[31mERROR\x1b[0m \u202eSPOOF\u2069",
            "OPENAI=sk-proj-abc12345678901234567890123456",
            "GOOGLE=AIzaSyDummyKeyValue12345678901234567",
            "GITHUB=ghp_1234567890abcdef1234567890abcdef1234",
            "XAI=xai-secretkeyvalue1234567890abcdef",
            "Authorization: Bearer super_secret_bearer_token_987654321",
            "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n-----END PRIVATE KEY-----",
        ]
    )
    cleaned, was_redacted = redactor.redact(sample)
    assert was_redacted is True
    assert "\x1b[" not in cleaned
    assert "\u202e" not in cleaned
    assert "\u2069" not in cleaned
    assert "sk-proj-abc" not in cleaned
    assert "AIzaSyDummyKeyValue" not in cleaned
    assert "ghp_1234567890" not in cleaned
    assert "xai-secretkeyvalue" not in cleaned
    assert "super_secret_bearer_token" not in cleaned
    assert "MIIEvQIBADANBgkqhkiG9w0" not in cleaned

    nested = redactor.redact_dict({"nested": ["Bearer abcdefghijklmnopqrstuvwx", "ok"]})
    assert "abcdefghijklmnopqrstuvwx" not in nested["nested"][0]

    ps_script = "Remove-Item -Recurse -Force C:\\temp\\demo"
    encoded = base64.b64encode(ps_script.encode("utf-16le")).decode("ascii")
    decoded = decode_powershell_encoded(f"powershell.exe -NoProfile -EncodedCommand {encoded}")
    assert decoded is not None
    assert "Remove-Item -Recurse -Force" in decoded


# ---------------------------------------------------------------------------
# 2. RulesEngine Tier-3 Self-Protection & Overwrite Re-evaluation
# ---------------------------------------------------------------------------


def test_rules_engine_tier3_self_protection_and_scoped_grant(tmp_path: Path) -> None:
    db = ZeroGDatabase(str(tmp_path / "rules.sqlite3"))
    engine = RulesEngine(db)

    protected_targets = [
        ("write_file", {"Path": r"C:\Users\demo\.gemini\antigravity\hooks.json"}),
        ("edit_file", {"file_path": r"C:\repo\plugins\0g\plugin.json"}),
        ("write_file", {"Path": r"C:\repo\.env"}),
        ("edit_file", {"Path": r"C:\Users\demo\.gemini\config\config.json"}),
        ("run_command", {"CommandLine": "Remove-Item -Recurse -Force C:\\Users\\demo\\project"}),
    ]
    for tool_name, args in protected_targets:
        res = engine.evaluate(tool_name, args, provider="antigravity")
        assert res["riskTier"] == 3
        assert res["autoDecision"] == "deny"

    # Encoded destructive PowerShell payload must also be caught at Tier 3
    enc_rm = base64.b64encode("rm -rf /tmp/important".encode("utf-16le")).decode("ascii")
    enc_res = engine.evaluate("run_command", {"CommandLine": f"pwsh -enc {enc_rm}"})
    assert enc_res["riskTier"] == 3
    assert enc_res["autoDecision"] == "deny"

    # Safe temporary 30m grant works for non-Tier-3 commands, but refuses Tier-3 commands
    with pytest.raises(ValueError):
        engine.create_scoped_temp_grant("run_command", "rm -rf /", provider="antigravity")

    rule = engine.create_scoped_temp_grant("run_command", "npm test", provider="antigravity", duration_sec=1800)
    assert rule.action == "allow"
    re_eval = engine.evaluate("run_command", {"CommandLine": "npm test"}, provider="antigravity")
    assert re_eval["autoDecision"] == "allow"
    db.close()


# ---------------------------------------------------------------------------
# 3. Hook Dispatch Lifecycle, Hold Escalation, Edit-Approve, Allow-30m & PANIC
# ---------------------------------------------------------------------------


def test_hook_dispatch_lifecycle_approvals_and_panic(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    app = create_app(data_dir=data_dir)
    with TestClient(app) as client:
        bridge_tok = _read_bridge_token(data_dir)
        headers = {"X-0G-Bridge-Token": bridge_tok}

        # SessionStart
        r_start = client.post(
            "/api/hooks/dispatch",
            headers=headers,
            json={
                "provider": "antigravity",
                "hookEventName": "SessionStart",
                "conversationId": "conv-e2e-1",
                "cwd": str(REPO_ROOT),
            },
        )
        assert r_start.status_code == 200
        assert r_start.json()["decision"] == "ok"

        # Queue steering and verify PreInvocation drains ONLY when continuationActive=False
        r_steer = client.post(
            "/api/sessions/conv-e2e-1/steer",
            json={"message": "Focus on tests first"},
        )
        assert r_steer.status_code == 200

        r_pre_cont = client.post(
            "/api/hooks/dispatch",
            headers=headers,
            json={
                "provider": "antigravity",
                "hookEventName": "PreInvocation",
                "conversationId": "conv-e2e-1",
                "continuationActive": True,
            },
        )
        assert r_pre_cont.status_code == 200
        assert r_pre_cont.json()["injectSteps"] == []

        r_pre = client.post(
            "/api/hooks/dispatch",
            headers=headers,
            json={
                "provider": "antigravity",
                "hookEventName": "PreInvocation",
                "conversationId": "conv-e2e-1",
                "lastUserInput": "Run checks",
                "continuationActive": False,
            },
        )
        assert r_pre.status_code == 200
        steps = r_pre.json()["injectSteps"]
        assert len(steps) == 1
        assert "Focus on tests first" in steps[0]["content"]

        # Hold timeout escalation (short hold via X-0G-Hold-Seconds -> force_ask + escalated)
        r_timeout = client.post(
            "/api/hooks/dispatch",
            headers={**headers, "X-0G-Hold-Seconds": "0.25"},
            json={
                "provider": "antigravity",
                "hookEventName": "PreToolUse",
                "conversationId": "conv-e2e-1",
                "toolCall": {"id": "tc-1", "name": "run_command", "arguments": {"CommandLine": "npm run lint"}},
            },
        )
        assert r_timeout.status_code == 200
        assert r_timeout.json()["decision"] == "force_ask"
        apprs = client.get("/api/approvals").json()
        assert any(a["toolCallId"] == "tc-1" and a["status"] == "escalated" for a in apprs)

        # Live PreToolUse + edit_approve from background thread (also tests Tier-3 overwrite rejection!)
        result_box: dict[str, Any] = {}

        def _post_pretool() -> None:
            resp = client.post(
                "/api/hooks/dispatch",
                headers={**headers, "X-0G-Hold-Seconds": "5.0"},
                json={
                    "provider": "antigravity",
                    "hookEventName": "PreToolUse",
                    "conversationId": "conv-e2e-1",
                    "toolCall": {"id": "tc-edit-1", "name": "run_command", "arguments": {"CommandLine": "npm run build"}},
                },
            )
            result_box["resp"] = resp.json()

        t = threading.Thread(target=_post_pretool, daemon=True)
        t.start()

        pending_id = None
        for _ in range(40):
            items = client.get("/api/approvals?status=pending").json()
            for item in items:
                if item.get("toolCallId") == "tc-edit-1":
                    pending_id = item["id"]
                    break
            if pending_id:
                break
            time.sleep(0.05)
        assert pending_id is not None

        # Tier-3 overwrite must be rejected with 403
        bad_edit = client.post(
            f"/api/approvals/{pending_id}/decide",
            json={"action": "edit_approve", "overwriteArgs": {"CommandLine": "write .env secret"}},
        )
        assert bad_edit.status_code == 403

        # Safe overwrite wakes hook and returns overwrite payload
        good_edit = client.post(
            f"/api/approvals/{pending_id}/decide",
            json={"action": "edit_approve", "overwriteArgs": {"CommandLine": "npm run build -- --mode test"}},
        )
        assert good_edit.status_code == 200
        t.join(timeout=3.0)
        assert result_box["resp"]["decision"] == "allow"
        assert result_box["resp"]["overwrite"] == {"CommandLine": "npm run build -- --mode test"}

        # allow_30m scoped grant -> subsequent matching PreToolUse auto-allows immediately
        box2: dict[str, Any] = {}

        def _post_allow30() -> None:
            resp = client.post(
                "/api/hooks/dispatch",
                headers={**headers, "X-0G-Hold-Seconds": "5.0"},
                json={
                    "provider": "antigravity",
                    "hookEventName": "PreToolUse",
                    "conversationId": "conv-e2e-1",
                    "toolCall": {"id": "tc-30m", "name": "run_command", "arguments": {"CommandLine": "pytest tests/unit"}},
                },
            )
            box2["resp"] = resp.json()

        t2 = threading.Thread(target=_post_allow30, daemon=True)
        t2.start()
        pending_id2 = None
        for _ in range(40):
            for item in client.get("/api/approvals?status=pending").json():
                if item.get("toolCallId") == "tc-30m":
                    pending_id2 = item["id"]
                    break
            if pending_id2:
                break
            time.sleep(0.05)
        assert pending_id2 is not None
        r_30m = client.post(f"/api/approvals/{pending_id2}/decide", json={"action": "allow_30m"})
        assert r_30m.status_code == 200
        t2.join(timeout=3.0)
        assert box2["resp"]["decision"] == "allow"

        # Second call auto-allows with zero wait
        r_auto = client.post(
            "/api/hooks/dispatch",
            headers={**headers, "X-0G-Hold-Seconds": "0.2"},
            json={
                "provider": "antigravity",
                "hookEventName": "PreToolUse",
                "conversationId": "conv-e2e-1",
                "toolCall": {"id": "tc-30m-2", "name": "run_command", "arguments": {"CommandLine": "pytest tests/unit"}},
            },
        )
        assert r_auto.status_code == 200
        assert r_auto.json()["decision"] == "allow"

        # PANIC lock -> HOST_LOCKED denies and terminates; unlock restores
        r_panic = client.post("/api/panic", json={"lockWorkstation": False})
        assert r_panic.status_code == 200
        assert r_panic.json()["hostLocked"] is True

        r_locked_hook = client.post(
            "/api/hooks/dispatch",
            headers=headers,
            json={
                "provider": "antigravity",
                "hookEventName": "PreToolUse",
                "conversationId": "conv-e2e-1",
                "toolCall": {"id": "tc-locked", "name": "read_file", "arguments": {"Path": "README.md"}},
            },
        )
        assert r_locked_hook.status_code == 200
        assert r_locked_hook.json()["decision"] == "deny"
        assert r_locked_hook.json()["terminationBehavior"] == "terminate"

        r_unlock = client.post("/api/panic/unlock", json={})
        assert r_unlock.status_code == 200
        assert r_unlock.json()["hostLocked"] is False

        # Ask on Phone with no connected phone & no hold override defers cleanly without blocking
        r_no_phone = client.post(
            "/api/hooks/dispatch",
            headers=headers,
            json={
                "provider": "antigravity",
                "hookEventName": "PreToolUse",
                "conversationId": "conv-e2e-1",
                "toolCall": {"id": "tc-nophone", "name": "run_command", "arguments": {"CommandLine": "npm run custom-check"}},
            },
        )
        assert r_no_phone.status_code == 200
        assert r_no_phone.json()["decision"] == "ask"

        # Agent Turbo auto-allows Tier 0-2 while still blocking Tier 3
        r_gate = client.post("/api/host/agent-gate", json={"mode": "agent_turbo"})
        assert r_gate.status_code == 200
        assert r_gate.json()["agentGateMode"] == "agent_turbo"

        r_turbo_ok = client.post(
            "/api/hooks/dispatch",
            headers=headers,
            json={
                "provider": "antigravity",
                "hookEventName": "PreToolUse",
                "conversationId": "conv-e2e-1",
                "toolCall": {"id": "tc-turbo-ok", "name": "run_command", "arguments": {"CommandLine": "npm run dev"}},
            },
        )
        assert r_turbo_ok.status_code == 200
        assert r_turbo_ok.json()["decision"] == "allow"

        r_turbo_tier3 = client.post(
            "/api/hooks/dispatch",
            headers=headers,
            json={
                "provider": "antigravity",
                "hookEventName": "PreToolUse",
                "conversationId": "conv-e2e-1",
                "toolCall": {"id": "tc-turbo-t3", "name": "write_file", "arguments": {"Path": ".env", "Content": "K=V"}},
            },
        )
        assert r_turbo_tier3.status_code == 200
        assert r_turbo_tier3.json()["decision"] == "deny"

        # Reset back to ask_on_phone
        assert client.post("/api/host/agent-gate", json={"mode": "ask_on_phone"}).status_code == 200


# ---------------------------------------------------------------------------
# 4. hooks/shim.py Cold-Start Latency & Multi-Provider Formats
# ---------------------------------------------------------------------------


def test_hook_shim_offline_latency_and_multiprovider_translations(tmp_path: Path) -> None:
    shim_path = str(REPO_ROOT / "hooks" / "shim.py")
    dead_port = _free_port()
    env = os.environ.copy()
    env["ZEROG_DAEMON_URL"] = f"http://127.0.0.1:{dead_port}/api/hooks/dispatch"
    env["ZEROG_DATA_DIR"] = str(tmp_path)

    # Offline daemon graceful fallback (<1s)
    t0 = time.perf_counter()
    proc = subprocess.run(
        [sys.executable, "-I", "-S", shim_path, "--provider", "antigravity", "--event", "PreToolUse"],
        input=json.dumps({"conversationId": "c1", "toolCall": {"name": "run_command", "arguments": {"CommandLine": "dir"}}}),
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=5.0,
    )
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    assert proc.returncode == 0
    assert elapsed_ms < 1000.0, f"Offline shim fallback took {elapsed_ms:.1f}ms (>= 1000ms)"
    assert json.loads(proc.stdout)["decision"] == "ask"

    # Spin up tiny stub HTTP server returning controlled HookDecisionResponse JSON
    stub_response: dict[str, Any] = {"decision": "deny", "reason": "Blocked by policy"}

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or "0")
            _ = self.rfile.read(length)
            body = json.dumps(stub_response).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

    server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    stub_port = server.server_address[1]
    srv_thread = threading.Thread(target=server.serve_forever, daemon=True)
    srv_thread.start()
    try:
        env["ZEROG_DAEMON_URL"] = f"http://127.0.0.1:{stub_port}/api/hooks/dispatch"

        # Connected shim cold-start subprocess latency < 500ms
        t_conn = time.perf_counter()
        fast_res = subprocess.run(
            [sys.executable, "-I", "-S", shim_path, "--provider", "antigravity", "--event", "SessionStart"],
            input=json.dumps({"conversationId": "c-fast"}),
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=5.0,
        )
        conn_ms = (time.perf_counter() - t_conn) * 1000.0
        assert fast_res.returncode == 0
        assert conn_ms < 500.0, f"Connected shim subprocess took {conn_ms:.1f}ms (>= 500ms)"

        for provider, expected_rc in (
            ("antigravity", 0),
            ("claude_code", 2),
            ("codex_cli", 2),
            ("grok_build", 2),
        ):
            res = subprocess.run(
                [sys.executable, "-I", "-S", shim_path, "--provider", provider, "--event", "PreToolUse"],
                input=json.dumps({"session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}),
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                timeout=5.0,
            )
            assert res.returncode == expected_rc
            parsed = json.loads(res.stdout)
            if provider in ("claude_code", "grok_build"):
                assert parsed["hookSpecificOutput"]["permissionDecision"] == "deny"
            else:
                assert parsed["decision"] == "deny"
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------------------
# 5. WebSocket Replay / Live Push & IndexedDB Outbox 409 Guard
# ---------------------------------------------------------------------------


def test_websocket_replay_and_outbox_409_conflict(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    app = create_app(data_dir=data_dir)
    with TestClient(app) as client:
        bridge_tok = _read_bridge_token(data_dir)
        headers = {"X-0G-Bridge-Token": bridge_tok}

        # Create session at stepIdx=1
        client.post(
            "/api/hooks/dispatch",
            headers=headers,
            json={
                "provider": "antigravity",
                "hookEventName": "PreInvocation",
                "conversationId": "conv-ws-1",
                "lastUserInput": "Step 1 prompt",
            },
        )

        with client.websocket_connect("/ws/stream?since=0") as ws:
            first_frame = ws.receive_json()
            assert "seq" in first_frame
            last_seq = first_frame["seq"]
            # Drain any already-emitted frames quickly via steering event
            r_out_ok = client.post(
                "/api/outbox",
                json={
                    "sessionId": "conv-ws-1",
                    "message": "Continue safely",
                    "clientMsgId": "cmsg-1",
                    "expectedStepIdx": 1,
                },
            )
            assert r_out_ok.status_code == 200
            assert r_out_ok.json()["ok"] is True

            # Deduplication on identical clientMsgId
            r_out_dup = client.post(
                "/api/outbox",
                json={
                    "sessionId": "conv-ws-1",
                    "message": "Continue safely",
                    "clientMsgId": "cmsg-1",
                    "expectedStepIdx": 1,
                },
            )
            assert r_out_dup.status_code == 200
            assert r_out_dup.json()["deduped"] is True

            # Read until we see outbox.flushed on live WS
            seen_outbox = False
            for _ in range(15):
                frame = ws.receive_json()
                last_seq = max(last_seq, int(frame.get("seq", 0)))
                if frame.get("eventType") in ("outbox.flushed", "outbox_flushed"):
                    seen_outbox = True
                    break
            assert seen_outbox is True

        # Delta replay ?since=last_seq skips earlier events
        r_after = client.post(
            "/api/sessions/conv-ws-1/steer",
            json={"message": "Delta message", "clientMsgId": "cmsg-delta"},
        )
        assert r_after.status_code == 200
        with client.websocket_connect(f"/ws/stream?since={last_seq}") as ws_delta:
            seen_delta = False
            for _ in range(5):
                delta_frame = ws_delta.receive_json()
                assert delta_frame["seq"] > last_seq
                if delta_frame["eventType"] in ("steering.queued", "steering_queued"):
                    seen_delta = True
                    break
            assert seen_delta is True

        # Stale expectedStepIdx returns 409 conflict
        r_stale = client.post(
            "/api/outbox",
            json={
                "sessionId": "conv-ws-1",
                "message": "Stale steer",
                "clientMsgId": "cmsg-stale",
                "expectedStepIdx": 999,
            },
        )
        assert r_stale.status_code == 409
        assert r_stale.json()["stale"] is True


# ---------------------------------------------------------------------------
# 6. Phone-Authored Tool -> Stdio MCP Server E2E
# ---------------------------------------------------------------------------


def test_phone_authored_tool_to_mcp_stdio_and_ws_invoke(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    app = create_app(data_dir=data_dir)
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    srv_thread = threading.Thread(target=server.run, daemon=True)
    srv_thread.start()

    try:
        # Wait until live HTTP daemon responds
        base_url = f"http://127.0.0.1:{port}"
        for _ in range(40):
            try:
                with urllib.request.urlopen(f"{base_url}/api/health", timeout=0.5) as resp:
                    if resp.status == 200:
                        break
            except Exception:
                time.sleep(0.05)

        bridge_tok = _read_bridge_token(data_dir)

        # 1. Create custom phone_js tool via REST
        create_req = urllib.request.Request(
            f"{base_url}/api/mobile-tools",
            data=json.dumps(
                {
                    "name": "phone_battery_ping",
                    "description": "Report phone battery status from browser",
                    "runtime": "phone_js",
                    "parametersSchema": {
                        "type": "object",
                        "properties": {"label": {"type": "string"}},
                        "required": [],
                    },
                    "code": "return { label: args.label || 'ok', level: 0.91 };",
                    "requiresApproval": False,
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-0G-Bridge-Token": bridge_tok},
            method="POST",
        )
        with urllib.request.urlopen(create_req, timeout=3.0) as resp:
            assert resp.status == 200

        # 2. Spawn server/mcp_server.py over real stdio and verify initialize + tools/list
        env = os.environ.copy()
        env["ZEROG_DAEMON_URL"] = base_url
        env["ZEROG_DATA_DIR"] = str(data_dir)
        env["ZEROG_BRIDGE_TOKEN"] = bridge_tok

        rpc_input = "\n".join(
            [
                json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}),
                json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
            ]
        ) + "\n"

        mcp_proc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "server" / "mcp_server.py")],
            input=rpc_input,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=10.0,
        )
        assert mcp_proc.returncode == 0
        # Every line on stdout MUST be valid JSON-RPC 2.0 (zero log pollution)
        stdout_lines = [line for line in mcp_proc.stdout.splitlines() if line.strip()]
        assert len(stdout_lines) == 2
        init_msg = json.loads(stdout_lines[0])
        list_msg = json.loads(stdout_lines[1])
        assert init_msg["result"]["serverInfo"]["name"] == "0g-phone-mcp"
        tool_names = {t["name"] for t in list_msg["result"]["tools"]}
        assert "phone_notify_card" in tool_names
        assert "phone_battery_ping" in tool_names

        # 3. Live WS client fulfills POST /api/mobile-tools/invoke
        import websockets

        async def _ws_invoke_e2e() -> dict[str, Any]:
            ws_url = f"ws://127.0.0.1:{port}/ws/stream?since=0&token={bridge_tok}"
            async with websockets.connect(ws_url) as ws:
                # Invoke mobile tool in background thread so WS loop can answer it
                invoke_res: dict[str, Any] = {}

                def _call_invoke() -> None:
                    req = urllib.request.Request(
                        f"{base_url}/api/mobile-tools/invoke",
                        data=json.dumps({"toolName": "phone_battery_ping", "arguments": {"label": "pixel"}, "timeoutSec": 5.0}).encode("utf-8"),
                        headers={"Content-Type": "application/json", "X-0G-Bridge-Token": bridge_tok},
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=6.0) as r:
                        invoke_res["body"] = json.loads(r.read().decode("utf-8"))

                inv_thread = threading.Thread(target=_call_invoke, daemon=True)
                inv_thread.start()

                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    frame = json.loads(raw)
                    if frame.get("eventType") == "mobile_tool_request":
                        ticket_id = frame["payload"]["ticketId"]
                        await ws.send(
                            json.dumps(
                                {
                                    "type": "mobile_tool_result",
                                    "ticketId": ticket_id,
                                    "ok": True,
                                    "result": {"label": "pixel", "level": 0.91},
                                }
                            )
                        )
                        break

                inv_thread.join(timeout=5.0)
                return invoke_res["body"]

        inv_outcome = asyncio.run(_ws_invoke_e2e())
        assert inv_outcome["ok"] is True
        assert inv_outcome["result"]["level"] == 0.91
    finally:
        server.should_exit = True
        srv_thread.join(timeout=3.0)


# ---------------------------------------------------------------------------
# 7. Host-Windows Modules & Audit Hash-Chain Verification
# ---------------------------------------------------------------------------


def test_windows_host_modules_and_audit_chain(tmp_path: Path) -> None:
    # BackpackPowerGovernor passive state & sticky manual ultra_sip override
    gov = BackpackPowerGovernor(cooldown_sec=60.0)
    st0 = gov.get_state()
    assert st0["powerGear"] == "ultra_sip"
    assert st0["lowBatteryThreshold"] == 15

    # Clicking Ultra-Sip manually must lock autoGovernorEnabled=False and stay ultra_sip when a job runs
    st_locked = gov.apply_gear({"gear": "ultra_sip"})
    assert st_locked["powerGear"] == "ultra_sip"
    assert st_locked["autoGovernorEnabled"] is False
    st_after_job = gov.notify_job_started("swarm-task-1")
    assert st_after_job["powerGear"] == "ultra_sip"
    assert st_after_job["autoGovernorEnabled"] is False
    gov.notify_job_finished("swarm-task-1")

    # HostTelemetry zero-psutil snapshot
    assert _parse_proc_meminfo("MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\n") == (8000, 16000)
    tel = HostTelemetry(power_governor=gov)
    snap = tel.snapshot()
    assert snap.hostname
    assert snap.ramTotalMb > 0
    assert snap.diskTotalGb > 0
    assert isinstance(snap.listeningPorts, list)
    assert isinstance(snap.activeAgents, list)

    # JobObjectPtyMux interactive pwsh + macro + PANIC terminate_all
    async def _pty_flow() -> None:
        mux = JobObjectPtyMux()
        try:
            sess = await mux.create_session(cwd=str(REPO_ROOT))
            await mux.write_input(sess["sessionId"], 'echo E2E_PTY_OK\n')
            for _ in range(60):
                if "E2E_PTY_OK" in mux.get_output(sess["sessionId"]):
                    break
                await asyncio.sleep(0.1)
            assert "E2E_PTY_OK" in mux.get_output(sess["sessionId"])

            macro = await mux.run_macro('echo E2E_MACRO_OK', cwd=str(REPO_ROOT))
            assert macro["ok"] is True
            assert "E2E_MACRO_OK" in macro["stdout"]

            killed = await mux.terminate_all()
            assert killed == 1
        finally:
            await mux.terminate_all()
            mux.close()

    asyncio.run(_pty_flow())

    # GitManager in isolated temp repo (GIT_OPTIONAL_LOCKS=0 + worktrees + path traversal guard)
    repo = tmp_path / "git_repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@0g.local"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "0G Test"], cwd=repo, check=True, capture_output=True)
    tracked = repo / "hello.txt"
    tracked.write_text("v1\n", encoding="utf-8")
    subprocess.run(["git", "add", "hello.txt"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True, capture_output=True)

    gm = GitManager()
    assert gm.get_head_sha(str(repo)) is not None
    assert gm.get_branch(str(repo)) is not None

    # Path traversal blocked
    assert gm.revert_file(str(repo), r"..\..\outside.txt")["ok"] is False
    assert gm.revert_file(str(repo), "../../outside.txt")["ok"] is False

    # Dirty file revert
    tracked.write_text("dirty\n", encoding="utf-8")
    assert gm.get_status(str(repo))["clean"] is False
    rev = gm.revert_file(str(repo), "hello.txt")
    assert rev["ok"] is True
    assert tracked.read_text(encoding="utf-8") == "v1\n"

    # Worktree create + discard
    wt = gm.create_worktree(str(repo), "feat/test-wt")
    assert wt["ok"] is True
    assert Path(wt["worktreePath"]).is_dir()
    disc = gm.discard_worktree(str(repo), wt["worktreePath"], wt["branchName"])
    assert disc["ok"] is True

    # TunnelSupervisor QR SVG + status fields + dead-DNS detection
    tsup = TunnelSupervisor(local_port=8790)
    tstat = tsup.get_status()
    assert "cloudflaredInstalled" in tstat
    assert "tailscaleInstalled" in tstat
    assert "qrSvg" in tstat
    assert tsup.check_public_url_alive() is False
    tsup.backend = "cloudflare"
    tsup.status = "running"
    tsup.public_url = "https://dead-nonexistent-0g-host-999999.trycloudflare.com"
    tsup.started_at = time.time() - 60
    assert tsup.check_public_url_alive() is False
    tsup.status = "stopped"
    tsup.public_url = None
    svg = generate_qr_svg("https://demo.trycloudflare.com/?pair=123456")
    mat = _build_qr_matrix("https://demo.trycloudflare.com/?pair=123456")
    assert svg.startswith("<svg") and svg.endswith("</svg>")
    assert all(mat[0][c] == 1 for c in range(7)) and mat[3][3] == 1

    # ZeroGDatabase SHA-256 audit hash-chain verification + tamper detection
    db = ZeroGDatabase(str(tmp_path / "audit.sqlite3"))
    db.append_audit("test", "action_1", {"k": 1})
    db.append_audit("test", "action_2", {"k": 2})
    assert db.verify_audit_chain() is True

    # Tamper row 1 and confirm verify_audit_chain detects it
    with db._get_conn() as conn:
        conn.execute("UPDATE audit_log SET action = 'tampered' WHERE id = 1")
    assert db.verify_audit_chain() is False
    db.close()


# ---------------------------------------------------------------------------
# 8. Antigravity Desktop Bridge & /api/agy/* Endpoints
# ---------------------------------------------------------------------------


def test_antigravity_desktop_bridge_endpoints(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import sqlite3
    import urllib.parse

    agy_dir = tmp_path / "agy"
    cfg_dir = tmp_path / "cfg"
    scratch_root = tmp_path / "scratch"
    proj_dir = scratch_root / "alpha-app"
    (proj_dir / "src").mkdir(parents=True)
    (proj_dir / "node_modules" / "pkg").mkdir(parents=True)
    (proj_dir / "node_modules" / "pkg" / "index.js").write_text("console.log(1)\n", encoding="utf-8")
    (proj_dir / "src" / "main.py").write_text(
        'TOKEN = "sk-proj-abc12345678901234567890123456"\nprint("hello")\n',
        encoding="utf-8",
    )
    (proj_dir / ".env").write_text("SECRET_KEY=topsecret123\n", encoding="utf-8")

    # Initialize git repo so gitBranch & dirtyCount are real
    subprocess.run(["git", "init"], cwd=proj_dir, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@0g.local"], cwd=proj_dir, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "0G Test"], cwd=proj_dir, check=True, capture_output=True)
    subprocess.run(["git", "add", "src/main.py"], cwd=proj_dir, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=proj_dir, check=True, capture_output=True)

    # Customizations
    (cfg_dir / "plugins" / "0g").mkdir(parents=True)
    (cfg_dir / "plugins" / "0g" / "plugin.json").write_text(
        json.dumps({"name": "0g", "displayName": "0G", "description": "Mobile remote"}),
        encoding="utf-8",
    )
    (cfg_dir / "skills" / "custom-skill").mkdir(parents=True)
    (cfg_dir / "skills" / "custom-skill" / "SKILL.md").write_text(
        "---\nname: custom-skill\ndescription: Custom user skill\n---\nBody\n",
        encoding="utf-8",
    )
    (agy_dir / "builtin" / "skills" / "builtin-skill").mkdir(parents=True)
    (agy_dir / "builtin" / "skills" / "builtin-skill" / "SKILL.md").write_text(
        "---\nname: builtin-skill\ndescription: Builtin skill\n---\nBody\n",
        encoding="utf-8",
    )
    (cfg_dir / "rules").mkdir(parents=True)
    (cfg_dir / "rules" / "AGENTS.md").write_text("# Rules\n", encoding="utf-8")

    # Brain directory + transcript + swarm plan + artifacts
    conv_id = "conv-main-1"
    sub_id = "conv-sub-1"
    conv_brain = agy_dir / "brain" / conv_id
    logs_dir = conv_brain / ".system_generated" / "logs"
    swarm_dir = conv_brain / ".system_generated" / "swarm"
    logs_dir.mkdir(parents=True)
    swarm_dir.mkdir(parents=True)
    (agy_dir / "brain" / sub_id / ".system_generated" / "logs").mkdir(parents=True)

    (swarm_dir / "plan.json").write_text(
        json.dumps({"goal": {"title": "Alpha Swarm"}, "tasks": {"worker": "Implement"}}),
        encoding="utf-8",
    )
    (conv_brain / "report.md").write_text("# Report\nAll clear.\n", encoding="utf-8")
    tiny_png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    (conv_brain / "diagram.png").write_bytes(tiny_png)
    (conv_brain / ".system_generated" / "internal.txt").write_text("hidden", encoding="utf-8")

    transcript_rows = [
        {"step_index": 0, "source": "SYSTEM_SDK", "type": "USER_INPUT", "content": "sdk noise", "created_at": "2026-11-21T10:00:00Z"},
        {"step_index": 1, "source": "SYSTEM", "type": "EPHEMERAL_MESSAGE", "content": "ephemeral noise", "created_at": "2026-11-21T10:00:01Z"},
        {"step_index": 2, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "content": "system noise", "created_at": "2026-11-21T10:00:02Z"},
        {
            "step_index": 3,
            "source": "USER_EXPLICIT",
            "type": "USER_INPUT",
            "content": "<USER_REQUEST>\nFix the router\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nTime: now\n</ADDITIONAL_METADATA>\n<CONTEXT_SUMMARY>old</CONTEXT_SUMMARY>",
            "created_at": "2026-11-21T10:00:03Z",
        },
        {
            "step_index": 4,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "model": "gemini-4-hydrogen-high",
            "thinking": "Checking main.py",
            "content": "Truncated...",
            "truncated_fields": ["content"],
            "tool_calls": [{"name": "read_file", "args": {"Path": "src/main.py"}}],
            "created_at": "2026-11-21T10:00:04Z",
        },
        {
            "step_index": 5,
            "source": "MODEL",
            "type": "GENERIC",
            "content": "Created At: 2026-11-21T10:00:04Z\nShowing lines 1-2\nprint(\"hello\")",
            "created_at": "2026-11-21T10:00:05Z",
        },
        {
            "step_index": 6,
            "source": "USER_EXPLICIT",
            "type": "USER_INPUT",
            "content": '<talker_agent_context>\n[2026-11-21T10:00:06Z] user: "Continue via talker"\n</talker_agent_context>',
            "created_at": "2026-11-21T10:00:06Z",
        },
    ]
    (logs_dir / "transcript.jsonl").write_text(
        "\n".join(json.dumps(r) for r in transcript_rows) + "\n",
        encoding="utf-8",
    )
    full_row = dict(transcript_rows[4], content="Resolved full assistant response", truncated_fields=[])
    (logs_dir / "transcript_full.jsonl").write_text(json.dumps(full_row) + "\n", encoding="utf-8")

    # Build conversation_summaries.db with file:///c%3A/... URI encoding
    posix_proj = proj_dir.resolve().as_posix()
    if not posix_proj.startswith("/"):
        posix_proj = "/" + posix_proj
    encoded_uri = "file://" + urllib.parse.quote(posix_proj, safe="/")
    db_file = agy_dir / "conversation_summaries.db"
    con = sqlite3.connect(db_file)
    con.execute(
        """
        CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            preview TEXT NOT NULL DEFAULT '',
            step_count INTEGER NOT NULL DEFAULT 0,
            last_modified_time TEXT NOT NULL,
            workspace_uris TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            project_id TEXT NOT NULL DEFAULT '',
            agent_name TEXT NOT NULL DEFAULT '',
            parent_conversation_id TEXT NOT NULL DEFAULT '',
            not_fully_idle INTEGER NOT NULL DEFAULT 0,
            killed INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    con.execute(
        "CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, title, workspace, project, user_body, agent_body)"
    )
    con.execute("CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL)")
    con.execute(
        "INSERT INTO conversation_summaries VALUES (?, ?, '', ?, ?, ?, ?, '', 'p1', '', '', 0, 0)",
        (conv_id, "", 7, "2026-11-21 10:00:06.1234567+00:00", json.dumps([encoded_uri]), "CASCADE_RUN_STATUS_IDLE"),
    )
    con.execute(
        "INSERT INTO conversation_summaries VALUES (?, ?, '', ?, ?, ?, ?, '', 'p1', 'verifier', ?, 0, 0)",
        (sub_id, "Verify Alpha", 2, "2026-11-21 10:00:05.0000000+00:00", json.dumps([encoded_uri]), "CASCADE_RUN_STATUS_IDLE", conv_id),
    )
    con.execute(
        "INSERT INTO conversations_fts(conversation_id, chunk_index, title, workspace, project, user_body, agent_body) VALUES (?, -1, ?, ?, ?, '', '')",
        (conv_id, "Alpha App Refactor", "alpha-app", "alpha-app"),
    )
    con.commit()
    con.close()

    # Mock agentapi script
    mock_agentapi = tmp_path / "mock_agentapi.py"
    mock_log = tmp_path / "agentapi_calls.json"
    mock_agentapi.write_text(
        f"""import json, sys
from pathlib import Path
log_p = Path({str(mock_log)!r})
calls = json.loads(log_p.read_text(encoding='utf-8')) if log_p.is_file() else []
calls.append(sys.argv[1:])
log_p.write_text(json.dumps(calls), encoding='utf-8')
if sys.argv[1] == "new-conversation":
    print(json.dumps({{"conversationId": "11111111-2222-3333-4444-555555555555"}}))
else:
    print("sent")
""",
        encoding="utf-8",
    )

    monkeypatch.setenv("ZEROG_AGY_DIR", str(agy_dir))
    monkeypatch.setenv("ZEROG_AGY_CONFIG_DIR", str(cfg_dir))
    monkeypatch.setenv("ZEROG_PROJECT_ROOTS", str(scratch_root))
    monkeypatch.setenv("ZEROG_AGENTAPI_BIN", str(mock_agentapi))

    data_dir = tmp_path / "0g_data"
    app = create_app(data_dir=data_dir)
    with TestClient(app) as client:
        # 1. /api/projects has zero fake Video production demo & /api/agy/projects returns real alpha-app
        r_legacy_proj = client.get("/api/projects")
        assert r_legacy_proj.status_code == 200
        legacy_projs = r_legacy_proj.json()
        assert all(not p.get("isSeededDemo") for p in legacy_projs)
        assert all(p["name"].lower() != "video production" for p in legacy_projs)
        assert any(p["name"] == "alpha-app" for p in legacy_projs)

        r_agy_proj = client.get("/api/agy/projects")
        assert r_agy_proj.status_code == 200
        agy_projs = r_agy_proj.json()["projects"]
        assert len(agy_projs) == 1
        alpha = agy_projs[0]
        assert alpha["name"] == "alpha-app"
        assert alpha["gitBranch"] is not None
        assert alpha["dirtyCount"] >= 1
        assert alpha["conversationCount"] == 1

        # 2. /api/agy/conversations (FTS title resolution + subagent filtering)
        r_convs = client.get("/api/agy/conversations", params={"projectPath": alpha["path"]})
        assert r_convs.status_code == 200
        convs = r_convs.json()["conversations"]
        assert len(convs) == 1
        assert convs[0]["id"] == conv_id
        assert convs[0]["title"] == "Alpha App Refactor"
        assert convs[0]["subagentCount"] == 1
        assert convs[0]["hasSwarm"] is True

        r_convs_all = client.get("/api/agy/conversations", params={"includeSubagents": "true"})
        assert r_convs_all.status_code == 200
        assert {c["id"] for c in r_convs_all.json()["conversations"]} == {conv_id, sub_id}

        # 3. /api/agy/conversations/{id} (transcript cleaning, full row resolution, GENERIC preview, swarmPlan)
        r_detail = client.get(f"/api/agy/conversations/{conv_id}")
        assert r_detail.status_code == 200
        detail = r_detail.json()
        assert detail["swarmPlan"]["goal"]["title"] == "Alpha Swarm"
        assert len(detail["subagents"]) == 1
        assert detail["subagents"][0]["id"] == sub_id

        msgs = detail["messages"]
        assert len(msgs) == 3
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "Fix the router"
        assert "ADDITIONAL_METADATA" not in msgs[0]["content"]
        assert msgs[1]["role"] == "assistant"
        assert msgs[1]["content"] == "Resolved full assistant response"
        assert msgs[1]["thinking"] == "Checking main.py"
        assert msgs[1]["toolCalls"][0]["outputPreview"] is not None
        assert 'print("hello")' in msgs[1]["toolCalls"][0]["outputPreview"]
        assert msgs[2]["role"] == "user"
        assert msgs[2]["content"] == "Continue via talker"

        art_paths = {a["relativePath"] for a in detail["artifacts"]}
        assert art_paths == {"report.md", "diagram.png"}

        assert client.get("/api/agy/conversations/bad$id").status_code == 400

        # 4. /api/agy/conversations/{id}/artifact
        r_art_md = client.get(f"/api/agy/conversations/{conv_id}/artifact", params={"path": "report.md"})
        assert r_art_md.status_code == 200
        assert r_art_md.json()["kind"] == "markdown"
        assert "All clear." in r_art_md.json()["content"]

        r_art_img = client.get(f"/api/agy/conversations/{conv_id}/artifact", params={"path": "diagram.png"})
        assert r_art_img.status_code == 200
        assert r_art_img.json()["kind"] == "image"
        assert r_art_img.json()["dataUri"].startswith("data:image/png;base64,")

        assert client.get(
            f"/api/agy/conversations/{conv_id}/artifact",
            params={"path": "../../outside.txt"},
        ).status_code in (400, 403)

        # 5. /api/agy/files/list & /api/agy/files/read
        r_flist = client.get("/api/agy/files/list", params={"projectPath": alpha["path"]})
        assert r_flist.status_code == 200
        names = {e["name"] for e in r_flist.json()["entries"]}
        assert "src" in names
        assert "node_modules" not in names
        assert ".git" not in names

        r_fread = client.get("/api/agy/files/read", params={"projectPath": alpha["path"], "path": "src/main.py"})
        assert r_fread.status_code == 200
        fread_data = r_fread.json()
        assert "sk-proj-abc" not in fread_data["content"]
        assert "[REDACTED:" in fread_data["content"]
        assert 'print("hello")' in fread_data["content"]

        # Secret files & traversal blocked
        assert client.get(
            "/api/agy/files/read",
            params={"projectPath": alpha["path"], "path": ".env"},
        ).status_code == 403
        assert client.get(
            "/api/agy/files/read",
            params={"projectPath": alpha["path"], "path": "../../outside.txt"},
        ).status_code in (400, 403)

        # 6. /api/agy/customizations
        r_cust = client.get("/api/agy/customizations")
        assert r_cust.status_code == 200
        cust = r_cust.json()
        assert any(p["name"] == "0G" for p in cust["plugins"])
        assert any(s["name"] == "custom-skill" and s["source"] == "config" for s in cust["skills"])
        assert any(s["name"] == "builtin-skill" and s["source"] == "builtin" for s in cust["skills"])
        assert any(r["name"] == "AGENTS.md" for r in cust["rules"])
        assert len(cust["slashCommands"]) == 9

        # 7. /api/agy/conversations/new & /api/agy/conversations/{id}/message
        r_new = client.post(
            "/api/agy/conversations/new",
            json={
                "prompt": "Add unit tests",
                "title": "Unit Test Sprint",
                "model": "gemini-4-hydrogen-high",
                "workspacePath": alpha["path"],
            },
        )
        assert r_new.status_code == 200
        new_data = r_new.json()
        assert new_data["ok"] is True
        assert new_data["deliveredVia"] == "agentapi"
        assert new_data["conversationId"] == "11111111-2222-3333-4444-555555555555"

        r_msg = client.post(
            f"/api/agy/conversations/{conv_id}/message",
            json={"message": "Check coverage"},
        )
        assert r_msg.status_code == 200
        assert r_msg.json()["ok"] is True
        assert r_msg.json()["deliveredVia"] == "agentapi"

        recorded_calls = json.loads(mock_log.read_text(encoding="utf-8"))
        assert recorded_calls[0][0] == "new-conversation"
        assert "--title=Unit Test Sprint" in recorded_calls[0]
        assert "--model=gemini-4-hydrogen-high" in recorded_calls[0]
        assert f"[Active Workspace: {alpha['path']}]" in recorded_calls[0][-1]
        assert recorded_calls[1] == ["send-message", conv_id, "Check coverage"]

        # 8. /api/agy/terminal/exec + Tier-3 block + PANIC 423 lock
        r_term = client.post(
            "/api/agy/terminal/exec",
            json={"command": "echo AGY_TERM_OK", "cwd": alpha["path"]},
        )
        assert r_term.status_code == 200
        term_data = r_term.json()
        assert term_data["ok"] is True
        assert term_data["returncode"] == 0
        assert "AGY_TERM_OK" in term_data["stdout"]

        r_term_bad = client.post(
            "/api/agy/terminal/exec",
            json={"command": "rm -rf /", "cwd": alpha["path"]},
        )
        assert r_term_bad.status_code == 403

        # PANIC lock blocks new conversation, send message, and terminal exec with 423
        assert client.post("/api/panic", json={"lockWorkstation": False}).status_code == 200
        assert client.post("/api/agy/conversations/new", json={"prompt": "hi"}).status_code == 423
        assert client.post(f"/api/agy/conversations/{conv_id}/message", json={"message": "hi"}).status_code == 423
        assert client.post("/api/agy/terminal/exec", json={"command": "echo nope"}).status_code == 423
        assert client.post("/api/panic/unlock", json={}).status_code == 200


# ---------------------------------------------------------------------------
# 9. Native Antigravity Remote Control Superpowers E2E
# ---------------------------------------------------------------------------


def test_native_remote_superpowers_e2e(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import sqlite3

    scratch_root = tmp_path / "scratch"
    repo_a = scratch_root / "repo-alpha"
    repo_b = scratch_root / "repo-beta"
    repo_a.mkdir(parents=True)
    repo_b.mkdir(parents=True)

    # Initialize repo_a as a real git repository
    for cmd in (
        ["git", "init"],
        ["git", "config", "user.email", "test@0g.local"],
        ["git", "config", "user.name", "Test User"],
    ):
        subprocess.run(cmd, cwd=str(repo_a), check=True, capture_output=True)
    (repo_a / "README.md").write_text("# Alpha Repo\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(repo_a), check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=str(repo_a), check=True, capture_output=True)
    (repo_b / "notes.md").write_text("# Beta Notes\n", encoding="utf-8")

    # Minimal Antigravity fixture with ask_question + exit_plan_mode + swarm board
    agy_dir = tmp_path / "agy"
    conv_id = "22222222-3333-4444-5555-666666666666"
    sub_id = "sub-2222-1111"
    conv_brain = agy_dir / "brain" / conv_id
    logs_dir = conv_brain / ".system_generated" / "logs"
    swarm_dir = conv_brain / ".system_generated" / "swarm"
    sub_logs = agy_dir / "brain" / sub_id / ".system_generated" / "logs"
    logs_dir.mkdir(parents=True)
    swarm_dir.mkdir(parents=True)
    sub_logs.mkdir(parents=True)

    (swarm_dir / "plan.json").write_text(
        json.dumps(
            {
                "goal": {"title": "Native UI Plan", "line": "Verify swarm overview"},
                "tasks": {"worker-1": "Audit layout"},
                "threads": [{"id": "t1", "title": "UI", "goal": "Audit", "tasks": ["worker-1"]}],
            }
        ),
        encoding="utf-8",
    )
    (swarm_dir / "board.jsonl").write_text(
        json.dumps({"seq": 1, "agent": "worker-1", "text": "Audit done", "time": "2026-11-21 15:00:00"}) + "\n",
        encoding="utf-8",
    )

    transcript_steps = [
        {"step_index": 0, "type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Help me design this"},
        {
            "step_index": 1,
            "type": "PLANNER_RESPONSE",
            "source": "MODEL",
            "content": "Choose a mode and review the plan.",
            "tool_calls": [
                {
                    "name": "ask_question",
                    "args": {
                        "questions": [
                            {
                                "question": "Which layout mode?",
                                "options": ["Software Engineering", "Knowledge Work"],
                                "is_multi_select": False,
                            }
                        ]
                    },
                },
                {
                    "name": "exit_plan_mode",
                    "args": {"title": "UI Overhaul Plan", "plan": "# Step 1\nBuild single canvas."},
                },
            ],
        },
    ]
    (logs_dir / "transcript.jsonl").write_text(
        "\n".join(json.dumps(s) for s in transcript_steps) + "\n",
        encoding="utf-8",
    )
    (sub_logs / "transcript.jsonl").write_text(
        json.dumps({"step_index": 0, "type": "PLANNER_RESPONSE", "content": "Subagent finished check"}) + "\n",
        encoding="utf-8",
    )

    db_file = agy_dir / "conversation_summaries.db"
    con = sqlite3.connect(db_file)
    con.execute(
        "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', step_count INTEGER NOT NULL DEFAULT 0, last_modified_time TEXT NOT NULL, workspace_uris TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '', agent_name TEXT NOT NULL DEFAULT '', parent_conversation_id TEXT NOT NULL DEFAULT '', not_fully_idle INTEGER NOT NULL DEFAULT 0, killed INTEGER NOT NULL DEFAULT 0)"
    )
    con.execute(
        "INSERT INTO conversation_summaries VALUES (?, ?, '', ?, ?, ?, ?, '', 'p1', '', '', 0, 0)",
        (conv_id, "Native Superpowers", 2, "2026-11-21T15:00:00Z", json.dumps([repo_a.resolve().as_uri()]), "CASCADE_RUN_STATUS_IDLE"),
    )
    con.execute(
        "INSERT INTO conversation_summaries VALUES (?, ?, '', ?, ?, ?, ?, '', 'p1', 'worker-1', ?, 0, 0)",
        (sub_id, "Worker 1", 1, "2026-11-21T14:59:00Z", json.dumps([repo_a.resolve().as_uri()]), "CASCADE_RUN_STATUS_IDLE", conv_id),
    )
    con.commit()
    con.close()

    mock_agentapi = tmp_path / "mock_agentapi_super.py"
    mock_log = tmp_path / "agentapi_super_calls.json"
    mock_agentapi.write_text(
        f"""import json, sys
from pathlib import Path
log_p = Path({str(mock_log)!r})
calls = json.loads(log_p.read_text(encoding='utf-8')) if log_p.is_file() else []
calls.append(sys.argv[1:])
log_p.write_text(json.dumps(calls), encoding='utf-8')
print(json.dumps({{"conversationId": "33333333-4444-5555-6666-777777777777"}}))
""",
        encoding="utf-8",
    )

    monkeypatch.setenv("ZEROG_AGY_DIR", str(agy_dir))
    monkeypatch.setenv("ZEROG_PROJECT_ROOTS", str(scratch_root))
    monkeypatch.setenv("ZEROG_AGENTAPI_BIN", str(mock_agentapi))
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    # Start tiny local dev HTTP server for /preview/{port}/ tests
    class _DevHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/assets/app.js":
                body = b"console.log('dev-app-ok');"
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            html_body = b"<!doctype html><html><head><title>Dev</title></head><body><script src=\"/assets/app.js\"></script></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html_body)))
            self.end_headers()
            self.wfile.write(html_body)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

    dev_server = http.server.HTTPServer(("127.0.0.1", 0), _DevHandler)
    dev_port = dev_server.server_address[1]
    dev_thread = threading.Thread(target=dev_server.serve_forever, daemon=True)
    dev_thread.start()

    try:
        data_dir = tmp_path / "0g_data"
        app = create_app(data_dir=data_dir)
        with TestClient(app) as client:
            bridge_tok = _read_bridge_token(data_dir)
            hook_headers = {"X-0G-Bridge-Token": bridge_tok}

            # 1. Settings & Interface Layout
            r_set = client.post(
                "/api/agy/settings",
                json={"interfaceLayout": "knowledge_work", "permissionPreset": "request_review"},
            )
            assert r_set.status_code == 200
            assert r_set.json()["interfaceLayout"] == "knowledge_work"
            assert r_set.json()["permissionPreset"] == "request_review"
            assert r_set.json()["voiceCapabilities"]["fallback"] == "web_speech"

            # Verify request_review pauses even Tier-0 `git status` when phone hold is active!
            r_req_rev = client.post(
                "/api/hooks/dispatch",
                headers={**hook_headers, "X-0G-Hold-Seconds": "0.2"},
                json={
                    "provider": "antigravity",
                    "hookEventName": "PreToolUse",
                    "conversationId": "conv-preset",
                    "cwd": str(repo_a),
                    "toolCall": {"id": "tc-rr", "name": "run_command", "arguments": {"CommandLine": "git status"}},
                },
            )
            assert r_req_rev.status_code == 200
            assert r_req_rev.json()["decision"] == "force_ask"

            # Reset global preset to default & switch back to software_engineering
            assert client.post(
                "/api/agy/settings",
                json={"interfaceLayout": "software_engineering", "permissionPreset": "default"},
            ).status_code == 200

            # 2. Multi-Folder Project Config + Per-Project Permission Preset Override ("auto")
            r_proj_cfg = client.post(
                "/api/agy/projects/configs",
                json={
                    "id": "proj-bundle",
                    "name": "Dual Bundle",
                    "folders": [str(repo_a), str(repo_b)],
                    "permissionPreset": "auto",
                    "defaultWorktreeMode": "worktree",
                },
            )
            assert r_proj_cfg.status_code == 200
            bundle = r_proj_cfg.json()["project"]
            assert bundle["permissionPreset"] == "auto"
            assert len(bundle["folders"]) == 2

            # Verify merged /api/agy/projects includes Dual Bundle
            merged = client.get("/api/agy/projects").json()["projects"]
            assert any(p["id"] == "proj-bundle" and len(p["folders"]) == 2 for p in merged)

            # Verify Tier-1 command inside repo_a auto-allows because repo_a belongs to "auto" project preset!
            r_auto_proj = client.post(
                "/api/hooks/dispatch",
                headers=hook_headers,
                json={
                    "provider": "antigravity",
                    "hookEventName": "PreToolUse",
                    "conversationId": "conv-preset",
                    "cwd": str(repo_a),
                    "toolCall": {"id": "tc-auto", "name": "run_command", "arguments": {"CommandLine": "pytest tests"}},
                },
            )
            assert r_auto_proj.status_code == 200
            assert r_auto_proj.json()["decision"] == "allow"

            # 3. Worktree Mode on /api/agy/conversations/new
            r_wt_conv = client.post(
                "/api/agy/conversations/new",
                json={
                    "prompt": "Refactor dual repo",
                    "workspacePath": str(repo_a),
                    "folders": [str(repo_a), str(repo_b)],
                    "worktreeMode": "worktree",
                    "branchName": "agy-wt-test",
                },
            )
            assert r_wt_conv.status_code == 200
            wt_res = r_wt_conv.json()
            assert wt_res["ok"] is True
            assert wt_res["branchName"] == "agy-wt-test"
            assert os.path.isdir(wt_res["worktreePath"])
            # Cleanup created worktree cleanly
            client.post(
                "/api/git/worktree/discard",
                json={"repoPath": str(repo_a), "worktreePath": wt_res["worktreePath"], "branchName": "agy-wt-test"},
            )

            # 4. File/Photo Upload into workspace + security blocks
            png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode("ascii")
            r_up = client.post(
                "/api/agy/upload",
                json={"projectPath": str(repo_a), "filename": "phone shot.png", "dataBase64": f"data:image/png;base64,{png_b64}"},
            )
            assert r_up.status_code == 200
            up_data = r_up.json()
            assert up_data["ok"] is True
            assert up_data["relPath"].startswith(".antigravity_uploads/")
            assert up_data["mentionToken"] == f"@{up_data['relPath']}"
            assert (repo_a / up_data["relPath"]).is_file()

            assert client.post(
                "/api/agy/upload",
                json={"projectPath": str(repo_a), "filename": ".env", "dataBase64": png_b64},
            ).status_code == 403
            assert client.post(
                "/api/agy/upload",
                json={"projectPath": str(repo_a), "filename": "payload.exe", "dataBase64": png_b64},
            ).status_code == 403

            # 5. Git Commit (push=False)
            (repo_a / "feature.txt").write_text("hello from mobile\n", encoding="utf-8")
            r_commit = client.post(
                "/api/git/commit-push",
                json={"repoPath": str(repo_a), "message": "Add feature.txt from mobile", "push": False},
            )
            assert r_commit.status_code == 200
            c_data = r_commit.json()
            assert c_data["ok"] is True
            assert c_data["committed"] is True
            assert c_data["pushed"] is False
            assert len(c_data["commitSha"]) >= 7

            # 6. Interactive Plan Review, Ask Question, Swarm Board & Nudge
            detail = client.get(f"/api/agy/conversations/{conv_id}").json()
            asst_msg = detail["messages"][1]
            assert asst_msg["pendingQuestions"][0]["question"] == "Which layout mode?"
            assert asst_msg["pendingQuestions"][0]["options"] == ["Software Engineering", "Knowledge Work"]
            assert asst_msg["planReview"]["title"] == "UI Overhaul Plan"
            assert asst_msg["planReview"]["canProceed"] is True

            swarm_data = client.get(f"/api/agy/conversations/{conv_id}/swarm").json()
            assert swarm_data["hasSwarm"] is True
            assert swarm_data["boardMessages"][0]["text"] == "Audit done"
            assert swarm_data["subagents"][0]["latestMessage"] == "Subagent finished check"

            r_nudge = client.post(
                f"/api/agy/conversations/{conv_id}/nudge",
                json={"targetConversationId": sub_id, "message": "Wrap up now"},
            )
            assert r_nudge.status_code == 200
            assert r_nudge.json()["conversationId"] == sub_id

            # 7. Live Localhost Preview Proxy (/preview/{port}/) + Loop Block + Non-loopback Auth & Cookie
            assert client.get("/api/agy/ports").status_code == 200
            assert client.get("/preview/8790/").status_code == 400
            assert client.get("/preview/22/").status_code == 400

            r_prev = client.get(f"/preview/{dev_port}/")
            assert r_prev.status_code == 200
            assert f'<base href="/preview/{dev_port}/">' in r_prev.text
            assert f'src="/preview/{dev_port}/assets/app.js"' in r_prev.text

            # Non-loopback auth enforcement + ?token= sets zerog_session cookie
            pair_code = client.post("/api/pairing/code", json={}).json()["code"]
            mob_tok = client.post("/api/pairing/claim", json={"code": pair_code}).json()["sessionToken"]
            client.cookies.clear()
            ext_headers = {"Host": "remote.trycloudflare.com"}
            assert client.get(f"/preview/{dev_port}/", headers=ext_headers).status_code == 401
            r_ext_ok = client.get(f"/preview/{dev_port}/?token={mob_tok}", headers=ext_headers)
            assert r_ext_ok.status_code == 200
            assert "zerog_session" in r_ext_ok.cookies
            r_ext_asset = client.get(f"/preview/{dev_port}/assets/app.js", headers=ext_headers)
            assert r_ext_asset.status_code == 200
            assert "dev-app-ok" in r_ext_asset.text

            # 8. /ws/voice WebSocket fallback + tool invocation
            with client.websocket_connect(f"/ws/voice?conversationId={conv_id}") as ws_v:
                mode_frame = ws_v.receive_json()
                assert mode_frame["type"] == "voice.mode"
                assert mode_frame["mode"] == "fallback_web_speech"
                ws_v.send_json({"type": "text_command", "text": "Summarize changes"})
                tr_frame = ws_v.receive_json()
                assert tr_frame["type"] == "voice.transcript"
                tool_frame = ws_v.receive_json()
                assert tool_frame["type"] == "voice.tool_result"
                assert tool_frame["result"]["ok"] is True
                reply_frame = ws_v.receive_json()
                assert reply_frame["type"] == "voice.assistant_text"

            # 9. /api/agy/autostart + custom project deletion
            r_auto_cfg = client.get("/api/agy/autostart")
            assert r_auto_cfg.status_code == 200
            assert "notifyEmail" in r_auto_cfg.json()
            assert client.delete("/api/agy/projects/configs/proj-bundle").json()["ok"] is True
    finally:
        dev_server.shutdown()
        dev_server.server_close()


