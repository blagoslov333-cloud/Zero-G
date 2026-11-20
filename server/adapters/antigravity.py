"""Antigravity (Priority #1) provider adapter for 0G."""

from __future__ import annotations

import asyncio
import datetime as dt
import inspect
import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

from server.adapters.base import (
    AgentProviderAdapter,
    StepCallback,
    TokenCallback,
    default_project_roots,
    maybe_await,
    probe_git_branch,
    slugify,
    terminate_process,
)
from server.contracts import (
    AutomationItem,
    HookDecisionResponse,
    HookEventPayload,
    ProjectSummary,
    ProviderId,
    TimelineStep,
)

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
_MARKDOWN_EXTS = {".md", ".markdown", ".mdx"}
_MAX_ARTIFACTS = 200


def _parse_iso_ts(raw_ts: Any) -> float:
    """Parse an ISO-8601 timestamp string into epoch seconds."""
    if isinstance(raw_ts, (int, float)):
        return float(raw_ts)
    if not isinstance(raw_ts, str) or not raw_ts.strip():
        return time.time()
    text = raw_ts.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return time.time()


def _load_full_transcript_rows(full_path: Path, needed_steps: set[int]) -> dict[int, dict[str, Any]]:
    """Read only the requested step_index records from transcript_full.jsonl."""
    resolved: dict[int, dict[str, Any]] = {}
    if not needed_steps or not full_path.is_file():
        return resolved
    try:
        with full_path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                step_idx = obj.get("step_index")
                if isinstance(step_idx, int) and step_idx in needed_steps:
                    resolved[step_idx] = obj
                    if len(resolved) == len(needed_steps):
                        break
    except OSError:
        return resolved
    return resolved


def _format_tool_call_summary(tool_calls: list[dict[str, Any]]) -> str:
    """Create a concise readable summary from transcript tool_calls."""
    names = [str(tc.get("name") or tc.get("toolName") or "tool") for tc in tool_calls if isinstance(tc, dict)]
    if not names:
        return "Tool call"
    return f"Called {', '.join(names)}"


class AntigravityAdapter(AgentProviderAdapter):
    """Adapter for Google Antigravity IDE, hooks.json, Jetski sidecars, and SDK."""

    provider_id: ProviderId = "antigravity"
    display_name: str = "Antigravity"

    def discover_projects(self, roots: list[str] | None = None) -> list[ProjectSummary]:
        """Scan Antigravity scratch roots and ensure the Video production project exists."""
        scan_roots = [Path(r).expanduser() for r in roots] if roots else default_project_roots()
        projects = super().discover_projects(roots=[str(r) for r in scan_roots])

        has_video_proj = any(
            p.id == "video-production" or p.name.lower() == "video production"
            for p in projects
        )
        if has_video_proj:
            for proj in projects:
                if proj.name.lower() == "video production":
                    proj.icon = "clapperboard"
                    proj.accentToken = "--accent-secondary"
            return projects

        video_candidates = [Path.home() / "Videos" / "Video production"]
        for root in scan_roots:
            video_candidates.append(root / "Video production")
            video_candidates.append(root / "video-production")

        existing_video_dir = next((cand for cand in video_candidates if cand.is_dir()), None)
        if existing_video_dir is not None:
            projects.append(
                ProjectSummary(
                    id="video-production",
                    name="Video production",
                    path=str(existing_video_dir.resolve()),
                    icon="clapperboard",
                    accentToken="--accent-secondary",
                    providerHint=self.provider_id,
                    gitBranch=probe_git_branch(existing_video_dir),
                    isSeededDemo=False,
                )
            )
        else:
            seeded_path = Path.home() / "Videos" / "Video production"
            projects.append(
                ProjectSummary(
                    id="video-production",
                    name="Video production",
                    path=str(seeded_path),
                    icon="clapperboard",
                    accentToken="--accent-secondary",
                    providerHint=self.provider_id,
                    gitBranch=None,
                    isSeededDemo=True,
                )
            )
        return projects

    def tail_transcript(
        self,
        transcript_path: str | Path,
        after_step: int = -1,
    ) -> list[TimelineStep]:
        """Parse transcript.jsonl after ``after_step``, resolving truncated_fields via transcript_full.jsonl."""
        path = Path(transcript_path).expanduser()
        if not path.is_file():
            return []

        entries: list[dict[str, Any]] = []
        needed_full_steps: set[int] = set()
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    step_idx = obj.get("step_index")
                    if not isinstance(step_idx, int) or step_idx <= after_step:
                        continue
                    entries.append(obj)
                    if obj.get("truncated_fields"):
                        needed_full_steps.add(step_idx)
        except OSError:
            return []

        if needed_full_steps:
            full_rows = _load_full_transcript_rows(
                path.with_name("transcript_full.jsonl"),
                needed_full_steps,
            )
            for obj in entries:
                step_idx = obj.get("step_index")
                full_obj = full_rows.get(step_idx)
                if not full_obj:
                    continue
                for field_name in obj.get("truncated_fields") or []:
                    if field_name in full_obj:
                        obj[field_name] = full_obj[field_name]

        session_id = path.parent.parent.parent.name if path.parent.name == "logs" else "antigravity"
        steps: list[TimelineStep] = []
        for obj in entries:
            step_idx = int(obj["step_index"])
            ts = _parse_iso_ts(obj.get("created_at"))
            source = str(obj.get("source") or "")
            step_type = str(obj.get("type") or "")
            status = str(obj.get("status") or "")
            content = str(obj.get("content") or "")
            thinking = obj.get("thinking")
            tool_calls = obj.get("tool_calls") if isinstance(obj.get("tool_calls"), list) else []

            if isinstance(thinking, str) and thinking.strip():
                steps.append(
                    TimelineStep(
                        id=f"{session_id}-step-{step_idx}-thought",
                        sessionId=session_id,
                        stepIdx=step_idx,
                        role="thought",
                        content=thinking,
                        ts=ts,
                    )
                )

            role: str = "assistant"
            tool_name: str | None = None
            tool_args: dict[str, Any] | None = None

            if status == "ERROR":
                role = "error"
            elif step_type == "USER_INPUT" or source == "USER_EXPLICIT":
                role = "user"
            elif step_type == "SYSTEM_MESSAGE" or source == "SYSTEM":
                role = "system"
            elif tool_calls:
                first_tc = tool_calls[0] if isinstance(tool_calls[0], dict) else {}
                tool_name = first_tc.get("name") or first_tc.get("toolName")
                raw_args = first_tc.get("args") or first_tc.get("arguments")
                if isinstance(raw_args, dict):
                    tool_args = raw_args
                if not content.strip():
                    role = "tool"
                    content = _format_tool_call_summary(tool_calls)
                else:
                    role = "assistant"

            if content or tool_name:
                steps.append(
                    TimelineStep(
                        id=f"{session_id}-step-{step_idx}",
                        sessionId=session_id,
                        stepIdx=step_idx,
                        role=role,  # type: ignore[arg-type]
                        content=content,
                        toolName=tool_name,
                        toolArgs=tool_args,
                        ts=ts,
                    )
                )

        return steps

    def list_artifacts(self, artifact_dir: str | Path | None) -> list[dict[str, Any]]:
        """Safely index markdown, image, and file artifacts inside artifactDirectoryPath."""
        if not artifact_dir:
            return []
        try:
            root = Path(artifact_dir).expanduser().resolve()
        except OSError:
            return []
        if not root.is_dir():
            return []

        items: list[dict[str, Any]] = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(
                d for d in dirnames
                if not d.startswith(".") and d not in {"scratch", "__pycache__", "node_modules"}
            )
            for fname in sorted(filenames):
                if fname.startswith("."):
                    continue
                fpath = Path(dirpath) / fname
                try:
                    resolved = fpath.resolve()
                    rel = resolved.relative_to(root)
                    stat = resolved.stat()
                except (OSError, ValueError):
                    continue
                if not resolved.is_file():
                    continue
                ext = resolved.suffix.lower()
                if ext in _MARKDOWN_EXTS:
                    kind = "markdown"
                elif ext in _IMAGE_EXTS:
                    kind = "image"
                else:
                    kind = "file"
                items.append(
                    {
                        "name": resolved.name,
                        "relativePath": rel.as_posix(),
                        "path": str(resolved),
                        "kind": kind,
                        "sizeBytes": stat.st_size,
                        "modifiedAt": stat.st_mtime,
                    }
                )
                if len(items) >= _MAX_ARTIFACTS:
                    return items
        return items

    def discover_automations(self) -> list[AutomationItem]:
        """Read scheduled sidecars from ~/.gemini/jetski/sidecars/*/sidecar.json."""
        sidecars_root = Path.home() / ".gemini" / "jetski" / "sidecars"
        if not sidecars_root.is_dir():
            return []

        items: list[AutomationItem] = []
        try:
            subdirs = sorted(sidecars_root.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return []

        for subdir in subdirs:
            if not subdir.is_dir():
                continue
            sidecar_file = subdir / "sidecar.json"
            if not sidecar_file.is_file():
                continue
            try:
                data = json.loads(sidecar_file.read_text(encoding="utf-8", errors="replace"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(data, dict) or data.get("builtin") != "schedule":
                continue

            slug = str(data.get("slug") or subdir.name)
            name = str(data.get("name") or data.get("title") or slug)
            schedule = str(
                data.get("schedule")
                or data.get("cron")
                or data.get("cronExpression")
                or data.get("interval")
                or ""
            )
            prompt = str(data.get("prompt") or data.get("instruction") or data.get("task") or "")
            last_run = data.get("lastRunAt")
            items.append(
                AutomationItem(
                    slug=slug,
                    name=name,
                    schedule=schedule,
                    prompt=prompt,
                    source="jetski_sidecar",
                    enabled=bool(data.get("enabled", True)),
                    lastRunAt=float(last_run) if isinstance(last_run, (int, float)) else None,
                )
            )
        return items

    def normalize_hook_input(
        self,
        raw_stdin_dict: dict[str, Any],
        event_name: str | None = None,
    ) -> HookEventPayload:
        """Normalize native Antigravity camelCase hook payload into HookEventPayload."""
        raw = raw_stdin_dict if isinstance(raw_stdin_dict, dict) else {}
        ws_paths = raw.get("workspacePaths")
        if not isinstance(ws_paths, list):
            ws_paths = []
        ws_paths_str = [str(p) for p in ws_paths if p]

        cwd = raw.get("cwd") or (ws_paths_str[0] if ws_paths_str else None)
        tool_call = raw.get("toolCall") if isinstance(raw.get("toolCall"), dict) else None
        step_idx = raw.get("stepIdx")
        if step_idx is None:
            step_idx = raw.get("stepIndex")

        return HookEventPayload(
            provider=self.provider_id,
            hookEventName=str(raw.get("hookEventName") or event_name or raw.get("event") or "PreToolUse"),
            conversationId=str(raw.get("conversationId") or "default"),
            workspacePaths=ws_paths_str,
            transcriptPath=raw.get("transcriptPath"),
            artifactDirectoryPath=raw.get("artifactDirectoryPath"),
            modelName=raw.get("modelName"),
            lastUserInput=raw.get("lastUserInput"),
            cwd=str(cwd) if cwd else None,
            stepIdx=int(step_idx) if isinstance(step_idx, int) else None,
            toolCall=tool_call,
            error=raw.get("error"),
            terminationReason=raw.get("terminationReason"),
            continuationActive=bool(raw.get("continuationActive", False)),
            raw=raw,
        )

    def format_hook_output(
        self,
        event_name: str,
        decision: HookDecisionResponse,
    ) -> tuple[int, dict[str, Any]]:
        """Format HookDecisionResponse into Antigravity hooks.json stdout JSON + exit code 0."""
        out: dict[str, Any] = {"decision": decision.decision}
        if decision.reason:
            out["reason"] = decision.reason
        if decision.overwrite is not None:
            out["overwrite"] = decision.overwrite
        if decision.permissionOverrides:
            out["permissionOverrides"] = decision.permissionOverrides
        if decision.injectSteps:
            out["injectSteps"] = decision.injectSteps
        if decision.terminationBehavior:
            out["terminationBehavior"] = decision.terminationBehavior
        return 0, out

    def generate_hook_snippet(self, shim_cmd: str) -> dict[str, Any]:
        """Generate Antigravity ~/.gemini/antigravity/hooks.json configuration snippet."""
        events = (
            "SessionStart",
            "PreInvocation",
            "PreToolUse",
            "PostToolUse",
            "PostInvocation",
            "Stop",
        )
        hooks_map = {
            ev: [
                {
                    "command": f"{shim_cmd} --provider antigravity --event {ev}",
                    "timeoutMs": 28000 if ev == "PreToolUse" else 2500,
                }
            ]
            for ev in events
        }
        return {
            "provider": self.provider_id,
            "displayName": self.display_name,
            "configPath": "~/.gemini/antigravity/hooks.json",
            "config": {"hooks": hooks_map},
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
        """Run a Mode-B Antigravity worker via google.antigravity SDK, agy CLI, or deterministic fallback."""
        step_counter = 0

        async def emit_step(
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
                    id=f"{session_id}-w-{step_counter}",
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
            await emit_step("system", "Worker cancelled before start.")
            return {"status": "cancelled", "promptTokens": 0, "thoughtsTokens": 0, "totalTokens": 0}

        sdk_result = await self._try_run_sdk(
            session_id=session_id,
            cwd=cwd,
            prompt=prompt,
            model=model,
            emit_step=emit_step,
            on_token=on_token,
            cancel_event=cancel_event,
            budget_tokens=budget_tokens,
        )
        if sdk_result is not None:
            return sdk_result

        agy_bin = shutil.which("agy")
        if agy_bin:
            return await self._run_agy_cli(
                agy_bin=agy_bin,
                cwd=cwd,
                prompt=prompt,
                model=model,
                emit_step=emit_step,
                on_token=on_token,
                cancel_event=cancel_event,
            )

        return await self._run_deterministic_fallback(
            cwd=cwd,
            prompt=prompt,
            model=model,
            emit_step=emit_step,
            on_token=on_token,
            cancel_event=cancel_event,
            budget_tokens=budget_tokens,
        )

    async def _try_run_sdk(
        self,
        session_id: str,
        cwd: str,
        prompt: str,
        model: str | None,
        emit_step: Any,
        on_token: TokenCallback,
        cancel_event: asyncio.Event,
        budget_tokens: int,
    ) -> dict[str, Any] | None:
        """Attempt execution using the google.antigravity Python SDK if installed."""
        try:
            from google.antigravity import (  # type: ignore[import-not-found]
                Agent,
                BudgetConfig,
                CapabilitiesConfig,
                LocalAgentConfig,
            )
        except ImportError:
            return None

        await emit_step("system", f"Starting Antigravity SDK worker in {cwd}")
        try:
            budget_cfg = BudgetConfig(max_tokens=budget_tokens)
            caps_cfg = CapabilitiesConfig()
            local_kwargs: dict[str, Any] = {"working_directory": cwd}
            sig = inspect.signature(LocalAgentConfig)
            if "cwd" in sig.parameters and "working_directory" not in sig.parameters:
                local_kwargs = {"cwd": cwd}
            if "model" in sig.parameters and model:
                local_kwargs["model"] = model
            local_cfg = LocalAgentConfig(**local_kwargs)

            agent_kwargs: dict[str, Any] = {"config": local_cfg}
            agent_sig = inspect.signature(Agent)
            if "capabilities" in agent_sig.parameters:
                agent_kwargs["capabilities"] = caps_cfg
            if "budget" in agent_sig.parameters:
                agent_kwargs["budget"] = budget_cfg
            if "model" in agent_sig.parameters and model:
                agent_kwargs["model"] = model

            agent = Agent(**agent_kwargs)
        except Exception as exc:
            await emit_step("error", f"Antigravity SDK initialization failed: {exc}")
            return {"status": "error", "error": str(exc), "promptTokens": 0, "thoughtsTokens": 0, "totalTokens": 0}

        prompt_tokens = 0
        thoughts_tokens = 0
        total_tokens = 0

        async def _consume() -> str:
            nonlocal prompt_tokens, thoughts_tokens, total_tokens
            if hasattr(agent, "run_stream"):
                stream = agent.run_stream(prompt)
            elif hasattr(agent, "stream"):
                stream = agent.stream(prompt)
            elif hasattr(agent, "run"):
                res = agent.run(prompt)
                if inspect.isawaitable(res):
                    res = await res
                text = getattr(res, "text", None) or getattr(res, "output", None) or str(res)
                await emit_step("assistant", str(text))
                return "completed"
            else:
                raise RuntimeError("Installed google.antigravity.Agent exposes no run/stream method")

            async for chunk in stream:
                if cancel_event.is_set():
                    return "cancelled"
                thought_text = getattr(chunk, "thought", None) or getattr(chunk, "thinking", None)
                if thought_text:
                    await emit_step("thought", str(thought_text))
                text = getattr(chunk, "text", None) or getattr(chunk, "content", None)
                if text:
                    await emit_step("assistant", str(text))
                usage = getattr(chunk, "usage_metadata", None) or getattr(chunk, "usage", None)
                if usage is not None:
                    prompt_tokens = int(getattr(usage, "prompt_token_count", getattr(usage, "prompt_tokens", prompt_tokens)) or 0)
                    thoughts_tokens = int(getattr(usage, "thoughts_token_count", getattr(usage, "thoughts_tokens", thoughts_tokens)) or 0)
                    total_tokens = int(getattr(usage, "total_token_count", getattr(usage, "total_tokens", prompt_tokens + thoughts_tokens)) or 0)
                    await maybe_await(
                        on_token,
                        {
                            "promptTokens": prompt_tokens,
                            "thoughtsTokens": thoughts_tokens,
                            "totalTokens": total_tokens,
                        },
                    )
            return "completed"

        task = asyncio.create_task(_consume())
        cancel_wait = asyncio.create_task(cancel_event.wait())
        done, pending = await asyncio.wait({task, cancel_wait}, return_when=asyncio.FIRST_COMPLETED)
        for p in pending:
            p.cancel()

        if cancel_event.is_set() and task not in done:
            await emit_step("system", "Antigravity SDK worker cancelled.")
            return {
                "status": "cancelled",
                "promptTokens": prompt_tokens,
                "thoughtsTokens": thoughts_tokens,
                "totalTokens": total_tokens,
            }

        try:
            final_status = task.result()
        except Exception as exc:
            await emit_step("error", f"Antigravity SDK runtime error: {exc}")
            return {
                "status": "error",
                "error": str(exc),
                "promptTokens": prompt_tokens,
                "thoughtsTokens": thoughts_tokens,
                "totalTokens": total_tokens,
            }

        return {
            "status": final_status,
            "promptTokens": prompt_tokens,
            "thoughtsTokens": thoughts_tokens,
            "totalTokens": total_tokens,
        }

    async def _run_agy_cli(
        self,
        agy_bin: str,
        cwd: str,
        prompt: str,
        model: str | None,
        emit_step: Any,
        on_token: TokenCallback,
        cancel_event: asyncio.Event,
    ) -> dict[str, Any]:
        """Run Antigravity CLI (agy) subprocess with instant cancel_event termination."""
        cmd = [agy_bin, "run", "--prompt", prompt]
        if model:
            cmd.extend(["--model", model])

        await emit_step("system", f"Launching agy CLI worker in {cwd}")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd if os.path.isdir(cwd) else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        async def _read_stdout() -> None:
            assert proc.stdout is not None
            while not cancel_event.is_set():
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip()
                if not text:
                    continue
                if text.startswith("{"):
                    try:
                        evt = json.loads(text)
                        if isinstance(evt, dict):
                            if evt.get("thought"):
                                await emit_step("thought", str(evt["thought"]))
                            if evt.get("content") or evt.get("text"):
                                await emit_step("assistant", str(evt.get("content") or evt.get("text")))
                            usage = evt.get("usageMetadata") or evt.get("usage")
                            if isinstance(usage, dict):
                                await maybe_await(
                                    on_token,
                                    {
                                        "promptTokens": int(usage.get("promptTokenCount", 0) or 0),
                                        "thoughtsTokens": int(usage.get("thoughtsTokenCount", 0) or 0),
                                        "totalTokens": int(usage.get("totalTokenCount", 0) or 0),
                                    },
                                )
                            continue
                    except json.JSONDecodeError:
                        pass
                await emit_step("assistant", text)

        reader = asyncio.create_task(_read_stdout())
        canceller = asyncio.create_task(cancel_event.wait())
        done, pending = await asyncio.wait({reader, canceller}, return_when=asyncio.FIRST_COMPLETED)
        for p in pending:
            p.cancel()

        if cancel_event.is_set():
            await terminate_process(proc)
            await emit_step("system", "agy CLI worker cancelled immediately.")
            return {"status": "cancelled", "promptTokens": 0, "thoughtsTokens": 0, "totalTokens": 0}

        rc = await proc.wait()
        if rc != 0:
            err_bytes = await proc.stderr.read() if proc.stderr else b""
            err_msg = err_bytes.decode("utf-8", errors="replace").strip() or f"agy exited with code {rc}"
            await emit_step("error", err_msg)
            return {"status": "error", "error": err_msg, "promptTokens": 0, "thoughtsTokens": 0, "totalTokens": 0}
        return {"status": "completed", "promptTokens": 0, "thoughtsTokens": 0, "totalTokens": 0}

    async def _run_deterministic_fallback(
        self,
        cwd: str,
        prompt: str,
        model: str | None,
        emit_step: Any,
        on_token: TokenCallback,
        cancel_event: asyncio.Event,
        budget_tokens: int,
    ) -> dict[str, Any]:
        """Shell-free deterministic async fallback when neither SDK nor agy CLI is installed."""
        await emit_step(
            "system",
            f"Antigravity SDK / agy CLI not installed on PATH; running shell-free 0G fallback worker (cwd={cwd}, budget={budget_tokens}).",
        )
        if cancel_event.is_set():
            return {"status": "cancelled", "promptTokens": 0, "thoughtsTokens": 0, "totalTokens": 0}

        prompt_tokens = max(16, len(prompt.split()) * 2)
        thoughts_tokens = 24
        await emit_step(
            "thought",
            f"Planning fallback response for prompt ({len(prompt)} chars) with model={model or 'default'} without executing shell commands.",
        )
        await maybe_await(
            on_token,
            {
                "promptTokens": prompt_tokens,
                "thoughtsTokens": thoughts_tokens,
                "totalTokens": prompt_tokens + thoughts_tokens,
            },
        )

        try:
            await asyncio.wait_for(cancel_event.wait(), timeout=0.05)
            await emit_step("system", "Fallback worker cancelled.")
            return {
                "status": "cancelled",
                "promptTokens": prompt_tokens,
                "thoughtsTokens": thoughts_tokens,
                "totalTokens": prompt_tokens + thoughts_tokens,
            }
        except asyncio.TimeoutError:
            pass

        output_tokens = 32
        total_tokens = prompt_tokens + thoughts_tokens + output_tokens
        await emit_step(
            "assistant",
            f"[0G Antigravity Fallback] Received task for workspace `{cwd}`:\n{prompt}\n\nInstall `google-antigravity` SDK or place `agy` on PATH for live autonomous execution.",
        )
        await maybe_await(
            on_token,
            {
                "promptTokens": prompt_tokens,
                "thoughtsTokens": thoughts_tokens,
                "totalTokens": total_tokens,
            },
        )
        return {
            "status": "completed",
            "fallback": True,
            "promptTokens": prompt_tokens,
            "thoughtsTokens": thoughts_tokens,
            "totalTokens": total_tokens,
        }
