"""OpenAI Codex CLI provider adapter for 0G."""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from typing import Any

from server.adapters.base import (
    AgentProviderAdapter,
    StepCallback,
    TokenCallback,
    maybe_await,
    run_cli_stream_worker,
)
from server.contracts import (
    HookDecisionResponse,
    HookEventPayload,
    ProviderId,
    TimelineStep,
)


def _parse_codex_stream_event(
    evt: dict[str, Any],
) -> tuple[list[tuple[str, str, str | None, dict[str, Any] | None]], dict[str, int] | None]:
    """Parse a `codex exec --json` JSONL event."""
    steps: list[tuple[str, str, str | None, dict[str, Any] | None]] = []
    tokens: dict[str, int] | None = None
    etype = str(evt.get("type") or "")

    item = evt.get("item") if isinstance(evt.get("item"), dict) else None
    if item:
        itype = str(item.get("type") or "")
        text = item.get("text") or item.get("content") or ""
        if itype == "reasoning" and text:
            steps.append(("thought", str(text), None, None))
        elif itype in ("agent_message", "message", "assistant_message") and text:
            steps.append(("assistant", str(text), None, None))
        elif itype in ("command_execution", "mcp_tool_call", "function_call"):
            tname = str(item.get("tool") or item.get("name") or itype)
            targs = item.get("arguments") if isinstance(item.get("arguments"), dict) else None
            if not targs and item.get("command"):
                targs = {"command": item["command"]}
            steps.append(("tool", f"Executed {tname}", tname, targs))
        elif itype == "error" and (item.get("message") or text):
            steps.append(("error", str(item.get("message") or text), None, None))
    elif etype == "turn.failed" or evt.get("error"):
        err = evt.get("error")
        msg = err.get("message") if isinstance(err, dict) else str(err or "Codex turn failed")
        steps.append(("error", str(msg), None, None))

    usage = evt.get("usage")
    if isinstance(usage, dict):
        in_tok = int(usage.get("input_tokens", 0) or 0)
        out_tok = int(usage.get("output_tokens", 0) or 0)
        tokens = {
            "promptTokens": in_tok,
            "thoughtsTokens": int(usage.get("reasoning_tokens", 0) or 0),
            "totalTokens": in_tok + out_tok,
        }
    return steps, tokens


class CodexCliAdapter(AgentProviderAdapter):
    """Adapter for OpenAI Codex CLI (~/.codex/hooks.json and `codex exec --json`)."""

    provider_id: ProviderId = "codex_cli"
    display_name: str = "OpenAI Codex CLI"

    def normalize_hook_input(
        self,
        raw_stdin_dict: dict[str, Any],
        event_name: str | None = None,
    ) -> HookEventPayload:
        """Normalize Codex CLI PreToolUse/PostToolUse/Stop payload into HookEventPayload."""
        raw = raw_stdin_dict if isinstance(raw_stdin_dict, dict) else {}
        hook_event = str(raw.get("hook_event_name") or raw.get("event") or event_name or "PreToolUse")
        cwd = raw.get("cwd")
        tool_name = raw.get("tool_name") or raw.get("tool")
        tool_input = raw.get("tool_input") or raw.get("arguments")
        tool_call: dict[str, Any] | None = None
        if tool_name or isinstance(tool_input, dict):
            tool_call = {
                "name": tool_name or "Bash",
                "args": tool_input if isinstance(tool_input, dict) else {"raw": tool_input},
                "id": raw.get("tool_use_id") or raw.get("call_id"),
            }

        return HookEventPayload(
            provider=self.provider_id,
            hookEventName=hook_event,
            conversationId=str(raw.get("session_id") or raw.get("thread_id") or "default"),
            workspacePaths=[str(cwd)] if cwd else [],
            transcriptPath=raw.get("transcript_path"),
            modelName=raw.get("model"),
            lastUserInput=raw.get("prompt") or raw.get("last_assistant_message"),
            cwd=str(cwd) if cwd else None,
            toolCall=tool_call,
            error=raw.get("error"),
            terminationReason=raw.get("reason"),
            continuationActive=bool(raw.get("stop_hook_active", False)),
            raw=raw,
        )

    def format_hook_output(
        self,
        event_name: str,
        decision: HookDecisionResponse,
    ) -> tuple[int, dict[str, Any]]:
        """Translate HookDecisionResponse into Codex CLI exit code (0/2) + JSON."""
        if decision.decision == "deny":
            reason = decision.reason or "Denied by 0G mobile policy"
            payload: dict[str, Any] = {
                "decision": "block",
                "reason": reason,
                "hookSpecificOutput": {
                    "hookEventName": event_name,
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                },
            }
            return 2, payload

        if decision.decision in ("ask", "force_ask"):
            reason = decision.reason or "Confirmation requested via 0G"
            return 0, {
                "decision": "ask",
                "reason": reason,
                "hookSpecificOutput": {
                    "hookEventName": event_name,
                    "permissionDecision": "ask",
                    "permissionDecisionReason": reason,
                },
            }

        if event_name == "Stop" and decision.injectSteps:
            texts = [str(s.get("content") or s.get("text") or "") for s in decision.injectSteps if isinstance(s, dict)]
            joined = "\n".join(t for t in texts if t)
            if joined:
                return 0, {"decision": "block", "reason": joined}

        out: dict[str, Any] = {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": event_name,
                "permissionDecision": "allow",
            },
        }
        if decision.overwrite is not None:
            out["hookSpecificOutput"]["updatedInput"] = decision.overwrite
        return 0, out

    def generate_hook_snippet(self, shim_cmd: str) -> dict[str, Any]:
        """Generate ~/.codex/hooks.json snippet for PreToolUse, PostToolUse, and Stop."""
        events = ("PreToolUse", "PostToolUse", "Stop")
        hooks_cfg: dict[str, Any] = {}
        for ev in events:
            entry: dict[str, Any] = {
                "hooks": [
                    {
                        "type": "command",
                        "command": f"{shim_cmd} --provider codex_cli --event {ev}",
                        "timeout": 28 if ev == "PreToolUse" else 3,
                    }
                ]
            }
            if ev in ("PreToolUse", "PostToolUse"):
                entry["matcher"] = "Bash"
            hooks_cfg[ev] = [entry]

        return {
            "provider": self.provider_id,
            "displayName": self.display_name,
            "configPath": "~/.codex/hooks.json",
            "config": {"hooks": hooks_cfg},
        }

    async def run_worker(
        self,
        session_id: str,
        cwd: str,
        prompt: str,
        model: str | None,
        on_step: StepCallback,
        on_token: TokenCallback,
        cancel_event: asyncio.Event,
        budget_tokens: int = 120000,
    ) -> dict[str, Any]:
        """Run `codex exec --json` worker if codex CLI is available on PATH."""
        codex_bin = shutil.which("codex")
        if not codex_bin:
            await maybe_await(
                on_step,
                TimelineStep(
                    id=f"{session_id}-cx-1",
                    sessionId=session_id,
                    stepIdx=1,
                    role="error",
                    content="`codex` CLI is not installed on PATH. Install OpenAI Codex CLI or switch provider to Antigravity.",
                    ts=time.time(),
                ),
            )
            return {
                "status": "error",
                "error": "codex CLI not found on PATH",
                "promptTokens": 0,
                "thoughtsTokens": 0,
                "totalTokens": 0,
            }

        cmd = [codex_bin, "exec", "--json"]
        if os.path.isdir(cwd):
            cmd.extend(["-C", cwd])
        if model:
            cmd.extend(["-m", model])
        cmd.append(prompt)

        return await run_cli_stream_worker(
            session_id=session_id,
            prefix="cx",
            cmd=cmd,
            cwd=cwd,
            on_step=on_step,
            on_token=on_token,
            cancel_event=cancel_event,
            parse_event=_parse_codex_stream_event,
        )
