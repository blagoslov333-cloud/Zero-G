"""Claude Code provider adapter for 0G."""

from __future__ import annotations

import asyncio
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


def _parse_claude_stream_event(
    evt: dict[str, Any],
) -> tuple[list[tuple[str, str, str | None, dict[str, Any] | None]], dict[str, int] | None]:
    """Parse a Claude Code `--output-format stream-json` NDJSON event."""
    steps: list[tuple[str, str, str | None, dict[str, Any] | None]] = []
    tokens: dict[str, int] | None = None
    etype = evt.get("type")

    if etype == "assistant":
        msg = evt.get("message") if isinstance(evt.get("message"), dict) else evt
        content_blocks = msg.get("content")
        if isinstance(content_blocks, list):
            for block in content_blocks:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "thinking" and block.get("thinking"):
                    steps.append(("thought", str(block["thinking"]), None, None))
                elif btype == "text" and block.get("text"):
                    steps.append(("assistant", str(block["text"]), None, None))
                elif btype == "tool_use":
                    tname = str(block.get("name") or "tool")
                    targs = block.get("input") if isinstance(block.get("input"), dict) else None
                    steps.append(("tool", f"Calling {tname}", tname, targs))
        elif isinstance(msg.get("text"), str):
            steps.append(("assistant", msg["text"], None, None))
        usage = msg.get("usage")
        if isinstance(usage, dict):
            in_tok = int(usage.get("input_tokens", 0) or 0)
            out_tok = int(usage.get("output_tokens", 0) or 0)
            tokens = {
                "promptTokens": in_tok,
                "thoughtsTokens": 0,
                "totalTokens": in_tok + out_tok,
            }
    elif etype == "result":
        if evt.get("result") and not evt.get("is_error"):
            steps.append(("assistant", str(evt["result"]), None, None))
        elif evt.get("is_error"):
            steps.append(("error", str(evt.get("result") or evt.get("error") or "Claude error"), None, None))
        usage = evt.get("usage")
        if isinstance(usage, dict):
            in_tok = int(usage.get("input_tokens", 0) or 0)
            out_tok = int(usage.get("output_tokens", 0) or 0)
            tokens = {
                "promptTokens": in_tok,
                "thoughtsTokens": 0,
                "totalTokens": in_tok + out_tok,
            }
    elif evt.get("error"):
        steps.append(("error", str(evt["error"]), None, None))

    return steps, tokens


class ClaudeCodeAdapter(AgentProviderAdapter):
    """Adapter for Anthropic Claude Code CLI and ~/.claude/settings.json hooks."""

    provider_id: ProviderId = "claude_code"
    display_name: str = "Claude Code"

    def normalize_hook_input(
        self,
        raw_stdin_dict: dict[str, Any],
        event_name: str | None = None,
    ) -> HookEventPayload:
        """Translate Claude Code stdin hook JSON into HookEventPayload."""
        raw = raw_stdin_dict if isinstance(raw_stdin_dict, dict) else {}
        hook_event = str(raw.get("hook_event_name") or event_name or "PreToolUse")
        cwd = raw.get("cwd")
        tool_name = raw.get("tool_name")
        tool_input = raw.get("tool_input")
        tool_call: dict[str, Any] | None = None
        if tool_name or isinstance(tool_input, dict):
            tool_call = {
                "name": tool_name or "unknown",
                "args": tool_input if isinstance(tool_input, dict) else {},
                "id": raw.get("tool_use_id"),
            }

        return HookEventPayload(
            provider=self.provider_id,
            hookEventName=hook_event,
            conversationId=str(raw.get("session_id") or "default"),
            workspacePaths=[str(cwd)] if cwd else [],
            transcriptPath=raw.get("transcript_path"),
            modelName=raw.get("model"),
            lastUserInput=raw.get("prompt") or raw.get("user_prompt"),
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
        """Format HookDecisionResponse into Claude Code hookSpecificOutput JSON + exit code."""
        hard_deny = decision.decision == "deny" and decision.terminationBehavior == "terminate"
        exit_code = 2 if hard_deny else 0

        if event_name == "PreToolUse":
            if decision.decision in ("allow", "ok", "continue"):
                perm = "allow"
            elif decision.decision == "deny":
                perm = "deny"
            else:
                perm = "ask"

            specific: dict[str, Any] = {
                "hookEventName": "PreToolUse",
                "permissionDecision": perm,
            }
            if decision.reason:
                specific["permissionDecisionReason"] = decision.reason
            if decision.overwrite is not None:
                specific["updatedInput"] = decision.overwrite
            return exit_code, {"hookSpecificOutput": specific}

        if decision.decision == "deny":
            out: dict[str, Any] = {"decision": "block"}
            if decision.reason:
                out["reason"] = decision.reason
            return exit_code, out

        if decision.injectSteps:
            texts = [str(s.get("content") or s.get("text") or "") for s in decision.injectSteps if isinstance(s, dict)]
            joined = "\n".join(t for t in texts if t)
            if joined:
                return 0, {"decision": "block", "reason": joined}

        return 0, {}

    def generate_hook_snippet(self, shim_cmd: str) -> dict[str, Any]:
        """Generate ~/.claude/settings.json hook snippet."""
        events = ("SessionStart", "PreToolUse", "PostToolUse", "Stop")
        hooks_cfg: dict[str, Any] = {}
        for ev in events:
            entry: dict[str, Any] = {
                "hooks": [
                    {
                        "type": "command",
                        "command": f"{shim_cmd} --provider claude_code --event {ev}",
                        "timeout": 28 if ev == "PreToolUse" else 3,
                    }
                ]
            }
            if ev in ("PreToolUse", "PostToolUse"):
                entry["matcher"] = "*"
            hooks_cfg[ev] = [entry]

        return {
            "provider": self.provider_id,
            "displayName": self.display_name,
            "configPath": "~/.claude/settings.json",
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
        """Run Claude Code CLI in headless stream-json mode if installed."""
        claude_bin = shutil.which("claude")
        if not claude_bin:
            await maybe_await(
                on_step,
                TimelineStep(
                    id=f"{session_id}-cc-1",
                    sessionId=session_id,
                    stepIdx=1,
                    role="error",
                    content="`claude` CLI is not installed on PATH. Install Claude Code or switch provider to Antigravity.",
                    ts=time.time(),
                ),
            )
            return {
                "status": "error",
                "error": "claude CLI not found on PATH",
                "promptTokens": 0,
                "thoughtsTokens": 0,
                "totalTokens": 0,
            }

        cmd = [claude_bin, "-p", prompt, "--output-format", "stream-json", "--verbose"]
        if model:
            cmd.extend(["--model", model])

        return await run_cli_stream_worker(
            session_id=session_id,
            prefix="cc",
            cmd=cmd,
            cwd=cwd,
            on_step=on_step,
            on_token=on_token,
            cancel_event=cancel_event,
            parse_event=_parse_claude_stream_event,
        )
