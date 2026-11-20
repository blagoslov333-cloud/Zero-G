"""Ultra-fast zero-dependency hook shim for Antigravity, Claude Code, Codex CLI, and Grok Build.

Invoked via: python.exe -I -S hooks/shim.py --provider antigravity --event PreToolUse
Strictly emits ONLY valid JSON to stdout; zero debug prints.
"""

import http.client
import json
import os
import socket
import sys
import urllib.parse


def _parse_args(argv):
    provider = "antigravity"
    event = ""
    url = os.environ.get("ZEROG_DAEMON_URL", "http://127.0.0.1:8790/api/hooks/dispatch")
    i = 1
    n = len(argv)
    while i < n:
        arg = argv[i]
        if arg == "--provider" and i + 1 < n:
            provider = argv[i + 1].strip()
            i += 2
        elif arg.startswith("--provider="):
            provider = arg.split("=", 1)[1].strip()
            i += 1
        elif arg == "--event" and i + 1 < n:
            event = argv[i + 1].strip()
            i += 2
        elif arg.startswith("--event="):
            event = arg.split("=", 1)[1].strip()
            i += 1
        elif arg == "--url" and i + 1 < n:
            url = argv[i + 1].strip()
            i += 2
        elif arg.startswith("--url="):
            url = arg.split("=", 1)[1].strip()
            i += 1
        else:
            i += 1
    return provider, event, url


def _read_stdin_json():
    try:
        if sys.stdin is None or sys.stdin.closed:
            return {}
        raw_text = sys.stdin.read()
        if not raw_text or not raw_text.strip():
            return {}
        parsed = json.loads(raw_text)
        return parsed if isinstance(parsed, dict) else {"raw": parsed}
    except Exception:
        return {}


def _read_bridge_token():
    candidates = []
    env_dir = os.environ.get("ZEROG_DATA_DIR")
    if env_dir:
        candidates.append(os.path.join(env_dir, "bridge.token"))
    home = os.path.expanduser("~")
    if home and home != "~":
        candidates.append(os.path.join(home, ".0g", "data", "bridge.token"))
    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        candidates.append(os.path.join(userprofile, ".0g", "data", "bridge.token"))
    candidates.append(r"C:\Users\blagoslov333\.0g\data\bridge.token")
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(os.path.dirname(here), ".0g", "data", "bridge.token"))

    for path in candidates:
        try:
            if os.path.isfile(path):
                with open(path, "r", encoding="utf-8") as f:
                    tok = f.read().strip()
                    if tok:
                        return tok
        except Exception:
            continue
    return ""


def _normalize_payload(provider, event, raw_in):
    hook_event = (
        event
        or raw_in.get("hookEventName")
        or raw_in.get("hook_event_name")
        or raw_in.get("event")
        or "PreToolUse"
    )
    conv_id = (
        raw_in.get("conversationId")
        or raw_in.get("session_id")
        or raw_in.get("sessionId")
        or "default"
    )
    tool_call = raw_in.get("toolCall")
    if not isinstance(tool_call, dict):
        tool_name = raw_in.get("tool_name") or raw_in.get("toolName") or raw_in.get("name")
        tool_input = raw_in.get("tool_input") or raw_in.get("toolInput") or raw_in.get("arguments") or raw_in.get("args")
        if tool_name:
            tool_call = {
                "id": raw_in.get("tool_use_id") or raw_in.get("toolCallId") or "tc-shim",
                "name": tool_name,
                "arguments": tool_input if isinstance(tool_input, dict) else ({"input": tool_input} if tool_input is not None else {}),
            }

    workspace_paths = raw_in.get("workspacePaths")
    if not isinstance(workspace_paths, list):
        workspace_paths = []
    cwd = raw_in.get("cwd") or (workspace_paths[0] if workspace_paths else None)

    return {
        "provider": provider if provider in ("antigravity", "claude_code", "codex_cli", "grok_build") else "antigravity",
        "hookEventName": str(hook_event),
        "conversationId": str(conv_id),
        "workspacePaths": [str(p) for p in workspace_paths],
        "transcriptPath": raw_in.get("transcriptPath") or raw_in.get("transcript_path"),
        "artifactDirectoryPath": raw_in.get("artifactDirectoryPath") or raw_in.get("artifact_directory_path"),
        "modelName": raw_in.get("modelName") or raw_in.get("model"),
        "lastUserInput": raw_in.get("lastUserInput") or raw_in.get("prompt"),
        "cwd": cwd,
        "stepIdx": raw_in.get("stepIdx") if isinstance(raw_in.get("stepIdx"), int) else None,
        "toolCall": tool_call,
        "error": raw_in.get("error"),
        "terminationReason": raw_in.get("terminationReason"),
        "continuationActive": bool(raw_in.get("continuationActive", False)),
        "raw": raw_in,
    }


def _format_provider_output(provider, event_name, resp):
    decision = resp.get("decision", "ok")
    reason = resp.get("reason")
    overwrite = resp.get("overwrite")
    perm_overrides = resp.get("permissionOverrides") or []
    inject_steps = resp.get("injectSteps") or []
    term_behavior = resp.get("terminationBehavior") or ""

    if provider == "claude_code":
        if event_name == "PreToolUse":
            perm_dec = "allow" if decision == "allow" else ("deny" if decision == "deny" else "ask")
            hook_out = {
                "hookEventName": "PreToolUse",
                "permissionDecision": perm_dec,
            }
            if reason:
                hook_out["permissionDecisionReason"] = reason
            if isinstance(overwrite, dict) and overwrite:
                hook_out["updatedInput"] = overwrite
            out = {"hookSpecificOutput": hook_out, "decision": decision}
            exit_code = 2 if decision == "deny" else 0
            return exit_code, out
        out = {}
        if inject_steps:
            out["injectSteps"] = inject_steps
        if decision == "deny" or term_behavior == "terminate":
            out["decision"] = "block"
            if reason:
                out["reason"] = reason
            return 2, out
        return 0, out

    if provider == "codex_cli":
        if event_name == "PreToolUse":
            out = {"decision": "ask" if decision == "force_ask" else decision}
            if reason:
                out["reason"] = reason
            if isinstance(overwrite, dict) and overwrite:
                out["overwrite"] = overwrite
            return (2 if decision == "deny" else 0), out
        return 0, ({} if decision == "ok" and not inject_steps else {"decision": decision, "injectSteps": inject_steps})

    if provider == "grok_build":
        if event_name == "PreToolUse":
            perm_dec = "allow" if decision == "allow" else ("deny" if decision == "deny" else "ask")
            out = {
                "decision": decision,
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": perm_dec,
                    "permissionDecisionReason": reason or "",
                },
            }
            if isinstance(overwrite, dict) and overwrite:
                out["overwrite"] = overwrite
                out["hookSpecificOutput"]["updatedInput"] = overwrite
            return (2 if decision == "deny" else 0), out
        return 0, ({} if decision == "ok" else {"decision": decision})

    # Default: Antigravity native hook contract
    if event_name == "PreToolUse":
        out = {"decision": decision if decision in ("allow", "deny", "ask", "force_ask") else "ask"}
        if reason:
            out["reason"] = reason
        if isinstance(overwrite, dict) and overwrite:
            out["overwrite"] = overwrite
        if perm_overrides:
            out["permissionOverrides"] = perm_overrides
        return 0, out

    out = {}
    if decision not in ("ok", "continue", ""):
        out["decision"] = decision
    if reason:
        out["reason"] = reason
    if perm_overrides:
        out["permissionOverrides"] = perm_overrides
    if inject_steps:
        out["injectSteps"] = inject_steps
    if term_behavior:
        out["terminationBehavior"] = term_behavior
    return 0, out


def _emit(exit_code, payload_dict):
    sys.stdout.write(json.dumps(payload_dict, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(exit_code)


def main():
    provider, cli_event, url = _parse_args(sys.argv)
    raw_in = _read_stdin_json()
    payload = _normalize_payload(provider, cli_event, raw_in)
    event_name = payload["hookEventName"]
    is_pre_tool = event_name == "PreToolUse"

    token = _read_bridge_token()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if token:
        headers["X-0G-Bridge-Token"] = token
        headers["Authorization"] = "Bearer " + token

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    parsed_url = urllib.parse.urlsplit(url)
    host = parsed_url.hostname or "127.0.0.1"
    port = parsed_url.port or 8790
    path = parsed_url.path or "/api/hooks/dispatch"
    if parsed_url.query:
        path = path + "?" + parsed_url.query

    # Fast 0.25s TCP connect timeout so offline daemon degrades in <300ms on Windows
    conn = http.client.HTTPConnection(host, port, timeout=0.25)
    try:
        conn.connect()
    except Exception:
        conn.close()
        if is_pre_tool:
            exit_code, formatted = _format_provider_output(provider, event_name, {"decision": "ask"})
            _emit(exit_code, formatted)
        else:
            _emit(0, {})

    # Connected to live daemon -> switch socket read timeout to 28s for PreToolUse hold (1.8s otherwise)
    read_timeout = 28.0 if is_pre_tool else 1.8
    try:
        if conn.sock is not None:
            conn.sock.settimeout(read_timeout)
        conn.request("POST", path, body=body, headers=headers)
        resp = conn.getresponse()
        resp_bytes = resp.read()
        resp_data = json.loads(resp_bytes.decode("utf-8")) if resp_bytes else {}
        if not isinstance(resp_data, dict):
            resp_data = {}
        if resp.status >= 400 and "decision" not in resp_data:
            if is_pre_tool:
                resp_data = {"decision": "ask"}
            else:
                _emit(0, {})
    except (TimeoutError, socket.timeout):
        if is_pre_tool:
            resp_data = {"decision": "force_ask", "reason": "Escalated from 0G inbox"}
        else:
            _emit(0, {})
    except Exception:
        if is_pre_tool:
            resp_data = {"decision": "ask"}
        else:
            _emit(0, {})
    finally:
        try:
            conn.close()
        except Exception:
            pass

    exit_code, formatted = _format_provider_output(provider, event_name, resp_data)
    _emit(exit_code, formatted)


if __name__ == "__main__":
    main()
