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
            for _ in range(20):
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

    # TunnelSupervisor QR SVG + status fields
    tsup = TunnelSupervisor(local_port=8790)
    tstat = tsup.get_status()
    assert "cloudflaredInstalled" in tstat
    assert "tailscaleInstalled" in tstat
    assert "qrSvg" in tstat
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
