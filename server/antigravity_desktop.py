"""Read/control bridge for the local Antigravity Desktop IDE installation."""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from server.adapters.base import probe_git_branch, slugify
from server.contracts import SessionSummary
from server.git_ops import GitManager, _resolve_inside_repo, _win32_full_path
from server.security import EgressRedactor

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000

_CONV_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
_MARKDOWN_EXTS = {".md", ".markdown", ".mdx"}
_HTML_EXTS = {".html", ".htm"}

_MAX_IMAGE_ARTIFACT_BYTES = 2 * 1024 * 1024
_MAX_TEXT_FILE_BYTES = 256 * 1024
_MAX_TEXT_FILE_LINES = 2000
_MAX_ARTIFACTS = 200

_SKIP_WORKSPACE_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist"}
_SKIP_ARTIFACT_DIRS = {".system_generated", ".user_uploaded", "__pycache__", "node_modules"}

_SECRET_FILENAMES = {
    ".env",
    "bridge.token",
    "vapid_keys.json",
    "id_rsa",
    "id_ed25519",
}
_SECRET_EXTS = {".pem", ".key", ".pfx"}

_STRIP_BLOCK_TAGS_RE = re.compile(
    r"<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY)>[\s\S]*?</(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY)>",
    re.IGNORECASE,
)
_USER_REQUEST_TAG_RE = re.compile(r"</?USER_REQUEST>", re.IGNORECASE)
_TALKER_BLOCK_RE = re.compile(
    r"<talker_agent_context>([\s\S]*?)</talker_agent_context>",
    re.IGNORECASE,
)
_TALKER_USER_LINE_RE = re.compile(r'\[[^\]]+\]\s*user:\s*"((?:[^"\\]|\\.)*)"')
_GENERIC_TIMESTAMP_PREFIX_RE = re.compile(
    r"^(?:Created At:[^\n]*\n|Completed At:[^\n]*\n)+",
    re.IGNORECASE,
)

OFFICIAL_SLASH_COMMANDS: list[dict[str, str]] = [
    {"command": "/plan", "description": "Create a structured step-by-step execution plan before making changes."},
    {"command": "/grill-me", "description": "Run an interactive design interview to resolve ambiguities and trade-offs."},
    {"command": "/boost", "description": "Accelerate task execution with higher reasoning and thorough verification."},
    {"command": "/teamwork", "description": "Coordinate multiple specialized swarm agents in parallel."},
    {"command": "/goal", "description": "Run an autonomous long-horizon loop until the stated goal is verified."},
    {"command": "/browser", "description": "Inspect, interact with, and verify live web UIs in a browser."},
    {"command": "/compact", "description": "Summarize and compact conversation context to free up window space."},
    {"command": "/schedule", "description": "Configure a one-shot timer or recurring scheduled automation."},
    {"command": "/learn", "description": "Persist a workflow correction or setup pattern for future tasks."},
]


def _parse_ts(raw_ts: Any) -> float:
    """Parse an ISO-8601 datetime string or numeric timestamp into epoch seconds."""
    if isinstance(raw_ts, (int, float)):
        return float(raw_ts)
    if not isinstance(raw_ts, str) or not raw_ts.strip():
        return 0.0
    text = raw_ts.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return 0.0


def _decode_file_uri(uri: str) -> str:
    """Decode a file:/// URI (including Windows percent-encoded drive letters) into a local path."""
    raw = str(uri or "").strip()
    if not raw:
        return ""
    if not raw.lower().startswith("file://"):
        return os.path.normpath(raw)
    parsed = urlparse(raw)
    decoded = urllib.parse.unquote(parsed.path or "")
    if parsed.netloc and parsed.netloc.lower() not in ("", "localhost"):
        decoded = f"//{parsed.netloc}{decoded}"
    if IS_WINDOWS and len(decoded) >= 3 and decoded[0] == "/" and decoded[2] == ":":
        decoded = decoded[1:]
    return os.path.normpath(decoded)


def _is_secret_relpath(rel_path: str) -> bool:
    """Return True if any segment or filename in rel_path refers to a secret file."""
    norm = rel_path.replace("\\", "/")
    parts = [p for p in norm.split("/") if p and p != "."]
    for part in parts:
        low = part.lower()
        if low in _SECRET_FILENAMES or low.startswith(".env."):
            return True
        if any(low.endswith(ext) for ext in _SECRET_EXTS):
            return True
        if "credentials" in low:
            return True
    return False


def _clean_user_content(raw_text: str) -> str:
    """Strip internal Antigravity prompt wrappers and extract clean user text."""
    text = _STRIP_BLOCK_TAGS_RE.sub("", raw_text or "")
    text = _USER_REQUEST_TAG_RE.sub("", text)

    if "<talker_agent_context>" in text.lower():
        def _replace_talker(match: re.Match[str]) -> str:
            inner = match.group(1)
            extracted: list[str] = []
            for m in _TALKER_USER_LINE_RE.finditer(inner):
                line_val = m.group(1).replace('\\"', '"').replace("\\n", "\n").strip()
                if line_val:
                    extracted.append(line_val)
            return "\n".join(extracted)

        text = _TALKER_BLOCK_RE.sub(_replace_talker, text)

    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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


def _parse_frontmatter(md_text: str) -> tuple[str | None, str | None]:
    """Extract name and description from YAML frontmatter in SKILL.md."""
    lines = md_text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, None
    name: str | None = None
    desc: str | None = None
    for line in lines[1:40]:
        stripped = line.strip()
        if stripped == "---":
            break
        if stripped.lower().startswith("name:"):
            name = stripped.split(":", 1)[1].strip().strip("'\"")
        elif stripped.lower().startswith("description:"):
            desc = stripped.split(":", 1)[1].strip().strip("'\"")
    return name, desc


def _artifact_kind(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _MARKDOWN_EXTS:
        return "markdown"
    if ext in _HTML_EXTS:
        return "html"
    if ext in _IMAGE_EXTS:
        return "image"
    return "file"


def _summarize_tool_call(name: str, raw_args: Any) -> tuple[str, str | None]:
    """Build a concise tool call summary and args preview."""
    if isinstance(raw_args, dict):
        summary_hint = (
            raw_args.get("toolSummary")
            or raw_args.get("Description")
            or raw_args.get("Path")
            or raw_args.get("file_path")
            or raw_args.get("CommandLine")
            or raw_args.get("command")
            or raw_args.get("query")
        )
        try:
            args_str = json.dumps(raw_args, ensure_ascii=False)
        except Exception:
            args_str = str(raw_args)
        summary = f"{name}: {summary_hint}" if summary_hint else name
        return summary[:140], (args_str[:240] if args_str else None)
    if raw_args is not None:
        args_str = str(raw_args)
        return name, (args_str[:240] if args_str else None)
    return name, None


class AntigravityDesktopBridge:
    """Read-only inspector + agentapi dispatcher for local Antigravity Desktop state."""

    def __init__(self, redactor: EgressRedactor | None = None) -> None:
        self.redactor = redactor or EgressRedactor()
        self.git_manager = GitManager(timeout_sec=3.0)

    @property
    def agy_dir(self) -> Path:
        raw = os.environ.get("ZEROG_AGY_DIR", "").strip()
        return Path(raw).expanduser() if raw else (Path.home() / ".gemini" / "antigravity")

    @property
    def cfg_dir(self) -> Path:
        raw = os.environ.get("ZEROG_AGY_CONFIG_DIR", "").strip()
        return Path(raw).expanduser() if raw else (Path.home() / ".gemini" / "config")

    @property
    def extra_project_roots(self) -> list[Path]:
        raw = os.environ.get("ZEROG_PROJECT_ROOTS", "").strip()
        if raw:
            roots = [Path(p).expanduser() for p in raw.split(os.pathsep) if p.strip()]
            if roots:
                return roots
        return [Path.home() / "F", self.agy_dir / "scratch"]

    @staticmethod
    def validate_conversation_id(conversation_id: str) -> str:
        cid = (conversation_id or "").strip()
        if not _CONV_ID_RE.match(cid):
            raise ValueError(f"Invalid conversation_id: {conversation_id!r}")
        return cid

    def _connect_ro(self) -> sqlite3.Connection | None:
        db_path = self.agy_dir / "conversation_summaries.db"
        if not db_path.is_file():
            return None
        return sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)

    def _has_swarm(self, conversation_id: str) -> bool:
        swarm_dir = self.agy_dir / "brain" / conversation_id / ".system_generated" / "swarm"
        return (swarm_dir / "plan.json").is_file() or (swarm_dir / "swarm.json").is_file()

    def _read_all_conversations_from_db(self) -> list[dict[str, Any]] | None:
        conn = self._connect_ro()
        if conn is None:
            return None
        try:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
                ).fetchall()
            }
            if "conversation_summaries" not in tables:
                return None

            has_fts = "conversations_fts" in tables
            has_parents = "conversation_parents" in tables

            select_title = (
                "COALESCE(NULLIF(cs.title, ''), fts.title, 'Untitled Conversation')"
                if has_fts
                else "COALESCE(NULLIF(cs.title, ''), 'Untitled Conversation')"
            )
            select_fts_proj = "fts.project" if has_fts else "''"
            select_cp_parent = "cp.parent_id" if has_parents else "''"
            joins = []
            if has_fts:
                joins.append(
                    "LEFT JOIN conversations_fts fts ON fts.conversation_id = cs.conversation_id AND fts.chunk_index = -1"
                )
            if has_parents:
                joins.append(
                    "LEFT JOIN conversation_parents cp ON cp.conversation_id = cs.conversation_id"
                )

            sql = f"""
                SELECT
                    cs.conversation_id,
                    {select_title} AS resolved_title,
                    cs.step_count,
                    cs.last_modified_time,
                    cs.workspace_uris,
                    cs.status,
                    cs.agent_name,
                    cs.parent_conversation_id,
                    cs.not_fully_idle,
                    cs.killed,
                    {select_fts_proj} AS fts_project,
                    {select_cp_parent} AS cp_parent_id
                FROM conversation_summaries cs
                {' '.join(joins)}
            """
            rows = conn.execute(sql).fetchall()
        except sqlite3.Error:
            return None
        finally:
            conn.close()

        raw_items: list[dict[str, Any]] = []
        subagent_counts: dict[str, int] = {}

        for row in rows:
            (
                cid,
                resolved_title,
                step_count,
                last_modified_time,
                workspace_uris_raw,
                raw_status,
                agent_name,
                parent_conv_id,
                not_fully_idle,
                killed,
                fts_project,
                cp_parent_id,
            ) = row

            cid_str = str(cid or "").strip()
            if not cid_str:
                continue

            parent_id = str(parent_conv_id or cp_parent_id or "").strip() or None
            if parent_id:
                subagent_counts[parent_id] = subagent_counts.get(parent_id, 0) + 1

            ws_paths: list[str] = []
            try:
                uris = json.loads(workspace_uris_raw) if workspace_uris_raw else []
                if isinstance(uris, list):
                    for u in uris:
                        decoded = _decode_file_uri(str(u))
                        if decoded and decoded not in ws_paths:
                            ws_paths.append(decoded)
            except Exception:
                pass

            status_upper = str(raw_status or "").upper()
            if bool(killed) or "KILLED" in status_upper:
                norm_status = "killed"
            elif "RUNNING" in status_upper or bool(not_fully_idle):
                norm_status = "running"
            else:
                norm_status = "idle"

            proj_name: str | None = None
            if ws_paths:
                proj_name = Path(ws_paths[0]).name or None
            elif fts_project:
                proj_name = str(fts_project).strip() or None

            clean_title, _ = self.redactor.redact(str(resolved_title or "Untitled Conversation"))
            raw_items.append(
                {
                    "id": cid_str,
                    "title": clean_title or "Untitled Conversation",
                    "status": norm_status,
                    "stepCount": int(step_count or 0),
                    "lastModifiedAt": _parse_ts(last_modified_time),
                    "workspacePaths": ws_paths,
                    "projectName": proj_name,
                    "parentConversationId": parent_id,
                    "agentName": str(agent_name or "").strip() or None,
                    "subagentCount": 0,
                    "hasSwarm": self._has_swarm(cid_str),
                }
            )

        for item in raw_items:
            item["subagentCount"] = subagent_counts.get(item["id"], 0)
        return raw_items

    def _scan_conversations_from_brain(self) -> list[dict[str, Any]]:
        brain_dir = self.agy_dir / "brain"
        if not brain_dir.is_dir():
            return []
        items: list[dict[str, Any]] = []
        try:
            subdirs = list(brain_dir.iterdir())
        except OSError:
            return []

        for d in subdirs:
            if not d.is_dir() or d.name.startswith(".") or not _CONV_ID_RE.match(d.name):
                continue
            transcript_path = d / ".system_generated" / "logs" / "transcript.jsonl"
            step_count = 0
            title = "Untitled Conversation"
            try:
                mtime = d.stat().st_mtime
            except OSError:
                mtime = 0.0

            if transcript_path.is_file():
                try:
                    mtime = max(mtime, transcript_path.stat().st_mtime)
                    with transcript_path.open("r", encoding="utf-8", errors="replace") as fh:
                        for line in fh:
                            if not line.strip():
                                continue
                            step_count += 1
                            if title == "Untitled Conversation":
                                try:
                                    obj = json.loads(line)
                                except json.JSONDecodeError:
                                    continue
                                if obj.get("type") == "USER_INPUT" or obj.get("source") == "USER_EXPLICIT":
                                    cleaned = _clean_user_content(str(obj.get("content") or ""))
                                    if cleaned:
                                        first_line = cleaned.splitlines()[0].strip()
                                        title = first_line[:80] or title
                except OSError:
                    pass

            clean_title, _ = self.redactor.redact(title)
            items.append(
                {
                    "id": d.name,
                    "title": clean_title,
                    "status": "idle",
                    "stepCount": step_count,
                    "lastModifiedAt": mtime,
                    "workspacePaths": [],
                    "projectName": None,
                    "parentConversationId": None,
                    "agentName": None,
                    "subagentCount": 0,
                    "hasSwarm": self._has_swarm(d.name),
                }
            )
        return items

    def _all_conversations(self) -> list[dict[str, Any]]:
        items = self._read_all_conversations_from_db()
        if items is None:
            items = self._scan_conversations_from_brain()
        items.sort(key=lambda c: float(c.get("lastModifiedAt") or 0.0), reverse=True)
        return items

    @staticmethod
    def _path_matches_project(workspace_path: str, project_path: str) -> bool:
        try:
            ws_norm = os.path.normcase(os.path.abspath(workspace_path))
            proj_norm = os.path.normcase(os.path.abspath(project_path))
            if ws_norm == proj_norm:
                return True
            return os.path.commonpath([ws_norm, proj_norm]) == proj_norm
        except Exception:
            return False

    def discover_real_projects(self) -> list[dict[str, Any]]:
        """Discover real existing workspace directories from DB workspace_uris + extra_project_roots."""
        conversations = self._all_conversations()
        top_convs = [c for c in conversations if not c.get("parentConversationId")]

        candidates_by_key: dict[str, Path] = {}

        def _add_candidate(path_obj: Path) -> None:
            try:
                if not path_obj.is_dir():
                    return
                resolved = Path(_win32_full_path(str(path_obj)))
                if not resolved.is_dir():
                    return
                key = os.path.normcase(str(resolved))
                if key not in candidates_by_key:
                    candidates_by_key[key] = resolved
            except OSError:
                return

        for conv in conversations:
            for wp in conv.get("workspacePaths") or []:
                _add_candidate(Path(wp))

        for root in self.extra_project_roots:
            if not root.is_dir():
                continue
            try:
                entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
            except OSError:
                continue
            for entry in entries:
                if entry.name.startswith(".") or entry.name == "__pycache__":
                    continue
                if entry.is_dir():
                    _add_candidate(entry)

        projects: list[dict[str, Any]] = []
        used_ids: set[str] = set()
        for norm_key, proj_path in candidates_by_key.items():
            base_id = slugify(proj_path.name)
            proj_id = base_id
            if proj_id in used_ids:
                suffix = uuid.uuid5(uuid.NAMESPACE_URL, norm_key).hex[:6]
                proj_id = f"{base_id}-{suffix}"
            used_ids.add(proj_id)

            git_branch: str | None = None
            dirty_count = 0
            if (proj_path / ".git").exists():
                git_branch = probe_git_branch(proj_path) or self.git_manager.get_branch(str(proj_path))
                rc, out, _ = self.git_manager._run_git(
                    str(proj_path),
                    ["status", "--porcelain=v1"],
                    read_only=True,
                )
                if rc == 0 and out:
                    dirty_count = sum(1 for ln in out.splitlines() if ln.strip())

            matching_convs = [
                c
                for c in top_convs
                if any(self._path_matches_project(wp, str(proj_path)) for wp in (c.get("workspacePaths") or []))
            ]
            conv_count = len(matching_convs)
            if matching_convs:
                last_mod = max(float(c.get("lastModifiedAt") or 0.0) for c in matching_convs)
            else:
                try:
                    last_mod = float(proj_path.stat().st_mtime)
                except OSError:
                    last_mod = 0.0

            projects.append(
                {
                    "id": proj_id,
                    "name": proj_path.name,
                    "path": str(proj_path),
                    "gitBranch": git_branch,
                    "dirtyCount": dirty_count,
                    "conversationCount": conv_count,
                    "lastModifiedAt": last_mod,
                }
            )

        projects.sort(key=lambda p: float(p["lastModifiedAt"]), reverse=True)
        return projects

    def list_conversations(
        self,
        project_path: str | None = None,
        include_subagents: bool = False,
        limit: int = 60,
    ) -> list[dict[str, Any]]:
        items = self._all_conversations()
        if not include_subagents:
            items = [c for c in items if not c.get("parentConversationId")]
        if project_path and project_path.strip():
            target = project_path.strip()
            items = [
                c
                for c in items
                if any(self._path_matches_project(wp, target) for wp in (c.get("workspacePaths") or []))
            ]
        capped = max(1, min(int(limit), 500))
        return items[:capped]

    def _collect_brain_artifacts(self, conv_dir: Path) -> list[dict[str, Any]]:
        if not conv_dir.is_dir():
            return []
        artifacts: list[dict[str, Any]] = []
        for dirpath, dirnames, filenames in os.walk(conv_dir):
            dirnames[:] = sorted(
                d
                for d in dirnames
                if not d.startswith(".") and d not in _SKIP_ARTIFACT_DIRS
            )
            for fname in sorted(filenames):
                if fname.startswith("."):
                    continue
                fpath = Path(dirpath) / fname
                try:
                    resolved = fpath.resolve()
                    rel = resolved.relative_to(conv_dir.resolve())
                    stat = resolved.stat()
                except (OSError, ValueError):
                    continue
                if not resolved.is_file():
                    continue
                artifacts.append(
                    {
                        "name": resolved.name,
                        "relativePath": rel.as_posix(),
                        "kind": _artifact_kind(resolved),
                        "sizeBytes": int(stat.st_size),
                        "modifiedAt": float(stat.st_mtime),
                    }
                )
                if len(artifacts) >= _MAX_ARTIFACTS:
                    return artifacts
        return artifacts

    def get_conversation_detail(self, conversation_id: str, limit: int = 150) -> dict[str, Any]:
        cid = self.validate_conversation_id(conversation_id)
        all_convs = self._all_conversations()
        summary = next((c for c in all_convs if c["id"] == cid), None)
        conv_dir = self.agy_dir / "brain" / cid
        if summary is None and not conv_dir.is_dir():
            raise FileNotFoundError(f"Conversation '{cid}' not found")

        if summary is None:
            summary = {
                "id": cid,
                "title": "Untitled Conversation",
                "status": "idle",
                "stepCount": 0,
                "lastModifiedAt": float(conv_dir.stat().st_mtime),
                "workspacePaths": [],
                "projectName": None,
                "parentConversationId": None,
                "agentName": None,
                "subagentCount": 0,
                "hasSwarm": self._has_swarm(cid),
            }

        subagents = [c for c in all_convs if c.get("parentConversationId") == cid]
        artifacts = self._collect_brain_artifacts(conv_dir)

        swarm_plan: dict[str, Any] | None = None
        plan_path = conv_dir / ".system_generated" / "swarm" / "plan.json"
        if plan_path.is_file():
            try:
                loaded_plan = json.loads(plan_path.read_text(encoding="utf-8", errors="replace"))
                if isinstance(loaded_plan, dict):
                    swarm_plan = self.redactor.redact_dict(loaded_plan)
            except (OSError, json.JSONDecodeError):
                swarm_plan = None

        transcript_path = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
        messages: list[dict[str, Any]] = []
        if transcript_path.is_file():
            messages = self._parse_transcript_messages(cid, transcript_path, limit=limit)

        return {
            "conversation": summary,
            "messages": messages,
            "artifacts": artifacts,
            "subagents": subagents,
            "swarmPlan": swarm_plan,
        }

    def _parse_transcript_messages(
        self,
        cid: str,
        transcript_path: Path,
        limit: int = 150,
    ) -> list[dict[str, Any]]:
        raw_entries: list[dict[str, Any]] = []
        try:
            with transcript_path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    step_type = str(obj.get("type") or "")
                    source = str(obj.get("source") or "")
                    if step_type in ("EPHEMERAL_MESSAGE", "SYSTEM_MESSAGE", "CHECKPOINT"):
                        continue
                    if source == "SYSTEM_SDK":
                        continue
                    raw_entries.append(obj)
        except OSError:
            return []

        # Identify which raw entries become messages vs GENERIC tool outputs attached to previous assistant message.
        groups: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for obj in raw_entries:
            step_type = str(obj.get("type") or "")
            if step_type == "GENERIC":
                if groups and str(groups[-1][0].get("type") or "") != "USER_INPUT" and str(groups[-1][0].get("source") or "") != "USER_EXPLICIT":
                    groups[-1][1].append(obj)
                continue
            groups.append((obj, []))

        capped = max(1, min(int(limit), 1000))
        selected_groups = groups[-capped:]

        needed_full_steps: set[int] = set()
        for main_obj, generic_objs in selected_groups:
            for item in (main_obj, *generic_objs):
                step_idx = item.get("step_index")
                if isinstance(step_idx, int) and item.get("truncated_fields"):
                    needed_full_steps.add(step_idx)

        if needed_full_steps:
            full_rows = _load_full_transcript_rows(
                transcript_path.with_name("transcript_full.jsonl"),
                needed_full_steps,
            )
            for main_obj, generic_objs in selected_groups:
                for item in (main_obj, *generic_objs):
                    step_idx = item.get("step_index")
                    full_obj = full_rows.get(step_idx) if isinstance(step_idx, int) else None
                    if not full_obj:
                        continue
                    for field_name in item.get("truncated_fields") or []:
                        if field_name in full_obj:
                            item[field_name] = full_obj[field_name]

        messages: list[dict[str, Any]] = []
        for idx, (obj, generic_objs) in enumerate(selected_groups):
            step_idx = obj.get("step_index")
            step_index_int = int(step_idx) if isinstance(step_idx, int) else idx
            step_type = str(obj.get("type") or "")
            source = str(obj.get("source") or "")
            created_at = _parse_ts(obj.get("created_at"))

            if step_type == "USER_INPUT" or source == "USER_EXPLICIT":
                cleaned_user = _clean_user_content(str(obj.get("content") or ""))
                red_user, _ = self.redactor.redact(cleaned_user)
                if not red_user:
                    continue
                messages.append(
                    {
                        "id": f"{cid}-step-{step_index_int}",
                        "stepIndex": step_index_int,
                        "role": "user",
                        "content": red_user,
                        "thinking": None,
                        "model": None,
                        "toolCalls": [],
                        "createdAt": created_at,
                    }
                )
                continue

            if step_type == "ERROR_MESSAGE":
                err_txt = str(obj.get("error") or obj.get("content") or "").strip()
                if not err_txt:
                    continue
                red_err, _ = self.redactor.redact(f"[Error] {err_txt}")
                messages.append(
                    {
                        "id": f"{cid}-step-{step_index_int}",
                        "stepIndex": step_index_int,
                        "role": "assistant",
                        "content": red_err,
                        "thinking": None,
                        "model": obj.get("model"),
                        "toolCalls": [],
                        "createdAt": created_at,
                    }
                )
                continue

            raw_content = str(obj.get("content") or "")
            red_content, _ = self.redactor.redact(raw_content.strip())
            raw_thinking = obj.get("thinking")
            red_thinking: str | None = None
            if isinstance(raw_thinking, str) and raw_thinking.strip():
                red_thinking, _ = self.redactor.redact(raw_thinking.strip())

            raw_tool_calls = obj.get("tool_calls") if isinstance(obj.get("tool_calls"), list) else []
            tool_calls: list[dict[str, Any]] = []
            for tc in raw_tool_calls:
                if not isinstance(tc, dict):
                    continue
                tc_name = str(tc.get("name") or tc.get("toolName") or "tool")
                tc_args = tc.get("args") if "args" in tc else tc.get("arguments")
                summary_str, args_preview = _summarize_tool_call(tc_name, tc_args)
                red_summary, _ = self.redactor.redact(summary_str)
                red_args_preview = (
                    self.redactor.redact(args_preview)[0] if args_preview else None
                )
                tool_calls.append(
                    {
                        "name": tc_name,
                        "summary": red_summary,
                        "argsPreview": red_args_preview,
                        "outputPreview": None,
                    }
                )

            # Attach GENERIC outputs as short previews on toolCalls
            if generic_objs and tool_calls:
                for g_idx, g_obj in enumerate(generic_objs):
                    g_text = str(g_obj.get("content") or "").strip()
                    g_text = _GENERIC_TIMESTAMP_PREFIX_RE.sub("", g_text).strip()
                    if not g_text:
                        continue
                    red_g, _ = self.redactor.redact(g_text)
                    preview = red_g[:240]
                    target_tc = tool_calls[min(g_idx, len(tool_calls) - 1)]
                    if target_tc["outputPreview"] is None:
                        target_tc["outputPreview"] = preview
                    elif len(target_tc["outputPreview"]) < 240:
                        combined = f"{target_tc['outputPreview']}\n{preview}"
                        target_tc["outputPreview"] = combined[:240]

            if not red_content and not red_thinking and not tool_calls:
                continue

            messages.append(
                {
                    "id": f"{cid}-step-{step_index_int}",
                    "stepIndex": step_index_int,
                    "role": "assistant",
                    "content": red_content,
                    "thinking": red_thinking,
                    "model": str(obj["model"]) if obj.get("model") else None,
                    "toolCalls": tool_calls,
                    "createdAt": created_at,
                }
            )

        return messages

    def read_artifact(self, conversation_id: str, rel_path: str) -> tuple[int, dict[str, Any]]:
        """Read a conversation artifact safely; returns (http_status, payload)."""
        cid = self.validate_conversation_id(conversation_id)
        conv_dir = self.agy_dir / "brain" / cid
        if not conv_dir.is_dir():
            return 404, {"detail": f"Conversation '{cid}' not found"}

        cleaned_rel = (rel_path or "").strip()
        if not cleaned_rel:
            return 400, {"detail": "path query parameter is required"}

        ok, rel, err_msg = _resolve_inside_repo(str(conv_dir), cleaned_rel, allow_dot_git=False)
        if not ok:
            return 403, {"detail": err_msg or "Forbidden artifact path"}
        if _is_secret_relpath(rel):
            return 403, {"detail": "Access to secret files is forbidden"}

        target = Path(_win32_full_path(str(conv_dir))) / rel
        if not target.is_file():
            return 404, {"detail": f"Artifact '{rel}' not found"}

        kind = _artifact_kind(target)
        if kind == "image":
            size = target.stat().st_size
            if size > _MAX_IMAGE_ARTIFACT_BYTES:
                return 413, {"detail": f"Image artifact exceeds 2MB limit ({size} bytes)"}
            raw_bytes = target.read_bytes()
            mime, _ = mimetypes.guess_type(target.name)
            if not mime:
                mime = "image/svg+xml" if target.suffix.lower() == ".svg" else "application/octet-stream"
            b64 = base64.b64encode(raw_bytes).decode("ascii")
            return 200, {
                "ok": True,
                "name": target.name,
                "relativePath": rel,
                "kind": kind,
                "content": None,
                "dataUri": f"data:{mime};base64,{b64}",
            }

        raw_text = target.read_text(encoding="utf-8", errors="replace")
        redacted_text, _ = self.redactor.redact(raw_text)
        return 200, {
            "ok": True,
            "name": target.name,
            "relativePath": rel,
            "kind": kind,
            "content": redacted_text,
            "dataUri": None,
        }

    def _resolve_allowed_project(self, project_path: str) -> tuple[int, Path | None, str]:
        raw = (project_path or "").strip()
        if not raw:
            return 400, None, "projectPath is required"
        if not os.path.isdir(raw):
            return 404, None, f"Project directory not found: {raw}"

        target_norm = os.path.normcase(_win32_full_path(raw))
        allowed = {
            os.path.normcase(_win32_full_path(p["path"])): Path(p["path"])
            for p in self.discover_real_projects()
        }
        if target_norm not in allowed:
            return 403, None, "projectPath is not an allowed Antigravity project directory"
        return 200, allowed[target_norm], ""

    def list_workspace_files(self, project_path: str, rel_dir: str = "") -> tuple[int, dict[str, Any]]:
        status, proj_dir, err = self._resolve_allowed_project(project_path)
        if proj_dir is None:
            return status, {"detail": err}

        proj_abs = _win32_full_path(str(proj_dir))
        cleaned_dir = (rel_dir or "").strip()
        if not cleaned_dir or cleaned_dir == ".":
            target_dir = Path(proj_abs)
            norm_rel_dir = ""
        else:
            ok, rel, r_err = _resolve_inside_repo(proj_abs, cleaned_dir, allow_dot_git=False)
            if not ok:
                return 403, {"detail": r_err or "Path traversal is forbidden"}
            if _is_secret_relpath(rel):
                return 403, {"detail": "Access to secret paths is forbidden"}
            target_dir = Path(proj_abs) / rel
            norm_rel_dir = rel

        if not target_dir.is_dir():
            return 404, {"detail": f"Directory '{norm_rel_dir or '.'}' not found"}

        entries: list[dict[str, Any]] = []
        try:
            children = list(target_dir.iterdir())
        except OSError as exc:
            return 500, {"detail": str(exc)}

        for child in children:
            if child.name in _SKIP_WORKSPACE_DIRS:
                continue
            try:
                is_dir = child.is_dir()
                stat = child.stat()
            except OSError:
                continue
            rel_entry = f"{norm_rel_dir}/{child.name}" if norm_rel_dir else child.name
            entries.append(
                {
                    "name": child.name,
                    "relPath": rel_entry,
                    "isDir": is_dir,
                    "sizeBytes": 0 if is_dir else int(stat.st_size),
                    "modifiedAt": float(stat.st_mtime),
                }
            )

        entries.sort(key=lambda e: (not e["isDir"], e["name"].lower()))
        return 200, {
            "ok": True,
            "projectPath": str(proj_dir),
            "dir": norm_rel_dir,
            "entries": entries,
        }

    def read_workspace_file(self, project_path: str, rel_file: str) -> tuple[int, dict[str, Any]]:
        status, proj_dir, err = self._resolve_allowed_project(project_path)
        if proj_dir is None:
            return status, {"detail": err}

        cleaned_file = (rel_file or "").strip()
        if not cleaned_file:
            return 400, {"detail": "path query parameter is required"}

        proj_abs = _win32_full_path(str(proj_dir))
        ok, rel, r_err = _resolve_inside_repo(proj_abs, cleaned_file, allow_dot_git=False)
        if not ok:
            return 403, {"detail": r_err or "Path traversal is forbidden"}
        if _is_secret_relpath(rel):
            return 403, {"detail": f"Reading protected secret file '{rel}' is forbidden"}

        target = Path(proj_abs) / rel
        if not target.is_file():
            return 404, {"detail": f"File '{rel}' not found"}

        truncated = False
        try:
            size = target.stat().st_size
            with target.open("rb") as fh:
                raw_bytes = fh.read(_MAX_TEXT_FILE_BYTES + 1)
            if len(raw_bytes) > _MAX_TEXT_FILE_BYTES or size > _MAX_TEXT_FILE_BYTES:
                raw_bytes = raw_bytes[:_MAX_TEXT_FILE_BYTES]
                truncated = True
            text = raw_bytes.decode("utf-8", errors="replace")
        except OSError as exc:
            return 500, {"detail": str(exc)}

        lines = text.splitlines()
        if len(lines) > _MAX_TEXT_FILE_LINES:
            lines = lines[:_MAX_TEXT_FILE_LINES]
            text = "\n".join(lines)
            truncated = True

        redacted_text, _ = self.redactor.redact(text)
        line_count = len(redacted_text.splitlines()) if redacted_text else 0
        return 200, {
            "ok": True,
            "projectPath": str(proj_dir),
            "path": rel,
            "name": target.name,
            "content": redacted_text,
            "lineCount": line_count,
            "truncated": truncated,
        }

    def list_customizations(self) -> dict[str, Any]:
        plugins: list[dict[str, str]] = []
        plugins_dir = self.cfg_dir / "plugins"
        if plugins_dir.is_dir():
            for p_dir in sorted(plugins_dir.iterdir(), key=lambda p: p.name.lower()):
                if not p_dir.is_dir() or p_dir.name.startswith(".") or ".staging." in p_dir.name:
                    continue
                manifest = p_dir / "plugin.json"
                if not manifest.is_file():
                    manifest = p_dir / ".claude-plugin" / "plugin.json"
                name = p_dir.name
                desc = ""
                if manifest.is_file():
                    try:
                        data = json.loads(manifest.read_text(encoding="utf-8", errors="replace"))
                        if isinstance(data, dict):
                            name = str(data.get("displayName") or data.get("name") or name)
                            desc = str(data.get("description") or "")
                    except (OSError, json.JSONDecodeError):
                        pass
                plugins.append({"name": name, "description": desc})

        skills: list[dict[str, str]] = []
        seen_skills: set[tuple[str, str]] = set()
        for root, source in (
            (self.cfg_dir / "skills", "config"),
            (self.agy_dir / "builtin" / "skills", "builtin"),
        ):
            if not root.is_dir():
                continue
            for s_dir in sorted(root.iterdir(), key=lambda p: p.name.lower()):
                if not s_dir.is_dir() or s_dir.name.startswith("."):
                    continue
                skill_md = s_dir / "SKILL.md"
                if not skill_md.is_file():
                    continue
                name = s_dir.name
                desc = ""
                try:
                    raw_md = skill_md.read_text(encoding="utf-8", errors="replace")
                    fm_name, fm_desc = _parse_frontmatter(raw_md)
                    if fm_name:
                        name = fm_name
                    if fm_desc:
                        desc = fm_desc
                except OSError:
                    pass
                key = (name, source)
                if key not in seen_skills:
                    seen_skills.add(key)
                    skills.append({"name": name, "description": desc, "source": source})

        rules: list[dict[str, str]] = []
        rules_dir = self.cfg_dir / "rules"
        if rules_dir.is_dir():
            for r_file in sorted(rules_dir.iterdir(), key=lambda p: p.name.lower()):
                if r_file.is_file() and not r_file.name.startswith("."):
                    rules.append({"name": r_file.name, "source": "config"})

        return {
            "plugins": plugins,
            "skills": skills,
            "rules": rules,
            "slashCommands": list(OFFICIAL_SLASH_COMMANDS),
        }

    def _resolve_agentapi_bin(self) -> str | None:
        env_bin = os.environ.get("ZEROG_AGENTAPI_BIN", "").strip()
        if env_bin:
            p = Path(env_bin).expanduser()
            if p.is_file():
                return str(p)
            which_env = shutil.which(env_bin)
            if which_env:
                return which_env

        local_name = "agentapi.bat" if IS_WINDOWS else "agentapi"
        local_bin = self.agy_dir / "bin" / local_name
        if local_bin.is_file():
            return str(local_bin)

        return shutil.which("agentapi")

    async def _run_agentapi(self, bin_path: str, args: list[str], timeout_sec: float = 20.0) -> tuple[int, str, str]:
        if bin_path.lower().endswith(".py"):
            cmd = [sys.executable, bin_path, *args]
        elif IS_WINDOWS and bin_path.lower().endswith((".bat", ".cmd")):
            cmd = ["cmd.exe", "/c", bin_path, *args]
        else:
            cmd = [bin_path, *args]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
            return 124, "", "agentapi timed out"
        return (
            int(proc.returncode or 0),
            stdout_b.decode("utf-8", errors="replace"),
            stderr_b.decode("utf-8", errors="replace"),
        )

    def _extract_conversation_id(self, stdout: str, known_ids: set[str]) -> str | None:
        text = (stdout or "").strip()
        if text:
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    for key in ("conversationId", "conversation_id", "id"):
                        val = parsed.get(key)
                        if isinstance(val, str) and val.strip():
                            return val.strip()
            except json.JSONDecodeError:
                pass
            uuid_match = _UUID_RE.search(text)
            if uuid_match:
                return uuid_match.group(0)
            id_match = re.search(r"(?i)conversation[_\s-]*id\s*[:=]\s*([A-Za-z0-9_-]{4,128})", text)
            if id_match:
                return id_match.group(1)

        latest = self._read_all_conversations_from_db() or []
        fresh = [c for c in latest if c["id"] not in known_ids]
        if fresh:
            fresh.sort(key=lambda c: float(c.get("lastModifiedAt") or 0.0), reverse=True)
            return str(fresh[0]["id"])
        return None

    async def start_new_conversation(
        self,
        prompt: str,
        title: str | None = None,
        model: str | None = None,
        workspace_path: str | None = None,
        db: Any = None,
    ) -> dict[str, Any]:
        clean_prompt = (prompt or "").strip()
        if not clean_prompt:
            raise ValueError("prompt is required")

        resolved_title = (title or "").strip() or clean_prompt.splitlines()[0][:72] or "New Conversation"
        ws_clean = (workspace_path or "").strip() or None
        full_prompt = f"[Active Workspace: {ws_clean}]\n\n{clean_prompt}" if ws_clean else clean_prompt

        bin_path = self._resolve_agentapi_bin()
        if bin_path:
            existing_ids = {c["id"] for c in (self._read_all_conversations_from_db() or [])}
            args = ["new-conversation"]
            if title and title.strip():
                args.append(f"--title={title.strip()}")
            if model and model.strip() and model.strip().lower() != "auto":
                args.append(f"--model={model.strip()}")
            args.append(full_prompt)

            rc, out, _err = await self._run_agentapi(bin_path, args, timeout_sec=20.0)
            conv_id = self._extract_conversation_id(out, existing_ids) or f"agy-{uuid.uuid4().hex[:10]}"
            return {
                "ok": rc == 0,
                "conversationId": conv_id,
                "title": resolved_title,
                "deliveredVia": "agentapi",
            }

        # Fallback when agentapi binary is unavailable (e.g. test environment)
        conv_id = f"agy-{uuid.uuid4().hex[:10]}"
        if db is not None:
            now = time.time()
            proj_name = Path(ws_clean).name if ws_clean else "Antigravity"
            sess = SessionSummary(
                id=conv_id,
                title=resolved_title,
                projectId=slugify(proj_name),
                projectName=proj_name,
                provider="antigravity",
                source="phone_worker",
                status="idle",
                cwd=ws_clean or str(Path.cwd()),
                stepIdx=0,
                createdAt=now,
                updatedAt=now,
            )
            db.upsert_session(sess)
            red_prompt, _ = self.redactor.redact(full_prompt)
            db.queue_steering(conv_id, red_prompt)
            db.emit_event("session.created", sess.model_dump(), session_id=conv_id, provider="antigravity")
        return {
            "ok": True,
            "conversationId": conv_id,
            "title": resolved_title,
            "deliveredVia": "steering_queue",
        }

    async def send_conversation_message(
        self,
        conversation_id: str,
        message: str,
        db: Any = None,
    ) -> dict[str, Any]:
        cid = self.validate_conversation_id(conversation_id)
        clean_msg = (message or "").strip()
        if not clean_msg:
            raise ValueError("message is required")

        bin_path = self._resolve_agentapi_bin()
        if bin_path:
            rc, _out, _err = await self._run_agentapi(
                bin_path,
                ["send-message", cid, clean_msg],
                timeout_sec=20.0,
            )
            return {
                "ok": rc == 0,
                "conversationId": cid,
                "deliveredVia": "agentapi",
            }

        if db is not None:
            red_msg, _ = self.redactor.redact(clean_msg)
            queued = db.queue_steering(cid, red_msg)
            db.emit_event("steering.queued", queued, session_id=cid, provider="antigravity")
        return {
            "ok": True,
            "conversationId": cid,
            "deliveredVia": "steering_queue",
        }
