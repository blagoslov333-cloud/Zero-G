"""xAI Grok Build provider adapter for 0G."""

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
from server.adapters.claude_code import ClaudeCodeAdapter, _parse_claude_stream_event
from server.contracts import (
    HookDecisionResponse,
    HookEventPayload,
    ProviderId,
    TimelineStep,
)


def _parse_grok_stream_event(
    evt: dict[str, Any],
) -> tuple[list[tuple[str, str, str | None, dict[str, Any] | None]], dict[str, int] | None]:
    """Parse Grok Build streaming JSON events (Claude-compatible + plain text fallback)."""
    if evt.get("type") in ("assistant", "result"):
        return _parse_claude_stream_event(evt)

    steps: list[tuple[str, str, str | None, dict[str, Any] | None]] = []
    tokens: dict[str, int] | None = None
    if evt.get("thought") or evt.get("reasoning"):
        steps.append(("thought", str(evt.get("thought") or evt.get("reasoning")), None, None))
    if evt.get("content") or evt.get("text") or evt.get("message"):
        steps.append(("assistant", str(evt.get("content") or evt.get("text") or evt.get("message")), None, None))
    if evt.get("error"):
        steps.append(("error", str(evt["error"]), None, None))

    usage = evt.get("usage")
    if isinstance(usage, dict):
        in_tok = int(usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0)
        out_tok = int(usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0)
        tokens = {
            "promptTokens": in_tok,
            "thoughtsTokens": int(usage.get("reasoning_tokens", 0) or 0),
            "totalTokens": int(usage.get("total_tokens", in_tok + out_tok) or 0),
        }
    return steps, tokens


class GrokBuildAdapter(AgentProviderAdapter):
    """Adapter for xAI Grok Build (`grok`) Claude-compatible hooks + MCP server."""

    provider_id: ProviderId = "grok_build"
    display_name: str = "xAI Grok Build"

    def __init__(self) -> None:
        self._claude_compat = ClaudeCodeAdapter()

    def normalize_hook_input(
        self,
        raw_stdin_dict: dict[str, Any],
        event_name: str | None = None,
    ) -> HookEventPayload:
        """Translate Grok Build Claude-compatible hook payload into HookEventPayload."""
        payload = self._claude_compat.normalize_hook_input(raw_stdin_dict, event_name=event_name)
        payload.provider = self.provider_id
        return payload

    def format_hook_output(
        self,
        event_name: str,
        decision: HookDecisionResponse,
    ) -> tuple[int, dict[str, Any]]:
        """Format HookDecisionResponse in Grok Build's Claude-compatible hook schema."""
        return self._claude_compat.format_hook_output(event_name, decision)

    def generate_hook_snippet(self, shim_cmd: str) -> dict[str, Any]:
        """Generate ~/.grok/hooks.json snippet including 0G Phone MCP registration."""
        events = ("SessionStart", "PreToolUse", "PostToolUse", "Stop")
        hooks_cfg: dict[str, Any] = {}
        for ev in events:
            entry: dict[str, Any] = {
                "hooks": [
                    {
                        "type": "command",
                        "command": f"{shim_cmd} --provider grok_build --event {ev}",
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
            "configPath": "~/.grok/hooks.json",
            "config": {
                "hooks": hooks_cfg,
                "mcpServers": {
                    "0g-phone": {
                        "command": "python",
                        "args": ["-m", "server.mcp_server"],
                    }
                },
            },
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
        """Run `grok` CLI in non-interactive headless mode if installed on PATH."""
        grok_bin = shutil.which("grok")
        if not grok_bin:
            await maybe_await(
                on_step,
                TimelineStep(
                    id=f"{session_id}-gk-1",
                    sessionId=session_id,
                    stepIdx=1,
                    role="error",
                    content="`grok` CLI is not installed on PATH. Install xAI Grok Build or switch provider to Antigravity.",
                    ts=time.time(),
                ),
            )
            return {
                "status": "error",
                "error": "grok CLI not found on PATH",
                "promptTokens": 0,
                "thoughtsTokens": 0,
                "totalTokens": 0,
            }

        cmd = [grok_bin, "-p", prompt]
        if model:
            cmd.extend(["--model", model])

        return await run_cli_stream_worker(
            session_id=session_id,
            prefix="gk",
            cmd=cmd,
            cwd=cwd,
            on_step=on_step,
            on_token=on_token,
            cancel_event=cancel_event,
            parse_event=_parse_grok_stream_event,
        )
