"""Phone-Authored Tools registry and WebSocket RPC dispatcher for 0G."""

from __future__ import annotations

import asyncio
import inspect
import os
import re
import time
import uuid
from typing import Any, Callable

from server.contracts import (
    MobileToolCreateRequest,
    MobileToolResultRequest,
    MobileToolSpec,
)

TOOL_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{1,48}$")
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}|\{\s*([a-zA-Z0-9_]+)\s*\}")
_MAX_TIMEOUT_SEC = 20.0
_MAX_CMD_OUTPUT_CHARS = 16000


async def _maybe_await(fn_or_val: Any, *args: Any, **kwargs: Any) -> Any:
    res = fn_or_val(*args, **kwargs) if callable(fn_or_val) else fn_or_val
    if inspect.isawaitable(res):
        return await res
    return res


def sanitize_tool_name(raw_name: str) -> str:
    """Sanitize and validate a custom mobile tool name against ^[a-z][a-z0-9_]{1,48}$."""
    cleaned = raw_name.strip().lower().replace("-", "_").replace(" ", "_")
    cleaned = re.sub(r"[^a-z0-9_]", "", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    if not TOOL_NAME_PATTERN.fullmatch(cleaned):
        raise ValueError(
            f"Invalid tool name {raw_name!r}; must sanitize to ^[a-z][a-z0-9_]{{1,48}}$"
        )
    return cleaned


def _ps_quote(value: Any) -> str:
    """Escape a template argument safely for PowerShell / shell substitution."""
    text = str(value)
    return "'" + text.replace("'", "''") + "'"


def render_host_command(template: str, arguments: dict[str, Any]) -> str:
    """Substitute {{arg}} or {arg} placeholders in a host command template safely."""
    def _replace(match: re.Match[str]) -> str:
        key = match.group(1) or match.group(2)
        if key not in arguments:
            return "''"
        return _ps_quote(arguments[key])

    return _PLACEHOLDER_RE.sub(_replace, template)


def _builtin_specs(now: float) -> list[MobileToolSpec]:
    """Return the 6 built-in phone tools available immediately via MCP."""
    return [
        MobileToolSpec(
            id="builtin-phone_notify_card",
            name="phone_notify_card",
            description="Render a rich notification card and optional chime on the paired phone.",
            runtime="phone_builtin",
            parametersSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Card headline"},
                    "body": {"type": "string", "description": "Card body message"},
                    "level": {
                        "type": "string",
                        "enum": ["info", "success", "warning", "urgent"],
                        "default": "info",
                    },
                    "chime": {"type": "boolean", "default": True},
                },
                "required": ["title", "body"],
            },
            code="",
            requiresApproval=False,
            enabled=True,
            createdAt=now,
            updatedAt=now,
        ),
        MobileToolSpec(
            id="builtin-phone_ask_input",
            name="phone_ask_input",
            description="Prompt the user on their phone for text input or a quick button choice and return their reply.",
            runtime="phone_builtin",
            parametersSchema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "Question to display on the phone"},
                    "choices": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional quick-reply button labels",
                    },
                    "placeholder": {"type": "string", "description": "Input placeholder text"},
                    "default": {"type": "string", "description": "Default value"},
                },
                "required": ["prompt"],
            },
            code="",
            requiresApproval=False,
            enabled=True,
            createdAt=now,
            updatedAt=now,
        ),
        MobileToolSpec(
            id="builtin-phone_read_clipboard",
            name="phone_read_clipboard",
            description="Read the current clipboard text from the paired phone PWA.",
            runtime="phone_builtin",
            parametersSchema={
                "type": "object",
                "properties": {
                    "reason": {"type": "string", "description": "Why the agent is requesting clipboard text"},
                },
                "required": [],
            },
            code="",
            requiresApproval=False,
            enabled=True,
            createdAt=now,
            updatedAt=now,
        ),
        MobileToolSpec(
            id="builtin-phone_capture_photo",
            name="phone_capture_photo",
            description="Request a photo snapshot or file upload from the phone camera or file picker.",
            runtime="phone_builtin",
            parametersSchema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "Instructions shown to the user"},
                    "accept": {"type": "string", "default": "image/*"},
                    "cameraFacing": {"type": "string", "enum": ["environment", "user"], "default": "environment"},
                },
                "required": [],
            },
            code="",
            requiresApproval=False,
            enabled=True,
            createdAt=now,
            updatedAt=now,
        ),
        MobileToolSpec(
            id="builtin-phone_get_location",
            name="phone_get_location",
            description="Request the phone's current browser Geolocation coordinates (latitude/longitude).",
            runtime="phone_builtin",
            parametersSchema={
                "type": "object",
                "properties": {
                    "reason": {"type": "string", "description": "Why location is needed"},
                    "highAccuracy": {"type": "boolean", "default": False},
                },
                "required": [],
            },
            code="",
            requiresApproval=False,
            enabled=True,
            createdAt=now,
            updatedAt=now,
        ),
        MobileToolSpec(
            id="builtin-phone_speak_tts",
            name="phone_speak_tts",
            description="Speak a short status message aloud on the phone using Web Speech API.",
            runtime="phone_builtin",
            parametersSchema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Short phrase to speak aloud"},
                    "rate": {"type": "number", "default": 1.0},
                    "pitch": {"type": "number", "default": 1.0},
                },
                "required": ["text"],
            },
            code="",
            requiresApproval=False,
            enabled=True,
            createdAt=now,
            updatedAt=now,
        ),
    ]


class MobileToolRegistry:
    """Manages built-in and phone-authored MCP tools plus async RPC invocation tickets."""

    def __init__(self, db: Any = None) -> None:
        self.db = db
        self._memory_tools: dict[str, MobileToolSpec] = {}
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}

    async def seed_builtins(self) -> list[MobileToolSpec]:
        """Idempotently ensure all 6 built-in phone tools exist in storage."""
        now = time.time()
        existing = {tool.name: tool for tool in await self.list_tools(enabled_only=False)}
        seeded: list[MobileToolSpec] = []
        for spec in _builtin_specs(now):
            if spec.name not in existing:
                await self._save_tool(spec)
                seeded.append(spec)
            else:
                seeded.append(existing[spec.name])
        return seeded

    async def _save_tool(self, spec: MobileToolSpec) -> None:
        if self.db is not None and hasattr(self.db, "upsert_mobile_tool"):
            await _maybe_await(self.db.upsert_mobile_tool, spec)
        else:
            self._memory_tools[spec.id] = spec

    async def list_tools(self, enabled_only: bool = False) -> list[MobileToolSpec]:
        """Return all registered mobile tools (optionally filtered to enabled only)."""
        if self.db is not None and hasattr(self.db, "list_mobile_tools"):
            raw_tools = await _maybe_await(self.db.list_mobile_tools)
            tools = [
                t if isinstance(t, MobileToolSpec) else MobileToolSpec.model_validate(t)
                for t in (raw_tools or [])
            ]
        else:
            tools = list(self._memory_tools.values())

        if enabled_only:
            tools = [t for t in tools if t.enabled]
        tools.sort(key=lambda t: (0 if t.runtime == "phone_builtin" else 1, t.name))
        return tools

    async def get_tool(self, name: str) -> MobileToolSpec | None:
        """Look up a mobile tool by exact name."""
        if self.db is not None and hasattr(self.db, "get_mobile_tool_by_name"):
            found = await _maybe_await(self.db.get_mobile_tool_by_name, name)
            if found is None:
                return None
            return found if isinstance(found, MobileToolSpec) else MobileToolSpec.model_validate(found)

        for tool in self._memory_tools.values():
            if tool.name == name:
                return tool
        return None

    async def create_tool(self, req: MobileToolCreateRequest) -> MobileToolSpec:
        """Register or update a user-authored mobile tool (phone_js or host_command)."""
        if req.runtime not in ("phone_js", "host_command"):
            raise ValueError("Custom tools must use runtime='phone_js' or 'host_command'")

        clean_name = sanitize_tool_name(req.name)
        existing = await self.get_tool(clean_name)
        if existing is not None and existing.runtime == "phone_builtin":
            raise ValueError(f"Cannot overwrite built-in phone tool {clean_name!r}")

        schema = dict(req.parametersSchema) if isinstance(req.parametersSchema, dict) else {}
        if schema.get("type") != "object":
            schema["type"] = "object"
        if not isinstance(schema.get("properties"), dict):
            schema["properties"] = {}
        if not isinstance(schema.get("required"), list):
            schema["required"] = []

        now = time.time()
        spec = MobileToolSpec(
            id=existing.id if existing else f"mtool-{uuid.uuid4().hex[:10]}",
            name=clean_name,
            description=req.description.strip() or f"Custom {req.runtime} tool {clean_name}",
            runtime=req.runtime,
            parametersSchema=schema,
            code=req.code,
            requiresApproval=bool(req.requiresApproval),
            enabled=True,
            createdAt=existing.createdAt if existing else now,
            updatedAt=now,
        )
        await self._save_tool(spec)
        return spec

    async def delete_tool(self, tool_id: str) -> bool:
        """Delete a user-authored mobile tool by id or name (built-ins are protected)."""
        tools = await self.list_tools(enabled_only=False)
        target = next((t for t in tools if t.id == tool_id or t.name == tool_id), None)
        if target is None:
            return False
        if target.runtime == "phone_builtin":
            raise ValueError(f"Cannot delete built-in phone tool {target.name!r}")

        if self.db is not None and hasattr(self.db, "delete_mobile_tool"):
            await _maybe_await(self.db.delete_mobile_tool, target.id)
            return True
        return self._memory_tools.pop(target.id, None) is not None

    def resolve_result(self, req: MobileToolResultRequest) -> bool:
        """Resolve an awaiting phone RPC ticket from WebSocket or POST /api/mobile-tools/result."""
        fut = self._pending.get(req.ticketId)
        if fut is None or fut.done():
            return False
        if req.ok:
            fut.set_result({"ok": True, "ticketId": req.ticketId, "result": req.result})
        else:
            fut.set_result(
                {
                    "ok": False,
                    "ticketId": req.ticketId,
                    "error": req.error or "Phone tool execution failed",
                }
            )
        return True

    async def invoke_via_daemon(
        self,
        tool_name: str,
        args: dict[str, Any] | None = None,
        ws_broadcaster: Callable[[dict[str, Any]], Any] | None = None,
        session_id: str | None = None,
        timeout_sec: float = 18.0,
        rules_engine: Any = None,
        cwd: str | None = None,
    ) -> dict[str, Any]:
        """Dispatch a mobile tool either locally (host_command) or via WebSocket RPC to the phone."""
        tool = await self.get_tool(tool_name)
        if tool is None:
            return {"ok": False, "error": f"Unknown mobile tool: {tool_name}"}
        if not tool.enabled:
            return {"ok": False, "error": f"Mobile tool {tool_name!r} is disabled"}

        clamped_timeout = min(max(float(timeout_sec), 1.0), _MAX_TIMEOUT_SEC)
        call_args = dict(args or {})

        if tool.runtime == "host_command":
            return await self._invoke_host_command(
                tool=tool,
                args=call_args,
                timeout_sec=clamped_timeout,
                rules_engine=rules_engine,
                cwd=cwd,
            )

        ticket_id = f"mt-{uuid.uuid4().hex[:12]}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[ticket_id] = fut

        payload = {
            "ticketId": ticket_id,
            "toolName": tool.name,
            "runtime": tool.runtime,
            "description": tool.description,
            "arguments": call_args,
            "code": tool.code if tool.runtime == "phone_js" else "",
            "requiresApproval": tool.requiresApproval,
            "sessionId": session_id,
            "timeoutSec": clamped_timeout,
        }

        try:
            if ws_broadcaster is not None:
                await _maybe_await(ws_broadcaster, payload)
            elif self.db is not None and hasattr(self.db, "emit_event"):
                await _maybe_await(
                    self.db.emit_event,
                    "mobile_tool_request",
                    payload,
                    session_id=session_id,
                )
            else:
                return {
                    "ok": False,
                    "ticketId": ticket_id,
                    "error": "No WebSocket broadcaster or event store available to reach phone",
                }

            return await asyncio.wait_for(fut, timeout=clamped_timeout)
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "ticketId": ticket_id,
                "error": f"Phone did not respond to {tool.name} within {clamped_timeout:.0f}s",
            }
        finally:
            self._pending.pop(ticket_id, None)

    async def _invoke_host_command(
        self,
        *,
        tool: MobileToolSpec,
        args: dict[str, Any],
        timeout_sec: float,
        rules_engine: Any,
        cwd: str | None,
    ) -> dict[str, Any]:
        """Evaluate a host_command mobile tool against RulesEngine and run it securely."""
        if not tool.code.strip():
            return {"ok": False, "error": f"host_command tool {tool.name!r} has an empty command template"}

        rendered = render_host_command(tool.code, args)

        engine = rules_engine
        if engine is None and self.db is not None:
            try:
                from server.rules_engine import RulesEngine  # type: ignore[import-not-found]

                engine = RulesEngine(self.db)
            except Exception:
                engine = None

        if engine is not None:
            verdict = await _maybe_await(
                engine.evaluate,
                "run_command",
                {"command": rendered},
                cwd=cwd,
                provider="antigravity",
            )
            if isinstance(verdict, dict):
                auto_decision = verdict.get("autoDecision")
                risk_tier = int(verdict.get("riskTier", 1) or 0)
                reasons = verdict.get("riskReasons") or []
                if auto_decision == "deny" or risk_tier >= 3:
                    return {
                        "ok": False,
                        "error": f"Blocked by RulesEngine (Tier {risk_tier}): {'; '.join(map(str, reasons)) or 'policy deny'}",
                    }
                if (tool.requiresApproval or risk_tier >= 2) and auto_decision != "allow":
                    return {
                        "ok": False,
                        "requiresApproval": True,
                        "error": f"host_command {tool.name!r} requires explicit rule allow (Tier {risk_tier})",
                    }
        elif tool.requiresApproval:
            return {
                "ok": False,
                "requiresApproval": True,
                "error": f"host_command {tool.name!r} requires RulesEngine verification",
            }

        shell_exe = "pwsh" if _which("pwsh") else "powershell.exe"
        proc = await asyncio.create_subprocess_exec(
            shell_exe,
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            rendered,
            cwd=cwd if cwd and os.path.isdir(cwd) else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return {"ok": False, "error": f"host_command {tool.name!r} timed out after {timeout_sec:.0f}s"}

        stdout_text = stdout_b.decode("utf-8", errors="replace")[:_MAX_CMD_OUTPUT_CHARS]
        stderr_text = stderr_b.decode("utf-8", errors="replace")[:_MAX_CMD_OUTPUT_CHARS]
        ok = proc.returncode == 0
        return {
            "ok": ok,
            "result": {
                "returncode": proc.returncode,
                "stdout": stdout_text,
                "stderr": stderr_text,
            },
            **({"error": stderr_text or f"Exited with code {proc.returncode}"} if not ok else {}),
        }


def _which(exe: str) -> str | None:
    import shutil

    return shutil.which(exe)
