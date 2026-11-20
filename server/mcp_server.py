"""Pure Stdio JSON-RPC 2.0 MCP server exposing 0G phone-authored tools dynamically."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Ensure repo root is importable when launched directly via `python server/mcp_server.py`.
_REPO_ROOT = str(Path(__file__).resolve().parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[0g-mcp] %(levelname)s %(message)s",
)
logger = logging.getLogger("0g.mcp")

SUPPORTED_PROTOCOL_VERSIONS = ("2025-03-26", "2024-11-05")
DEFAULT_DAEMON_URL = "http://127.0.0.1:8790"


def _daemon_base_url() -> str:
    return os.environ.get("ZEROG_DAEMON_URL", DEFAULT_DAEMON_URL).rstrip("/")


def _load_bridge_token() -> str:
    env_tok = os.environ.get("ZEROG_BRIDGE_TOKEN", "").strip()
    if env_tok:
        return env_tok
    data_dir = Path(os.environ.get("ZEROG_DATA_DIR", str(Path.home() / ".0g" / "data"))).expanduser()
    token_file = data_dir / "bridge.token"
    try:
        if token_file.is_file():
            return token_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        logger.warning("Failed reading bridge.token: %s", exc)
    return ""


def _http_json(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    timeout: float = 5.0,
) -> Any:
    url = f"{_daemon_base_url()}{path}"
    headers = {"Accept": "application/json"}
    token = _load_bridge_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["X-0G-Bridge-Token"] = token
        headers["X-0G-Token"] = token
    data: bytes | None = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw.strip() else {}


def _fallback_local_tools() -> list[dict[str, Any]]:
    """Load built-in + SQLite-stored mobile tools when the daemon HTTP API is offline."""
    try:
        from server.mobile_tools import MobileToolRegistry
    except Exception as exc:
        logger.warning("Local MobileToolRegistry fallback unavailable: %s", exc)
        return []

    db = None
    db_path = Path(os.environ.get("ZEROG_DATA_DIR", str(Path.home() / ".0g" / "data"))).expanduser() / "0g.sqlite3"
    if db_path.is_file():
        try:
            from server.db import ZeroGDatabase  # type: ignore[import-not-found]

            db = ZeroGDatabase(str(db_path))
        except Exception as exc:
            logger.debug("Could not open local SQLite DB fallback: %s", exc)

    async def _load() -> list[dict[str, Any]]:
        reg = MobileToolRegistry(db=db)
        await reg.seed_builtins()
        specs = await reg.list_tools(enabled_only=True)
        return [spec.model_dump() for spec in specs]

    try:
        return asyncio.run(_load())
    except Exception as exc:
        logger.warning("Fallback tool load failed: %s", exc)
        return []


def fetch_mobile_tools() -> list[dict[str, Any]]:
    """Fetch current enabled mobile tools live from daemon (or local fallback)."""
    try:
        data = _http_json("GET", "/api/mobile-tools", timeout=3.0)
        raw_list = data.get("tools", []) if isinstance(data, dict) else data
        if not isinstance(raw_list, list):
            raw_list = []
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        logger.info("Daemon HTTP unavailable for tools/list (%s); using local fallback", exc)
        raw_list = _fallback_local_tools()

    mcp_tools: list[dict[str, Any]] = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        if item.get("enabled") is False:
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        schema = item.get("parametersSchema")
        if not isinstance(schema, dict) or schema.get("type") != "object":
            schema = {"type": "object", "properties": {}, "required": []}
        mcp_tools.append(
            {
                "name": name,
                "description": str(item.get("description") or f"0G mobile tool {name}"),
                "inputSchema": schema,
            }
        )
    return mcp_tools


def invoke_mobile_tool(tool_name: str, arguments: dict[str, Any]) -> tuple[bool, Any]:
    """Invoke a mobile tool through the daemon HTTP bridge."""
    payload = {
        "toolName": tool_name,
        "arguments": arguments,
        "timeoutSec": 18.0,
    }
    try:
        resp = _http_json("POST", "/api/mobile-tools/invoke", body=payload, timeout=22.0)
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        return False, f"HTTP {exc.code}: {err_body or exc.reason}"
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return False, f"0G daemon unreachable at {_daemon_base_url()}: {exc}"

    if not isinstance(resp, dict):
        return True, resp
    ok = bool(resp.get("ok", True))
    if ok:
        return True, resp.get("result") if "result" in resp else resp
    return False, resp.get("error") or "Mobile tool invocation failed"


def _write_rpc(message: dict[str, Any]) -> None:
    """Write one newline-delimited JSON-RPC 2.0 frame strictly to stdout."""
    encoded = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


def _rpc_result(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def handle_message(msg: dict[str, Any]) -> dict[str, Any] | None:
    """Dispatch a single JSON-RPC 2.0 request or notification."""
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    is_notification = "id" not in msg or req_id is None

    if not isinstance(method, str):
        if is_notification:
            return None
        return _rpc_error(req_id, -32600, "Invalid Request: missing method")

    if method == "notifications/initialized" or method.startswith("notifications/"):
        return None

    if method == "initialize":
        requested = params.get("protocolVersion")
        negotiated = (
            requested
            if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS
            else SUPPORTED_PROTOCOL_VERSIONS[0]
        )
        return _rpc_result(
            req_id,
            {
                "protocolVersion": negotiated,
                "capabilities": {
                    "tools": {"listChanged": True},
                },
                "serverInfo": {
                    "name": "0g-phone-mcp",
                    "version": "0.1.0",
                },
            },
        )

    if method == "ping":
        return _rpc_result(req_id, {})

    if method == "tools/list":
        tools = fetch_mobile_tools()
        return _rpc_result(req_id, {"tools": tools})

    if method == "tools/call":
        tool_name = params.get("name")
        if not isinstance(tool_name, str) or not tool_name:
            return _rpc_error(req_id, -32602, "Invalid params: 'name' is required")
        raw_args = params.get("arguments")
        args = raw_args if isinstance(raw_args, dict) else {}
        ok, outcome = invoke_mobile_tool(tool_name, args)
        if isinstance(outcome, str):
            text_out = outcome
        else:
            text_out = json.dumps(outcome, indent=2, ensure_ascii=False)
        return _rpc_result(
            req_id,
            {
                "content": [{"type": "text", "text": text_out}],
                "isError": not ok,
            },
        )

    if is_notification:
        return None
    return _rpc_error(req_id, -32601, f"Method not found: {method}")


def serve_stdio() -> int:
    """Main blocking JSON-RPC 2.0 stdio loop."""
    logger.info("0G Phone MCP stdio server started (daemon=%s)", _daemon_base_url())
    while True:
        raw_line = sys.stdin.readline()
        if not raw_line:
            break
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            logger.warning("Malformed JSON-RPC input: %s", exc)
            _write_rpc(_rpc_error(None, -32700, f"Parse error: {exc}"))
            continue

        if not isinstance(msg, dict):
            _write_rpc(_rpc_error(None, -32600, "Invalid Request: expected JSON object"))
            continue

        try:
            reply = handle_message(msg)
        except Exception as exc:
            logger.exception("Unhandled error handling %s", msg.get("method"))
            if "id" in msg and msg["id"] is not None:
                reply = _rpc_error(msg["id"], -32603, f"Internal error: {exc}")
            else:
                reply = None

        if reply is not None:
            _write_rpc(reply)
    return 0


if __name__ == "__main__":
    raise SystemExit(serve_stdio())
