"""SQLite WAL database layer for 0G with asyncio event fan-out and SHA-256 audit hash chain."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from server.contracts import (
    ApprovalItem,
    MacroShortcut,
    MobileToolSpec,
    ProjectSummary,
    RuleEntry,
    SessionSummary,
    StreamEnvelope,
    TimelineStep,
)


DEFAULT_RULES: list[dict[str, Any]] = [
    {
        "id": "rule-tier3-self-protect",
        "name": "Tier-3 Self-Protection (Hooks, Secrets & Credentials)",
        "provider": "*",
        "toolPattern": "*",
        "commandRegex": r"(?i)(hooks\.json|plugins[/\\]0g|\.gemini[/\\]config[/\\]config\.json|\.env(\.|$)|id_rsa|\.pem\b|\.key\b|\.pfx\b|bridge\.token|vapid_keys\.json)",
        "action": "deny",
        "riskTier": 3,
        "enabled": True,
        "expiresAt": None,
        "scopeCwd": None,
    },
    {
        "id": "rule-tier3-destructive-sys",
        "name": "Tier-3 Destructive System & History Commands",
        "provider": "*",
        "toolPattern": "run_command|Bash|shell",
        "commandRegex": r"(?i)(\brm\s+-rf\s+[/\\~]|\bformat\s+[a-z]:|\breg\s+delete\b|\bgit\s+push\s+--force\b|\bgit\s+reset\s+--hard\b|\bRemove-Item\b.*-Recurse.*-Force\s+[a-zA-Z]:[/\\]$)",
        "action": "deny",
        "riskTier": 3,
        "enabled": True,
        "expiresAt": None,
        "scopeCwd": None,
    },
    {
        "id": "rule-tier0-readonly-git",
        "name": "Tier-0 Safe Read-Only Git & Inspection",
        "provider": "*",
        "toolPattern": "run_command|Bash|shell|read_file|view_file",
        "commandRegex": r"^(git\s+(status|diff|log|branch|rev-parse|show)\b|dir\b|ls\b|Get-ChildItem\b|type\b|cat\b|echo\b|python(\.exe)?\s+-m\s+py_compile\b)",
        "action": "allow",
        "riskTier": 0,
        "enabled": True,
        "expiresAt": None,
        "scopeCwd": None,
    },
]

DEFAULT_MACROS: list[dict[str, Any]] = [
    {
        "id": "macro-git-status",
        "name": "Git Status & Diff Stat",
        "icon": "git-branch",
        "command": "git status -sb && git diff --stat",
        "cwd": None,
        "provider": "shell",
        "requiresPasskey": False,
    },
    {
        "id": "macro-pytest-fast",
        "name": "Run Unit Tests (Fast)",
        "icon": "check-circle",
        "command": "python -m unittest discover -s tests -v",
        "cwd": None,
        "provider": "shell",
        "requiresPasskey": False,
    },
    {
        "id": "macro-port-scan",
        "name": "List Active Local Dev Ports",
        "icon": "radio",
        "command": "netstat -ano -p TCP | findstr LISTENING",
        "cwd": None,
        "provider": "shell",
        "requiresPasskey": False,
    },
]


class ZeroGDatabase:
    """Thread-safe and asyncio-aware SQLite WAL persistence and event stream store."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        if db_path is None:
            data_dir = Path(os.environ.get("ZEROG_DATA_DIR", Path.home() / ".0g" / "data"))
            data_dir.mkdir(parents=True, exist_ok=True)
            db_path = data_dir / "0g.sqlite3"
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._waiters: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()
        self._init_schema()
        self._seed_defaults()

    @contextlib.contextmanager
    def _get_conn(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(str(self.db_path), timeout=5.0, check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000;")
            try:
                yield conn
            finally:
                conn.close()

    def _init_schema(self) -> None:
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL;")
            cur.execute("PRAGMA synchronous=NORMAL;")
            cur.executescript(
                """
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL NOT NULL,
                    event_type TEXT NOT NULL,
                    session_id TEXT,
                    provider TEXT,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS timeline_steps (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    step_idx INTEGER NOT NULL,
                    data_json TEXT NOT NULL,
                    ts REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline_steps(session_id, step_idx, ts);

                CREATE TABLE IF NOT EXISTS approvals (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

                CREATE TABLE IF NOT EXISTS rules (
                    id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS mobile_tools (
                    id TEXT PRIMARY KEY,
                    name TEXT UNIQUE NOT NULL,
                    data_json TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS steering_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    message TEXT NOT NULL,
                    client_msg_id TEXT UNIQUE,
                    created_at REAL NOT NULL,
                    consumed INTEGER DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_steering_pending ON steering_queue(session_id, consumed, id);

                CREATE TABLE IF NOT EXISTS push_subscriptions (
                    endpoint TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS webauthn_credentials (
                    cred_id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL NOT NULL,
                    actor TEXT NOT NULL,
                    action TEXT NOT NULL,
                    details_json TEXT NOT NULL,
                    prev_hash TEXT NOT NULL,
                    entry_hash TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS kv_store (
                    k TEXT PRIMARY KEY,
                    v_json TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                """
            )

    def _seed_defaults(self) -> None:
        with self._get_conn() as conn:
            row = conn.execute("SELECT COUNT(*) AS c FROM rules").fetchone()
            if row and row["c"] == 0:
                for rule_dict in DEFAULT_RULES:
                    rule = RuleEntry.model_validate(rule_dict)
                    conn.execute(
                        "INSERT OR IGNORE INTO rules(id, data_json) VALUES (?, ?)",
                        (rule.id, rule.model_dump_json()),
                    )

            if self.get_kv("seeded_projects") is None:
                scratch_root = Path(r"C:\Users\blagoslov333\.gemini\antigravity\scratch")
                video_path = scratch_root / "Video production"
                zero_g_path = scratch_root / "0G"
                seeded_projects = [
                    ProjectSummary(
                        id="proj-video-production",
                        name="Video production",
                        path=str(video_path),
                        icon="clapperboard",
                        accentToken="--accent-secondary",
                        providerHint="antigravity",
                        activeSessions=1,
                        gitBranch="main",
                        isSeededDemo=not video_path.exists(),
                    ).model_dump(),
                    ProjectSummary(
                        id="proj-0g",
                        name="0G",
                        path=str(zero_g_path),
                        icon="terminal",
                        accentToken="--accent-primary",
                        providerHint="antigravity",
                        activeSessions=1,
                        gitBranch="main",
                        isSeededDemo=False,
                    ).model_dump(),
                ]
                self.set_kv("seeded_projects", seeded_projects)

            if self.get_kv("macros") is None:
                self.set_kv(
                    "macros",
                    [MacroShortcut.model_validate(m).model_dump() for m in DEFAULT_MACROS],
                )

            sess_row = conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()
            if sess_row and sess_row["c"] == 0:
                now = time.time()
                scratch_root = Path(r"C:\Users\blagoslov333\.gemini\antigravity\scratch")
                demo_sess = SessionSummary(
                    id="sess-video-prod-main",
                    title="Scene timeline cut & FFmpeg render pipeline",
                    projectId="proj-video-production",
                    projectName="Video production",
                    provider="antigravity",
                    source="desktop_hook",
                    status="idle",
                    cwd=str(scratch_root / "Video production"),
                    stepIdx=2,
                    promptTokens=2840,
                    thoughtsTokens=620,
                    totalTokens=3460,
                    createdAt=now - 300,
                    updatedAt=now - 30,
                )
                self.upsert_session(demo_sess)
                self.add_timeline_step(
                    TimelineStep(
                        id="step-video-1",
                        sessionId=demo_sess.id,
                        stepIdx=1,
                        role="user",
                        content="Prepare the 4K storyboard render queue and normalize audio LUFS to -14.",
                        ts=now - 290,
                    )
                )
                self.add_timeline_step(
                    TimelineStep(
                        id="step-video-2",
                        sessionId=demo_sess.id,
                        stepIdx=2,
                        role="assistant",
                        content="Storyboard render queue validated. Audio normalization filterchain ready for batch execution.",
                        ts=now - 35,
                    )
                )

            audit_row = conn.execute("SELECT COUNT(*) AS c FROM audit_log").fetchone()
            if audit_row and audit_row["c"] == 0:
                self.append_audit("system", "db_initialized", {"wal": True, "path": str(self.db_path)})

    def close(self) -> None:
        """No-op as connections are cleanly closed after each atomic operation."""
        return None

    def _notify_waiters(self) -> None:
        for loop, ev in list(self._waiters):
            try:
                if not loop.is_closed():
                    loop.call_soon_threadsafe(ev.set)
            except RuntimeError:
                pass

    # --- Event Stream & Long-Poll / WebSocket Notifier ---

    def emit_event(
        self,
        event_type: str,
        payload: dict[str, Any],
        session_id: str | None = None,
        provider: str | None = None,
    ) -> StreamEnvelope:
        ts = time.time()
        payload_json = json.dumps(payload, ensure_ascii=False)
        with self._get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO events(ts, event_type, session_id, provider, payload_json) VALUES (?, ?, ?, ?, ?)",
                (ts, event_type, session_id, provider, payload_json),
            )
            seq = int(cur.lastrowid or 0)
        envelope = StreamEnvelope(
            seq=seq,
            ts=ts,
            eventType=event_type,
            sessionId=session_id,
            provider=provider,  # type: ignore[arg-type]
            payload=payload,
        )
        self._notify_waiters()
        return envelope

    def latest_seq(self) -> int:
        with self._get_conn() as conn:
            row = conn.execute("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events").fetchone()
            return int(row["max_seq"]) if row else 0

    def events_since(self, since_seq: int = 0, limit: int = 500) -> list[StreamEnvelope]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT seq, ts, event_type, session_id, provider, payload_json FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
                (int(since_seq), int(limit)),
            ).fetchall()
        out: list[StreamEnvelope] = []
        for r in rows:
            try:
                payload = json.loads(r["payload_json"])
            except Exception:
                payload = {}
            out.append(
                StreamEnvelope(
                    seq=int(r["seq"]),
                    ts=float(r["ts"]),
                    eventType=str(r["event_type"]),
                    sessionId=r["session_id"],
                    provider=r["provider"],
                    payload=payload if isinstance(payload, dict) else {"value": payload},
                )
            )
        return out

    async def wait_for_events(self, after_seq: int, timeout: float = 30.0) -> list[StreamEnvelope]:
        existing = self.events_since(after_seq)
        if existing:
            return existing
        loop = asyncio.get_running_loop()
        ev = asyncio.Event()
        waiter = (loop, ev)
        self._waiters.add(waiter)
        try:
            existing = self.events_since(after_seq)
            if existing:
                return existing
            try:
                await asyncio.wait_for(ev.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                return []
            return self.events_since(after_seq)
        finally:
            self._waiters.discard(waiter)

    # --- Sessions ---

    def upsert_session(self, session: SessionSummary | dict[str, Any]) -> SessionSummary:
        model = session if isinstance(session, SessionSummary) else SessionSummary.model_validate(session)
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO sessions(id, data_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at
                """,
                (model.id, model.model_dump_json(), float(model.updatedAt)),
            )
        return model

    def list_sessions(self, project_id: str | None = None) -> list[SessionSummary]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT data_json FROM sessions ORDER BY updated_at DESC"
            ).fetchall()
        sessions: list[SessionSummary] = []
        for r in rows:
            try:
                s = SessionSummary.model_validate_json(r["data_json"])
                if project_id is None or s.projectId == project_id:
                    sessions.append(s)
            except Exception:
                continue
        return sessions

    def get_session(self, session_id: str) -> SessionSummary | None:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT data_json FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        if not row:
            return None
        try:
            return SessionSummary.model_validate_json(row["data_json"])
        except Exception:
            return None

    # --- Timeline Steps ---

    def add_timeline_step(self, step: TimelineStep | dict[str, Any]) -> TimelineStep:
        model = step if isinstance(step, TimelineStep) else TimelineStep.model_validate(step)
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO timeline_steps(id, session_id, step_idx, data_json, ts)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    step_idx = excluded.step_idx,
                    data_json = excluded.data_json,
                    ts = excluded.ts
                """,
                (model.id, model.sessionId, int(model.stepIdx), model.model_dump_json(), float(model.ts)),
            )
        return model

    def get_timeline(self, session_id: str, limit: int = 500) -> list[TimelineStep]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT data_json FROM timeline_steps WHERE session_id = ? ORDER BY step_idx ASC, ts ASC LIMIT ?",
                (session_id, int(limit)),
            ).fetchall()
        out: list[TimelineStep] = []
        for r in rows:
            try:
                out.append(TimelineStep.model_validate_json(r["data_json"]))
            except Exception:
                continue
        return out

    # --- Approvals ---

    def upsert_approval(self, approval: ApprovalItem | dict[str, Any]) -> ApprovalItem:
        model = approval if isinstance(approval, ApprovalItem) else ApprovalItem.model_validate(approval)
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO approvals(id, session_id, status, data_json, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    data_json = excluded.data_json,
                    expires_at = excluded.expires_at
                """,
                (
                    model.id,
                    model.sessionId,
                    model.status,
                    model.model_dump_json(),
                    float(model.createdAt),
                    float(model.expiresAt),
                ),
            )
        return model

    def list_approvals(self, status: str | None = None) -> list[ApprovalItem]:
        with self._get_conn() as conn:
            if status:
                rows = conn.execute(
                    "SELECT data_json FROM approvals WHERE status = ? ORDER BY created_at DESC",
                    (status,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT data_json FROM approvals ORDER BY created_at DESC LIMIT 200"
                ).fetchall()
        out: list[ApprovalItem] = []
        for r in rows:
            try:
                out.append(ApprovalItem.model_validate_json(r["data_json"]))
            except Exception:
                continue
        return out

    def get_approval(self, approval_id: str) -> ApprovalItem | None:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT data_json FROM approvals WHERE id = ?", (approval_id,)
            ).fetchone()
        if not row:
            return None
        try:
            return ApprovalItem.model_validate_json(row["data_json"])
        except Exception:
            return None

    # --- Rules ---

    def list_rules(self) -> list[RuleEntry]:
        with self._get_conn() as conn:
            rows = conn.execute("SELECT data_json FROM rules").fetchall()
        now = time.time()
        out: list[RuleEntry] = []
        expired_ids: list[str] = []
        for r in rows:
            try:
                rule = RuleEntry.model_validate_json(r["data_json"])
                if rule.expiresAt is not None and rule.expiresAt < now:
                    expired_ids.append(rule.id)
                    continue
                out.append(rule)
            except Exception:
                continue
        if expired_ids:
            with self._get_conn() as conn:
                for rid in expired_ids:
                    conn.execute("DELETE FROM rules WHERE id = ?", (rid,))
        return out

    def upsert_rule(self, rule: RuleEntry | dict[str, Any]) -> RuleEntry:
        model = rule if isinstance(rule, RuleEntry) else RuleEntry.model_validate(rule)
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO rules(id, data_json)
                VALUES (?, ?)
                ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json
                """,
                (model.id, model.model_dump_json()),
            )
        return model

    def delete_rule(self, rule_id: str) -> bool:
        with self._get_conn() as conn:
            cur = conn.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
            return (cur.rowcount or 0) > 0

    # --- Steering Queue ---

    def queue_steering(
        self,
        session_id: str,
        message: str,
        client_msg_id: str | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        msg_id = client_msg_id or f"steer-{uuid.uuid4().hex[:12]}"
        with self._get_conn() as conn:
            existing = conn.execute(
                "SELECT id, session_id, message, client_msg_id, created_at, consumed FROM steering_queue WHERE client_msg_id = ?",
                (msg_id,),
            ).fetchone()
            if existing:
                return {
                    "id": int(existing["id"]),
                    "sessionId": existing["session_id"],
                    "message": existing["message"],
                    "clientMsgId": existing["client_msg_id"],
                    "createdAt": float(existing["created_at"]),
                    "consumed": bool(existing["consumed"]),
                    "deduped": True,
                }
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO steering_queue(session_id, message, client_msg_id, created_at, consumed)
                VALUES (?, ?, ?, ?, 0)
                """,
                (session_id, message, msg_id, now),
            )
            row_id = int(cur.lastrowid or 0)
        return {
            "id": row_id,
            "sessionId": session_id,
            "message": message,
            "clientMsgId": msg_id,
            "createdAt": now,
            "consumed": False,
            "deduped": False,
        }

    def pop_pending_steering(self, session_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute(
                """
                SELECT id, session_id, message, client_msg_id, created_at
                FROM steering_queue
                WHERE consumed = 0 AND (session_id = ? OR session_id = '*' OR session_id = 'default')
                ORDER BY id ASC
                """,
                (session_id,),
            ).fetchall()
            if not rows:
                return []
            ids = [int(r["id"]) for r in rows]
            placeholders = ",".join("?" for _ in ids)
            conn.execute(
                f"UPDATE steering_queue SET consumed = 1 WHERE id IN ({placeholders})",
                ids,
            )
        return [
            {
                "id": int(r["id"]),
                "sessionId": r["session_id"],
                "message": r["message"],
                "clientMsgId": r["client_msg_id"],
                "createdAt": float(r["created_at"]),
            }
            for r in rows
        ]

    # --- Mobile Tools ---

    def upsert_mobile_tool(self, tool: MobileToolSpec | dict[str, Any]) -> MobileToolSpec:
        model = tool if isinstance(tool, MobileToolSpec) else MobileToolSpec.model_validate(tool)
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO mobile_tools(id, name, data_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at
                """,
                (model.id, model.name, model.model_dump_json(), float(model.updatedAt)),
            )
        return model

    def list_mobile_tools(self) -> list[MobileToolSpec]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT data_json FROM mobile_tools ORDER BY updated_at ASC"
            ).fetchall()
        out: list[MobileToolSpec] = []
        for r in rows:
            try:
                out.append(MobileToolSpec.model_validate_json(r["data_json"]))
            except Exception:
                continue
        return out

    def get_mobile_tool_by_name(self, name: str) -> MobileToolSpec | None:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT data_json FROM mobile_tools WHERE name = ?", (name,)
            ).fetchone()
        if not row:
            return None
        try:
            return MobileToolSpec.model_validate_json(row["data_json"])
        except Exception:
            return None

    def get_mobile_tool(self, tool_id: str) -> MobileToolSpec | None:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT data_json FROM mobile_tools WHERE id = ? OR name = ?",
                (tool_id, tool_id),
            ).fetchone()
        if not row:
            return None
        try:
            return MobileToolSpec.model_validate_json(row["data_json"])
        except Exception:
            return None

    def delete_mobile_tool(self, tool_id: str) -> bool:
        with self._get_conn() as conn:
            cur = conn.execute(
                "DELETE FROM mobile_tools WHERE id = ? OR name = ?", (tool_id, tool_id)
            )
            return (cur.rowcount or 0) > 0

    # --- Push Subscriptions & WebAuthn Credentials ---

    def upsert_push_subscription(self, endpoint: str, data: dict[str, Any]) -> None:
        now = time.time()
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO push_subscriptions(endpoint, data_json, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET data_json = excluded.data_json
                """,
                (endpoint, json.dumps(data, ensure_ascii=False), now),
            )

    def list_push_subscriptions(self) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute("SELECT endpoint, data_json, created_at FROM push_subscriptions").fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                d = json.loads(r["data_json"])
                d["endpoint"] = r["endpoint"]
                out.append(d)
            except Exception:
                continue
        return out

    def upsert_webauthn_credential(self, cred_id: str, data: dict[str, Any]) -> None:
        now = time.time()
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO webauthn_credentials(cred_id, data_json, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(cred_id) DO UPDATE SET data_json = excluded.data_json
                """,
                (cred_id, json.dumps(data, ensure_ascii=False), now),
            )

    def list_webauthn_credentials(self) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute("SELECT cred_id, data_json, created_at FROM webauthn_credentials").fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                d = json.loads(r["data_json"])
                d["credId"] = r["cred_id"]
                out.append(d)
            except Exception:
                continue
        return out

    # --- SHA-256 Hash-Chained Audit Log ---

    @staticmethod
    def _compute_audit_hash(
        ts: float,
        actor: str,
        action: str,
        details_json: str,
        prev_hash: str,
    ) -> str:
        canonical = f"{ts:.6f}|{actor}|{action}|{details_json}|{prev_hash}"
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def append_audit(
        self,
        actor: str,
        action: str,
        details: dict[str, Any] | str | None = None,
    ) -> dict[str, Any]:
        ts = round(time.time(), 6)
        if details is None:
            details_obj: Any = {}
        elif isinstance(details, str):
            details_obj = {"message": details}
        else:
            details_obj = details
        details_json = json.dumps(details_obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        with self._get_conn() as conn:
            last_row = conn.execute(
                "SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1"
            ).fetchone()
            prev_hash = str(last_row["entry_hash"]) if last_row else "0" * 64
            entry_hash = self._compute_audit_hash(ts, actor, action, details_json, prev_hash)
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO audit_log(ts, actor, action, details_json, prev_hash, entry_hash)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (ts, actor, action, details_json, prev_hash, entry_hash),
            )
            row_id = int(cur.lastrowid or 0)
        return {
            "id": row_id,
            "ts": ts,
            "actor": actor,
            "action": action,
            "details": details_obj,
            "prevHash": prev_hash,
            "entryHash": entry_hash,
        }

    def verify_audit_chain(self) -> bool:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT id, ts, actor, action, details_json, prev_hash, entry_hash FROM audit_log ORDER BY id ASC"
            ).fetchall()
        expected_prev = "0" * 64
        for r in rows:
            if r["prev_hash"] != expected_prev:
                return False
            computed = self._compute_audit_hash(
                float(r["ts"]),
                str(r["actor"]),
                str(r["action"]),
                str(r["details_json"]),
                expected_prev,
            )
            if computed != r["entry_hash"]:
                return False
            expected_prev = str(r["entry_hash"])
        return True

    def list_audit_log(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT id, ts, actor, action, details_json, prev_hash, entry_hash FROM audit_log ORDER BY id DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                details = json.loads(r["details_json"])
            except Exception:
                details = {}
            out.append(
                {
                    "id": int(r["id"]),
                    "ts": float(r["ts"]),
                    "actor": r["actor"],
                    "action": r["action"],
                    "details": details,
                    "prevHash": r["prev_hash"],
                    "entryHash": r["entry_hash"],
                }
            )
        return out

    # --- Key-Value Store ---

    def get_kv(self, k: str, default: Any = None) -> Any:
        with self._get_conn() as conn:
            row = conn.execute("SELECT v_json FROM kv_store WHERE k = ?", (k,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["v_json"])
        except Exception:
            return default

    def set_kv(self, k: str, v: Any) -> None:
        now = time.time()
        v_json = json.dumps(v, ensure_ascii=False)
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO kv_store(k, v_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(k) DO UPDATE SET
                    v_json = excluded.v_json,
                    updated_at = excluded.updated_at
                """,
                (k, v_json, now),
            )
