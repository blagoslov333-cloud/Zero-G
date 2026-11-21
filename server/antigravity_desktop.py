"""Read/control bridge for the local Antigravity Desktop IDE installation."""

from __future__ import annotations

import asyncio
import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
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
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024
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
_DANGEROUS_UPLOAD_EXTS = {".exe", ".bat", ".cmd", ".ps1", ".vbs", ".msi"}
_VALID_PERMISSION_PRESETS = {"inherit", "request_review", "default", "auto", "turbo"}
_VALID_WORKTREE_MODES = {"local", "worktree"}

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
        self._projects_cache: dict[tuple[str, tuple[str, ...]], tuple[float, list[dict[str, Any]]]] = {}
        self._title_redact_cache: dict[str, str] = {}
        self._last_db: Any = None

    def invalidate_projects_cache(self) -> None:
        """Clear the short-lived project discovery cache."""
        self._projects_cache.clear()

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
        swarm_dir = os.path.join(str(self.agy_dir), "brain", conversation_id, ".system_generated", "swarm")
        if not os.path.isdir(swarm_dir):
            return False
        return (
            os.path.isfile(os.path.join(swarm_dir, "plan.json"))
            or os.path.isfile(os.path.join(swarm_dir, "swarm.json"))
            or os.path.isfile(os.path.join(swarm_dir, "board.jsonl"))
            or os.path.isfile(os.path.join(swarm_dir, "board.json"))
        )

    def _redact_title_fast(self, raw_title: str) -> str:
        cached = self._title_redact_cache.get(raw_title)
        if cached is not None:
            return cached
        clean_title, _ = self.redactor.redact(raw_title)
        if len(self._title_redact_cache) < 4096:
            self._title_redact_cache[raw_title] = clean_title
        return clean_title

    def _read_all_conversations_from_db(self) -> list[dict[str, Any]] | None:
        conn = self._connect_ro()
        if conn is None:
            return None
        fts_map: dict[str, tuple[str, str]] = {}
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

            select_cp_parent = "cp.parent_id" if has_parents else "''"
            parent_join = (
                "LEFT JOIN conversation_parents cp ON cp.conversation_id = cs.conversation_id"
                if has_parents
                else ""
            )

            sql = f"""
                SELECT
                    cs.conversation_id,
                    cs.title,
                    cs.step_count,
                    cs.last_modified_time,
                    cs.workspace_uris,
                    cs.status,
                    cs.agent_name,
                    cs.parent_conversation_id,
                    cs.not_fully_idle,
                    cs.killed,
                    {select_cp_parent} AS cp_parent_id
                FROM conversation_summaries cs
                {parent_join}
            """
            rows = conn.execute(sql).fetchall()

            if has_fts:
                try:
                    fts_rows = conn.execute(
                        "SELECT conversation_id, title, project FROM conversations_fts WHERE chunk_index = -1"
                    ).fetchall()
                    for f_cid, f_title, f_proj in fts_rows:
                        f_cid_str = str(f_cid or "").strip()
                        if f_cid_str:
                            fts_map[f_cid_str] = (
                                str(f_title or "").strip(),
                                str(f_proj or "").strip(),
                            )
                except sqlite3.Error:
                    pass
        except sqlite3.Error:
            return None
        finally:
            conn.close()

        raw_items: list[dict[str, Any]] = []
        subagent_counts: dict[str, int] = {}

        for row in rows:
            (
                cid,
                cs_title,
                step_count,
                last_modified_time,
                workspace_uris_raw,
                raw_status,
                agent_name,
                parent_conv_id,
                not_fully_idle,
                killed,
                cp_parent_id,
            ) = row

            cid_str = str(cid or "").strip()
            if not cid_str:
                continue

            fts_title, fts_project = fts_map.get(cid_str, ("", ""))
            resolved_title = str(cs_title or "").strip() or fts_title or "Untitled Conversation"

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

            clean_title = self._redact_title_fast(str(resolved_title or "Untitled Conversation"))
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
            ws_norm = os.path.normcase(_win32_full_path(workspace_path))
            proj_norm = os.path.normcase(_win32_full_path(project_path))
            if ws_norm == proj_norm:
                return True
            return os.path.commonpath([ws_norm, proj_norm]) == proj_norm
        except Exception:
            return False

    def _probe_git_for_dir(self, proj_path: Path) -> tuple[str | None, int]:
        git_branch: str | None = None
        dirty_count = 0
        try:
            if (proj_path / ".git").exists():
                git_branch = probe_git_branch(proj_path) or self.git_manager.get_branch(str(proj_path))
                rc, out, _ = self.git_manager._run_git(
                    str(proj_path),
                    ["status", "--porcelain=v1"],
                    read_only=True,
                )
                if rc == 0 and out:
                    dirty_count = sum(1 for ln in out.splitlines() if ln.strip())
        except Exception:
            pass
        return git_branch, dirty_count

    def discover_real_projects(self) -> list[dict[str, Any]]:
        """Discover real existing workspace directories from DB workspace_uris + extra_project_roots."""
        cache_key = (str(self.agy_dir), tuple(str(p) for p in self.extra_project_roots))
        now = time.monotonic()
        cached = self._projects_cache.get(cache_key)
        if cached is not None and (now - cached[0]) < 10.0:
            return [dict(p, folders=list(p.get("folders") or [p["path"]])) for p in cached[1]]

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

        ordered_items = list(candidates_by_key.items())
        git_results: dict[str, tuple[str | None, int]] = {}
        if ordered_items:
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = {
                    norm_key: pool.submit(self._probe_git_for_dir, proj_path)
                    for norm_key, proj_path in ordered_items
                }
                for norm_key, fut in futures.items():
                    try:
                        git_results[norm_key] = fut.result()
                    except Exception:
                        git_results[norm_key] = (None, 0)

        projects: list[dict[str, Any]] = []
        used_ids: set[str] = set()
        for norm_key, proj_path in ordered_items:
            base_id = slugify(proj_path.name)
            proj_id = base_id
            if proj_id in used_ids:
                suffix = uuid.uuid5(uuid.NAMESPACE_URL, norm_key).hex[:6]
                proj_id = f"{base_id}-{suffix}"
            used_ids.add(proj_id)

            git_branch, dirty_count = git_results.get(norm_key, (None, 0))

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
                    "folders": [str(proj_path)],
                    "permissionPreset": "inherit",
                    "defaultWorktreeMode": "local",
                    "isCustom": False,
                    "gitBranch": git_branch,
                    "dirtyCount": dirty_count,
                    "conversationCount": conv_count,
                    "lastModifiedAt": last_mod,
                }
            )

        projects.sort(key=lambda p: float(p["lastModifiedAt"]), reverse=True)
        self._projects_cache[cache_key] = (
            time.monotonic(),
            [dict(p, folders=list(p["folders"])) for p in projects],
        )
        return projects

    def _load_project_configs(self, db: Any = None) -> dict[str, dict[str, Any]]:
        if db is not None:
            self._last_db = db
        effective_db = db if db is not None else self._last_db
        if effective_db is None or not hasattr(effective_db, "get_kv"):
            return {}
        raw = effective_db.get_kv("agy_project_configs", {})
        if not isinstance(raw, dict):
            return {}
        return {str(k): dict(v) for k, v in raw.items() if isinstance(v, dict)}

    @staticmethod
    def _normalize_folder_list(raw_folders: list[Any]) -> list[str]:
        norm_folders: list[str] = []
        seen: set[str] = set()
        for f in raw_folders:
            s = str(f or "").strip()
            if not s:
                continue
            resolved = _win32_full_path(s) if os.path.isdir(s) else os.path.normpath(s)
            key = os.path.normcase(resolved)
            if key not in seen:
                seen.add(key)
                norm_folders.append(resolved)
        return norm_folders

    def get_merged_projects(self, db: Any = None) -> list[dict[str, Any]]:
        """Merge discovered projects with persisted multi-folder & permission preset configs."""
        discovered = self.discover_real_projects()
        configs = self._load_project_configs(db)
        if not configs:
            return discovered

        disc_by_id = {p["id"]: p for p in discovered}
        disc_by_path = {os.path.normcase(_win32_full_path(p["path"])): p for p in discovered}
        top_convs: list[dict[str, Any]] | None = None

        def _get_top_convs() -> list[dict[str, Any]]:
            nonlocal top_convs
            if top_convs is None:
                top_convs = [c for c in self._all_conversations() if not c.get("parentConversationId")]
            return top_convs

        def _build_merged_entry(
            proj_id: str,
            name: str,
            folders: list[str],
            preset: str,
            wt_mode: str,
            is_custom: bool,
            base_disc: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            primary_path = next((f for f in folders if os.path.isdir(f)), folders[0])
            norm_preset = preset if preset in _VALID_PERMISSION_PRESETS else "inherit"
            norm_wt = wt_mode if wt_mode in _VALID_WORKTREE_MODES else "local"

            if base_disc is not None and len(folders) == 1 and os.path.normcase(folders[0]) == os.path.normcase(base_disc["path"]):
                git_branch = base_disc.get("gitBranch")
                dirty_count = int(base_disc.get("dirtyCount") or 0)
                conv_count = int(base_disc.get("conversationCount") or 0)
                last_mod = float(base_disc.get("lastModifiedAt") or 0.0)
            else:
                primary_key = os.path.normcase(_win32_full_path(primary_path)) if os.path.isdir(primary_path) else ""
                if primary_key in disc_by_path:
                    git_branch = disc_by_path[primary_key].get("gitBranch")
                elif os.path.isdir(primary_path):
                    git_branch, _ = self._probe_git_for_dir(Path(primary_path))
                else:
                    git_branch = None

                dirty_count = 0
                for folder in folders:
                    f_key = os.path.normcase(_win32_full_path(folder)) if os.path.isdir(folder) else ""
                    if f_key in disc_by_path:
                        dirty_count += int(disc_by_path[f_key].get("dirtyCount") or 0)
                    elif os.path.isdir(folder):
                        _, d_cnt = self._probe_git_for_dir(Path(folder))
                        dirty_count += d_cnt

                convs = _get_top_convs()
                matching = [
                    c
                    for c in convs
                    if any(
                        self._path_matches_project(wp, folder)
                        for wp in (c.get("workspacePaths") or [])
                        for folder in folders
                    )
                ]
                conv_count = len(matching)
                if matching:
                    last_mod = max(float(c.get("lastModifiedAt") or 0.0) for c in matching)
                else:
                    mtimes: list[float] = []
                    for folder in folders:
                        try:
                            if os.path.isdir(folder):
                                mtimes.append(float(Path(folder).stat().st_mtime))
                        except OSError:
                            pass
                    last_mod = max(mtimes) if mtimes else 0.0

            return {
                "id": proj_id,
                "name": name,
                "path": primary_path,
                "folders": folders,
                "permissionPreset": norm_preset,
                "defaultWorktreeMode": norm_wt,
                "isCustom": is_custom,
                "gitBranch": git_branch,
                "dirtyCount": dirty_count,
                "conversationCount": conv_count,
                "lastModifiedAt": last_mod,
            }

        merged: list[dict[str, Any]] = []
        handled_ids: set[str] = set()

        for dp in discovered:
            pid = dp["id"]
            handled_ids.add(pid)
            cfg = configs.get(pid)
            if not cfg:
                merged.append(dp)
                continue
            raw_f = cfg.get("folders") if isinstance(cfg.get("folders"), list) and cfg.get("folders") else [dp["path"]]
            folders = self._normalize_folder_list(raw_f) or [dp["path"]]
            merged.append(
                _build_merged_entry(
                    proj_id=pid,
                    name=str(cfg.get("name") or dp["name"]).strip() or dp["name"],
                    folders=folders,
                    preset=str(cfg.get("permissionPreset") or "inherit").strip().lower(),
                    wt_mode=str(cfg.get("defaultWorktreeMode") or "local").strip().lower(),
                    is_custom=bool(cfg.get("isCustom", False)),
                    base_disc=dp,
                )
            )

        for cfg_id, cfg in configs.items():
            if cfg_id in handled_ids:
                continue
            raw_f = cfg.get("folders") if isinstance(cfg.get("folders"), list) and cfg.get("folders") else (
                [cfg["path"]] if cfg.get("path") else []
            )
            folders = self._normalize_folder_list(raw_f)
            if not folders:
                continue
            primary = next((f for f in folders if os.path.isdir(f)), folders[0])
            name = str(cfg.get("name") or Path(primary).name or cfg_id).strip()
            merged.append(
                _build_merged_entry(
                    proj_id=cfg_id,
                    name=name,
                    folders=folders,
                    preset=str(cfg.get("permissionPreset") or "inherit").strip().lower(),
                    wt_mode=str(cfg.get("defaultWorktreeMode") or "local").strip().lower(),
                    is_custom=bool(cfg.get("isCustom", True)),
                    base_disc=disc_by_id.get(cfg_id),
                )
            )

        merged.sort(key=lambda p: float(p["lastModifiedAt"]), reverse=True)
        return merged

    def upsert_configured_project(self, db: Any, payload: dict[str, Any]) -> dict[str, Any]:
        """Create or update a multi-folder project config and per-project permission preset."""
        if db is not None:
            self._last_db = db
        if not isinstance(payload, dict):
            raise ValueError("payload must be a JSON object")

        configs = self._load_project_configs(db)
        discovered = self.discover_real_projects()
        disc_by_id = {p["id"]: p for p in discovered}
        disc_by_path = {os.path.normcase(_win32_full_path(p["path"])): p for p in discovered}

        proj_id = str(payload.get("id") or payload.get("projectId") or "").strip()
        raw_folders_in = payload.get("folders") if isinstance(payload.get("folders"), list) else None
        raw_path_in = str(payload.get("path") or "").strip()

        if not proj_id and raw_path_in:
            norm_p = os.path.normcase(_win32_full_path(raw_path_in) if os.path.isdir(raw_path_in) else os.path.normpath(raw_path_in))
            if norm_p in disc_by_path:
                proj_id = disc_by_path[norm_p]["id"]

        if not proj_id:
            raw_name = str(payload.get("name") or "").strip()
            if not raw_name:
                first_f = (str(raw_folders_in[0]).strip() if raw_folders_in else "") or raw_path_in
                if first_f:
                    raw_name = Path(first_f).name
            if not raw_name:
                raise ValueError("Project id or name is required")
            base_slug = slugify(raw_name)
            proj_id = base_slug if (base_slug in configs or base_slug not in disc_by_id) else f"{base_slug}-{uuid.uuid4().hex[:6]}"

        existing_cfg = configs.get(proj_id, {})
        disc_proj = disc_by_id.get(proj_id)

        if raw_folders_in is not None:
            candidate_folders = self._normalize_folder_list(raw_folders_in)
        elif raw_path_in:
            candidate_folders = self._normalize_folder_list([raw_path_in])
        elif existing_cfg.get("folders"):
            candidate_folders = self._normalize_folder_list(existing_cfg["folders"])
        elif disc_proj:
            candidate_folders = [disc_proj["path"]]
        else:
            candidate_folders = []

        if not candidate_folders:
            raise ValueError("At least one project folder path is required")

        primary_path = next((f for f in candidate_folders if os.path.isdir(f)), candidate_folders[0])
        name = str(
            payload.get("name")
            or existing_cfg.get("name")
            or (disc_proj["name"] if disc_proj else Path(primary_path).name)
            or proj_id
        ).strip()

        preset = str(
            payload.get("permissionPreset")
            or existing_cfg.get("permissionPreset")
            or "inherit"
        ).strip().lower()
        if preset not in _VALID_PERMISSION_PRESETS:
            raise ValueError(f"Invalid permissionPreset: {preset!r}")

        wt_mode = str(
            payload.get("defaultWorktreeMode")
            or payload.get("worktreeMode")
            or existing_cfg.get("defaultWorktreeMode")
            or "local"
        ).strip().lower()
        if wt_mode not in _VALID_WORKTREE_MODES:
            raise ValueError(f"Invalid defaultWorktreeMode: {wt_mode!r}")

        is_custom = bool(payload.get("isCustom", existing_cfg.get("isCustom", disc_proj is None)))

        configs[proj_id] = {
            "id": proj_id,
            "name": name,
            "path": primary_path,
            "folders": candidate_folders,
            "permissionPreset": preset,
            "defaultWorktreeMode": wt_mode,
            "isCustom": is_custom,
            "updatedAt": time.time(),
        }

        effective_db = db if db is not None else self._last_db
        if effective_db is not None and hasattr(effective_db, "set_kv"):
            effective_db.set_kv("agy_project_configs", configs)

        merged_list = self.get_merged_projects(effective_db)
        matched = next((p for p in merged_list if p["id"] == proj_id), None)
        if matched is not None:
            return matched
        return {
            "id": proj_id,
            "name": name,
            "path": primary_path,
            "folders": candidate_folders,
            "permissionPreset": preset,
            "defaultWorktreeMode": wt_mode,
            "isCustom": is_custom,
            "gitBranch": None,
            "dirtyCount": 0,
            "conversationCount": 0,
            "lastModifiedAt": time.time(),
        }

    def delete_configured_project(self, db: Any, project_id: str) -> bool:
        """Delete a configured project override or custom multi-folder project by id."""
        if db is not None:
            self._last_db = db
        pid = (project_id or "").strip()
        effective_db = db if db is not None else self._last_db
        if not pid or effective_db is None or not hasattr(effective_db, "get_kv"):
            return False
        configs = self._load_project_configs(effective_db)
        if pid not in configs:
            return False
        configs.pop(pid, None)
        if hasattr(effective_db, "set_kv"):
            effective_db.set_kv("agy_project_configs", configs)
        return True

    def resolve_project_preset_for_cwd(self, db: Any, cwd: str | None) -> str | None:
        """Return the effective non-inherited permissionPreset for a given working directory."""
        if not cwd or not str(cwd).strip():
            return None
        target_cwd = str(cwd).strip()
        best_preset: str | None = None
        best_len = -1
        for proj in self.get_merged_projects(db):
            preset = str(proj.get("permissionPreset") or "inherit").strip().lower()
            if preset == "inherit" or preset not in _VALID_PERMISSION_PRESETS:
                continue
            for folder in proj.get("folders") or [proj["path"]]:
                if self._path_matches_project(target_cwd, folder):
                    f_len = len(os.path.abspath(folder))
                    if f_len > best_len:
                        best_len = f_len
                        best_preset = preset
        return best_preset

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

    def _annotate_subagent_tail(self, sub_summary: dict[str, Any]) -> dict[str, Any]:
        item = dict(sub_summary)
        sub_id = str(item.get("id") or "").strip()
        latest_message: str | None = None
        last_step_type: str | None = None
        if sub_id:
            transcript_path = self.agy_dir / "brain" / sub_id / ".system_generated" / "logs" / "transcript.jsonl"
            if transcript_path.is_file():
                try:
                    raw_lines = transcript_path.read_text(encoding="utf-8", errors="replace").splitlines()
                    for raw_line in reversed(raw_lines[-80:]):
                        line = raw_line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(obj, dict):
                            continue
                        st = str(obj.get("type") or "").strip()
                        src = str(obj.get("source") or "").strip()
                        if st in ("EPHEMERAL_MESSAGE", "CHECKPOINT") or src == "SYSTEM_SDK":
                            continue
                        if last_step_type is None and st:
                            last_step_type = st
                        raw_txt = str(obj.get("content") or obj.get("thinking") or "").strip()
                        if raw_txt:
                            if st == "USER_INPUT" or src == "USER_EXPLICIT":
                                raw_txt = _clean_user_content(raw_txt)
                            elif st == "GENERIC":
                                raw_txt = _GENERIC_TIMESTAMP_PREFIX_RE.sub("", raw_txt).strip()
                            if raw_txt:
                                red_txt, _ = self.redactor.redact(raw_txt)
                                latest_message = red_txt[:280]
                                break
                except OSError:
                    pass
        item["latestMessage"] = latest_message
        item["lastStepType"] = last_step_type
        return item

    def _read_swarm_files(
        self,
        conv_dir: Path,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, list[dict[str, Any]]]:
        swarm_dir = conv_dir / ".system_generated" / "swarm"
        if not swarm_dir.is_dir():
            return None, None, []

        swarm_plan: dict[str, Any] | None = None
        plan_path = swarm_dir / "plan.json"
        if plan_path.is_file():
            try:
                loaded_plan = json.loads(plan_path.read_text(encoding="utf-8", errors="replace"))
                if isinstance(loaded_plan, dict):
                    swarm_plan = self.redactor.redact_dict(loaded_plan)
            except (OSError, json.JSONDecodeError):
                swarm_plan = None

        swarm_meta: dict[str, Any] | None = None
        for meta_name in ("swarm.json", "members.json"):
            m_path = swarm_dir / meta_name
            if m_path.is_file():
                try:
                    loaded_m = json.loads(m_path.read_text(encoding="utf-8", errors="replace"))
                    if isinstance(loaded_m, dict):
                        red_m = self.redactor.redact_dict(loaded_m)
                        swarm_meta = {**(swarm_meta or {}), **red_m}
                except (OSError, json.JSONDecodeError):
                    pass

        board_messages: list[dict[str, Any]] = []
        seen_msgs: set[tuple[int, str, str]] = set()

        def _append_msg_obj(obj: Any) -> None:
            if not isinstance(obj, dict):
                return
            raw_txt = str(obj.get("text") or obj.get("content") or obj.get("message") or "").strip()
            if not raw_txt:
                return
            red_txt, _ = self.redactor.redact(raw_txt)
            seq_raw = obj.get("seq")
            seq_val = int(seq_raw) if isinstance(seq_raw, int) else (len(board_messages) + 1)
            agent_val = str(obj.get("agent") or obj.get("sender") or obj.get("author") or "agent").strip()
            time_val = str(obj.get("time") or obj.get("timestamp") or obj.get("created_at") or "").strip()
            kind_val = str(obj.get("kind") or "message").strip()
            dedup_key = (seq_val, agent_val, red_txt)
            if dedup_key in seen_msgs:
                return
            seen_msgs.add(dedup_key)
            board_messages.append(
                {
                    "seq": seq_val,
                    "agent": agent_val,
                    "text": red_txt,
                    "time": time_val,
                    "kind": kind_val,
                }
            )

        try:
            swarm_files = sorted(swarm_dir.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            swarm_files = []

        for fpath in swarm_files:
            if not fpath.is_file():
                continue
            low = fpath.name.lower()
            if low.endswith(".jsonl") and (low.startswith("board") or low.startswith("message")):
                try:
                    for line in fpath.read_text(encoding="utf-8", errors="replace").splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            _append_msg_obj(json.loads(line))
                        except json.JSONDecodeError:
                            continue
                except OSError:
                    continue
            elif low.endswith(".json") and (
                low.startswith("board")
                or low.startswith("message")
                or low in ("swarm.json", "plan.json")
            ):
                try:
                    loaded = json.loads(fpath.read_text(encoding="utf-8", errors="replace"))
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(loaded, list):
                    for item in loaded:
                        _append_msg_obj(item)
                elif isinstance(loaded, dict):
                    for list_key in ("messages", "board", "boardMessages"):
                        candidate_list = loaded.get(list_key)
                        if isinstance(candidate_list, list):
                            for item in candidate_list:
                                _append_msg_obj(item)

        board_messages.sort(key=lambda m: int(m.get("seq") or 0))
        return swarm_plan, swarm_meta, board_messages[-200:]

    def get_swarm_detail(self, conversation_id: str) -> dict[str, Any]:
        cid = self.validate_conversation_id(conversation_id)
        all_convs = self._all_conversations()
        summary = next((c for c in all_convs if c["id"] == cid), None)
        conv_dir = self.agy_dir / "brain" / cid
        if summary is None and not conv_dir.is_dir():
            raise FileNotFoundError(f"Conversation '{cid}' not found")

        subagents = [
            self._annotate_subagent_tail(c)
            for c in all_convs
            if c.get("parentConversationId") == cid
        ]
        swarm_plan, swarm_meta, board_messages = self._read_swarm_files(conv_dir)

        return {
            "ok": True,
            "conversationId": cid,
            "hasSwarm": bool(swarm_plan or swarm_meta or board_messages or subagents),
            "swarmPlan": swarm_plan,
            "swarmMeta": swarm_meta,
            "boardMessages": board_messages,
            "subagents": subagents,
        }

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

        subagents = [
            self._annotate_subagent_tail(c)
            for c in all_convs
            if c.get("parentConversationId") == cid
        ]
        artifacts = self._collect_brain_artifacts(conv_dir)
        swarm_plan, _swarm_meta, board_messages = self._read_swarm_files(conv_dir)

        transcript_path = conv_dir / ".system_generated" / "logs" / "transcript.jsonl"
        messages: list[dict[str, Any]] = []
        if transcript_path.is_file():
            messages = self._parse_transcript_messages(cid, transcript_path, limit=limit)

        detail: dict[str, Any] = {
            "conversation": summary,
            "messages": messages,
            "artifacts": artifacts,
            "subagents": subagents,
            "swarmPlan": swarm_plan,
            "boardMessages": board_messages,
        }
        return detail

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

        conv_dir_norm = str(self.agy_dir / "brain" / cid).replace("\\", "/").lower()
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
            pending_questions: list[dict[str, Any]] = []
            plan_review: dict[str, Any] | None = None

            for tc in raw_tool_calls:
                if not isinstance(tc, dict):
                    continue
                tc_name = str(tc.get("name") or tc.get("toolName") or "tool")
                tc_args = tc.get("args") if "args" in tc else tc.get("arguments")
                if isinstance(tc_args, str):
                    try:
                        parsed_tc_args = json.loads(tc_args)
                        if isinstance(parsed_tc_args, dict):
                            tc_args = parsed_tc_args
                    except json.JSONDecodeError:
                        pass

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

                tc_low = tc_name.lower()
                if (tc_low == "ask_question" or tc_low.endswith("ask_question")) and isinstance(tc_args, dict):
                    raw_qs = tc_args.get("questions")
                    if isinstance(raw_qs, list):
                        for q in raw_qs:
                            if not isinstance(q, dict):
                                continue
                            q_text, _ = self.redactor.redact(str(q.get("question") or "").strip())
                            if not q_text:
                                continue
                            raw_opts = q.get("options") if isinstance(q.get("options"), list) else []
                            red_opts = [
                                self.redactor.redact(str(opt).strip())[0]
                                for opt in raw_opts
                                if str(opt).strip()
                            ]
                            is_multi = bool(q.get("is_multi_select") or q.get("isMultiSelect") or False)
                            q_entry: dict[str, Any] = {
                                "question": q_text,
                                "options": red_opts,
                                "is_multi_select": is_multi,
                                "isMultiSelect": is_multi,
                            }
                            if q.get("header"):
                                q_entry["header"] = self.redactor.redact(str(q["header"]).strip())[0]
                            pending_questions.append(q_entry)

                elif (tc_low == "exit_plan_mode" or tc_low.endswith("exit_plan_mode")) and isinstance(tc_args, dict):
                    raw_plan = str(tc_args.get("plan") or "").strip()
                    if raw_plan:
                        red_plan, _ = self.redactor.redact(raw_plan)
                        raw_title = str(tc_args.get("title") or "").strip()
                        if not raw_title:
                            first_ln = red_plan.splitlines()[0].lstrip("# ").strip()
                            raw_title = first_ln[:80] if first_ln else "Implementation Plan"
                        red_title, _ = self.redactor.redact(raw_title)
                        art_path = str(tc_args.get("artifactPath") or tc_args.get("path") or "").strip() or None
                        plan_review = {
                            "title": red_title or "Implementation Plan",
                            "summary": red_plan,
                            "artifactPath": art_path,
                            "canProceed": True,
                        }

                elif (tc_low.endswith("write_file") or tc_low.endswith("edit_file")) and isinstance(tc_args, dict):
                    art_meta = tc_args.get("ArtifactMetadata") or tc_args.get("artifactMetadata")
                    if isinstance(art_meta, dict) and (
                        art_meta.get("RequestFeedback") is True or art_meta.get("requestFeedback") is True
                    ):
                        raw_sum = str(
                            art_meta.get("Summary")
                            or art_meta.get("summary")
                            or tc_args.get("Content")
                            or ""
                        ).strip()
                        red_sum, _ = self.redactor.redact(raw_sum)
                        raw_p = str(tc_args.get("Path") or tc_args.get("path") or "").strip()
                        norm_p = raw_p.replace("\\", "/")
                        if norm_p.lower().startswith(conv_dir_norm + "/"):
                            art_rel: str | None = norm_p[len(conv_dir_norm) + 1 :]
                        elif norm_p:
                            art_rel = Path(norm_p).name
                        else:
                            art_rel = None
                        red_title, _ = self.redactor.redact(art_rel or "Implementation Plan")
                        plan_review = {
                            "title": red_title,
                            "summary": red_sum,
                            "artifactPath": art_rel,
                            "canProceed": True,
                        }

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

            msg_entry: dict[str, Any] = {
                "id": f"{cid}-step-{step_index_int}",
                "stepIndex": step_index_int,
                "role": "assistant",
                "content": red_content,
                "thinking": red_thinking,
                "model": str(obj["model"]) if obj.get("model") else None,
                "toolCalls": tool_calls,
                "createdAt": created_at,
            }
            if pending_questions:
                msg_entry["pendingQuestions"] = pending_questions
            if plan_review is not None:
                msg_entry["planReview"] = plan_review
            messages.append(msg_entry)

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

    def _resolve_allowed_project(
        self,
        project_path: str,
        db: Any = None,
    ) -> tuple[int, Path | None, str]:
        raw = (project_path or "").strip()
        if not raw:
            return 400, None, "projectPath is required"
        if not os.path.isdir(raw):
            return 404, None, f"Project directory not found: {raw}"

        target_full = _win32_full_path(raw)
        target_norm = os.path.normcase(target_full)

        allowed: dict[str, Path] = {}
        for p in self.discover_real_projects():
            for f_path in [p["path"], *(p.get("folders") or [])]:
                if f_path and os.path.isdir(f_path):
                    full_f = _win32_full_path(f_path)
                    allowed[os.path.normcase(full_f)] = Path(full_f)

        for cfg in self._load_project_configs(db).values():
            for f_path in [cfg.get("path"), *(cfg.get("folders") or [])]:
                if isinstance(f_path, str) and f_path.strip() and os.path.isdir(f_path):
                    full_f = _win32_full_path(f_path)
                    allowed[os.path.normcase(full_f)] = Path(full_f)

        if target_norm in allowed:
            return 200, allowed[target_norm], ""

        # Accept .0g-worktrees/* paths under any allowed project root
        for allowed_path in allowed.values():
            wt_root = os.path.join(str(allowed_path), ".0g-worktrees")
            wt_root_norm = os.path.normcase(_win32_full_path(wt_root))
            try:
                if os.path.commonpath([wt_root_norm, target_norm]) == wt_root_norm and target_norm != wt_root_norm:
                    return 200, Path(target_full), ""
            except ValueError:
                continue

        return 403, None, "projectPath is not an allowed Antigravity project directory"

    def save_workspace_upload(
        self,
        project_path: str,
        filename: str,
        data_base64: str,
        db: Any = None,
    ) -> tuple[int, dict[str, Any]]:
        """Validate and save a base64-encoded user upload inside <project>/.antigravity_uploads/."""
        status, proj_dir, err = self._resolve_allowed_project(project_path, db=db)
        if proj_dir is None:
            return status, {"detail": err}

        raw_filename = (filename or "").strip()
        base_name = Path(raw_filename.replace("\\", "/")).name.strip()
        if not raw_filename or not base_name or base_name in (".", ".."):
            return 400, {"detail": "filename is required"}

        safe_name = re.sub(r"[^A-Za-z0-9._ -]+", "_", base_name).strip(" .")
        if not safe_name:
            return 400, {"detail": "Invalid filename"}

        if _is_secret_relpath(base_name) or _is_secret_relpath(safe_name):
            return 403, {"detail": "Uploading secret or credential files is forbidden"}

        raw_ext = Path(base_name).suffix.lower()
        safe_ext = Path(safe_name).suffix.lower()
        if raw_ext in _DANGEROUS_UPLOAD_EXTS or safe_ext in _DANGEROUS_UPLOAD_EXTS:
            return 403, {"detail": f"Uploading executable file extension '{raw_ext or safe_ext}' is forbidden"}

        raw_b64 = (data_base64 or "").strip()
        if not raw_b64:
            return 400, {"detail": "dataBase64 is required"}
        if raw_b64.lower().startswith("data:") and "," in raw_b64:
            raw_b64 = raw_b64.split(",", 1)[1].strip()

        compact_b64 = re.sub(r"\s+", "", raw_b64)
        if not compact_b64:
            return 400, {"detail": "Empty base64 payload"}
        rem = len(compact_b64) % 4
        if rem in (2, 3):
            compact_b64 += "=" * (4 - rem)
        try:
            raw_bytes = base64.b64decode(compact_b64, validate=True)
        except (binascii.Error, ValueError):
            return 400, {"detail": "Invalid base64 encoding"}

        if len(raw_bytes) > _MAX_UPLOAD_BYTES:
            return 413, {"detail": f"Upload exceeds 10MB limit ({len(raw_bytes)} bytes)"}

        proj_abs = _win32_full_path(str(proj_dir))
        candidate_rel = f".antigravity_uploads/{int(time.time())}_{safe_name}"
        ok, rel_posix, r_err = _resolve_inside_repo(proj_abs, candidate_rel, allow_dot_git=False)
        if not ok:
            return 403, {"detail": r_err or "Invalid upload path"}

        dest = Path(proj_abs) / rel_posix
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw_bytes)
        except OSError as exc:
            return 500, {"detail": str(exc)}

        return 200, {
            "ok": True,
            "fileName": dest.name,
            "relPath": rel_posix,
            "absPath": str(dest),
            "sizeBytes": len(raw_bytes),
            "mentionToken": f"@{rel_posix}",
        }

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
        if "ZEROG_AGENTAPI_BIN" in os.environ:
            env_bin = os.environ.get("ZEROG_AGENTAPI_BIN", "").strip()
            if not env_bin or env_bin.lower() in ("none", "false", "0", "off"):
                return None
            p = Path(env_bin).expanduser()
            if p.is_file():
                return str(p)
            which_env = shutil.which(env_bin)
            if which_env:
                return which_env
            return None

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
        worktree_mode: str = "local",
        branch_name: str | None = None,
        folders: list[str] | None = None,
        permission_preset: str | None = None,
    ) -> dict[str, Any]:
        if db is not None:
            self._last_db = db
        clean_prompt = (prompt or "").strip()
        if not clean_prompt:
            raise ValueError("prompt is required")

        resolved_title = (title or "").strip() or clean_prompt.splitlines()[0][:72] or "New Conversation"
        clean_folders = [str(f).strip() for f in (folders or []) if str(f).strip()]
        ws_clean = (workspace_path or "").strip() or (clean_folders[0] if clean_folders else None)

        norm_wt_mode = (worktree_mode or "local").strip().lower()
        created_worktree_path: str | None = None
        created_branch_name: str | None = None
        if norm_wt_mode == "worktree" and ws_clean and self.git_manager._is_git_repo(ws_clean):
            target_branch = (branch_name or "").strip() or f"agy-{slugify(resolved_title)[:20]}-{uuid.uuid4().hex[:4]}"
            wt = self.git_manager.create_worktree(ws_clean, target_branch)
            if wt.get("ok") and wt.get("worktreePath"):
                ws_clean = str(wt["worktreePath"])
                created_worktree_path = ws_clean
                created_branch_name = wt.get("branchName")
                self.invalidate_projects_cache()

        header_lines: list[str] = []
        if ws_clean:
            header_lines.append(f"[Active Workspace: {ws_clean}]")
        if len(clean_folders) > 1:
            header_lines.append(f"[Active Project Folders: {', '.join(clean_folders)}]")
        full_prompt = ("\n".join(header_lines) + f"\n\n{clean_prompt}") if header_lines else clean_prompt

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
            res_out: dict[str, Any] = {
                "ok": rc == 0,
                "conversationId": conv_id,
                "title": resolved_title,
                "deliveredVia": "agentapi",
            }
            if created_worktree_path:
                res_out["worktreePath"] = created_worktree_path
                res_out["branchName"] = created_branch_name
            if permission_preset:
                res_out["permissionPreset"] = permission_preset
            return res_out

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
                worktreePath=created_worktree_path,
                worktreeBranch=created_branch_name,
                stepIdx=0,
                createdAt=now,
                updatedAt=now,
            )
            db.upsert_session(sess)
            red_prompt, _ = self.redactor.redact(full_prompt)
            db.queue_steering(conv_id, red_prompt)
            db.emit_event("session.created", sess.model_dump(), session_id=conv_id, provider="antigravity")
        fallback_out: dict[str, Any] = {
            "ok": True,
            "conversationId": conv_id,
            "title": resolved_title,
            "deliveredVia": "steering_queue",
        }
        if created_worktree_path:
            fallback_out["worktreePath"] = created_worktree_path
            fallback_out["branchName"] = created_branch_name
        if permission_preset:
            fallback_out["permissionPreset"] = permission_preset
        return fallback_out

    async def send_conversation_message(
        self,
        conversation_id: str,
        message: str,
        db: Any = None,
    ) -> dict[str, Any]:
        if db is not None:
            self._last_db = db
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

    async def nudge_agent(
        self,
        conversation_id: str,
        message: str,
        db: Any = None,
    ) -> dict[str, Any]:
        """Nudge an active conversation or swarm subagent by sending a direct message."""
        return await self.send_conversation_message(
            conversation_id=conversation_id,
            message=message,
            db=db,
        )
