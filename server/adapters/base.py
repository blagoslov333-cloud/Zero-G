"""Base provider adapter contract and shared helpers for 0G."""

from __future__ import annotations

import asyncio
import inspect
import os
import re
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Awaitable, Callable

from server.contracts import (
    AutomationItem,
    HookDecisionResponse,
    HookEventPayload,
    ProjectSummary,
    ProviderId,
    TimelineStep,
)

StepCallback = Callable[[TimelineStep], Awaitable[None] | None]
TokenCallback = Callable[[dict[str, int]], Awaitable[None] | None]

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(value: str) -> str:
    """Convert an arbitrary label into a stable URL/ID-safe slug."""
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug or "project"


def probe_git_branch(project_dir: Path) -> str | None:
    """Read the active branch from .git/HEAD without invoking git or touching locks."""
    head_file = project_dir / ".git" / "HEAD"
    if not head_file.is_file():
        return None
    try:
        raw = head_file.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if raw.startswith("ref:"):
        ref = raw.split(":", 1)[1].strip()
        if ref.startswith("refs/heads/"):
            return ref[len("refs/heads/") :]
        return ref
    return raw[:12] if raw else None


async def maybe_await(callback: Callable[..., Any] | None, *args: Any) -> None:
    """Invoke either a synchronous or asynchronous callback safely."""
    if callback is None:
        return
    result = callback(*args)
    if inspect.isawaitable(result):
        await result


def default_project_roots() -> list[Path]:
    """Return configured workspace scan roots, defaulting to ~/.gemini/antigravity/scratch."""
    env_roots = os.environ.get("ZEROG_PROJECT_ROOTS", "").strip()
    if env_roots:
        roots = [Path(p).expanduser() for p in env_roots.split(os.pathsep) if p.strip()]
        if roots:
            return roots
    return [Path.home() / ".gemini" / "antigravity" / "scratch"]


async def terminate_process(proc: asyncio.subprocess.Process) -> None:
    """Terminate an asyncio subprocess cleanly and quickly."""
    if proc.returncode is not None:
        return
    try:
        proc.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=2.0)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass


async def run_cli_stream_worker(
    *,
    session_id: str,
    prefix: str,
    cmd: list[str],
    cwd: str,
    on_step: StepCallback,
    on_token: TokenCallback,
    cancel_event: asyncio.Event,
    parse_event: Callable[[dict[str, Any]], tuple[list[tuple[str, str, str | None, dict[str, Any] | None]], dict[str, int] | None]],
) -> dict[str, Any]:
    """Spawn a streaming JSONL CLI worker with instant cancel_event termination."""
    import json
    import time

    step_counter = 0
    latest_tokens = {"promptTokens": 0, "thoughtsTokens": 0, "totalTokens": 0}

    async def emit(
        role: str,
        content: str,
        tool_name: str | None = None,
        tool_args: dict[str, Any] | None = None,
    ) -> None:
        nonlocal step_counter
        step_counter += 1
        await maybe_await(
            on_step,
            TimelineStep(
                id=f"{session_id}-{prefix}-{step_counter}",
                sessionId=session_id,
                stepIdx=step_counter,
                role=role,  # type: ignore[arg-type]
                content=content,
                toolName=tool_name,
                toolArgs=tool_args,
                ts=time.time(),
            ),
        )

    if cancel_event.is_set():
        await emit("system", f"{prefix} worker cancelled before start.")
        return {"status": "cancelled", **latest_tokens}

    await emit("system", f"Starting {cmd[0]} worker in {cwd}")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd if os.path.isdir(cwd) else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def _pump_stdout() -> None:
        nonlocal latest_tokens
        assert proc.stdout is not None
        while not cancel_event.is_set():
            raw_line = await proc.stdout.readline()
            if not raw_line:
                break
            text = raw_line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            if text.startswith("{"):
                try:
                    evt = json.loads(text)
                except json.JSONDecodeError:
                    await emit("assistant", text)
                    continue
                if isinstance(evt, dict):
                    parsed_steps, token_delta = parse_event(evt)
                    for role, content, tool_name, tool_args in parsed_steps:
                        if content or tool_name:
                            await emit(role, content, tool_name, tool_args)
                    if token_delta:
                        latest_tokens = {
                            "promptTokens": int(token_delta.get("promptTokens", latest_tokens["promptTokens"]) or 0),
                            "thoughtsTokens": int(token_delta.get("thoughtsTokens", latest_tokens["thoughtsTokens"]) or 0),
                            "totalTokens": int(token_delta.get("totalTokens", latest_tokens["totalTokens"]) or 0),
                        }
                        await maybe_await(on_token, latest_tokens)
                    continue
            await emit("assistant", text)

    reader = asyncio.create_task(_pump_stdout())
    canceller = asyncio.create_task(cancel_event.wait())
    done, pending = await asyncio.wait({reader, canceller}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()

    if cancel_event.is_set():
        await terminate_process(proc)
        await emit("system", f"{cmd[0]} worker cancelled.")
        return {"status": "cancelled", **latest_tokens}

    rc = await proc.wait()
    if rc != 0:
        err_bytes = await proc.stderr.read() if proc.stderr else b""
        err_msg = err_bytes.decode("utf-8", errors="replace").strip() or f"{cmd[0]} exited with code {rc}"
        await emit("error", err_msg)
        return {"status": "error", "error": err_msg, **latest_tokens}

    return {"status": "completed", **latest_tokens}


class AgentProviderAdapter(ABC):
    """Abstract interface implemented by every agent provider supported by 0G."""

    provider_id: ProviderId
    display_name: str

    def discover_projects(self, roots: list[str] | None = None) -> list[ProjectSummary]:
        """Discover local workspace projects associated with this provider."""
        scan_roots = [Path(r).expanduser() for r in roots] if roots else default_project_roots()
        projects: list[ProjectSummary] = []
        seen_paths: set[str] = set()
        for root in scan_roots:
            if not root.is_dir():
                continue
            try:
                entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
            except OSError:
                continue
            for entry in entries:
                if not entry.is_dir() or entry.name.startswith(".") or entry.name == "__pycache__":
                    continue
                resolved = str(entry.resolve())
                if resolved in seen_paths:
                    continue
                seen_paths.add(resolved)
                projects.append(
                    ProjectSummary(
                        id=slugify(entry.name),
                        name=entry.name,
                        path=resolved,
                        icon="folder",
                        accentToken="--accent-primary",
                        providerHint=self.provider_id,
                        gitBranch=probe_git_branch(entry),
                        isSeededDemo=False,
                    )
                )
        return projects

    def discover_automations(self) -> list[AutomationItem]:
        """Discover scheduled automations native to this provider."""
        return []

    @abstractmethod
    def normalize_hook_input(
        self,
        raw_stdin_dict: dict[str, Any],
        event_name: str | None = None,
    ) -> HookEventPayload:
        """Normalize a provider-specific hook stdin JSON payload into HookEventPayload."""

    @abstractmethod
    def format_hook_output(
        self,
        event_name: str,
        decision: HookDecisionResponse,
    ) -> tuple[int, dict[str, Any]]:
        """Translate HookDecisionResponse into (exit_code, stdout_json_dict) for the provider."""

    @abstractmethod
    def generate_hook_snippet(self, shim_cmd: str) -> dict[str, Any]:
        """Return install path and JSON config snippet wiring this provider to 0G."""

    @abstractmethod
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
        """Execute a background Mode-B worker task with streaming callbacks and cancellation."""
