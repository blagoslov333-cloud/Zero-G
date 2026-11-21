"""Windows login Auto-Start manager and automatic Web Push + Gmail (agentapi) tunnel link notifier."""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000

DEFAULT_NOTIFY_EMAIL = "blagoslov333@gmail.com"
LAUNCHER_FILENAME = "ZeroG-Antigravity-Remote.cmd"


def _default_windows_startup_dir() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def _resolve_background_python() -> str:
    exe = Path(sys.executable)
    if IS_WINDOWS and exe.name.lower() == "python.exe":
        pythonw = exe.with_name("pythonw.exe")
        if pythonw.is_file():
            return str(pythonw)
    return str(exe)


class StartupAndNotifyManager:
    """Manages Windows Startup .cmd launcher and automatic tunnel URL Push + Gmail notifications."""

    def __init__(
        self,
        repo_root: Path | str | None = None,
        startup_dir: Path | str | None = None,
    ) -> None:
        if repo_root is not None:
            self.repo_root = Path(repo_root).resolve()
        else:
            self.repo_root = Path(__file__).resolve().parent.parent

        self._explicit_startup_dir = startup_dir is not None
        if startup_dir is not None:
            self.startup_dir = Path(startup_dir)
        else:
            self.startup_dir = _default_windows_startup_dir()

        self.launcher_path = self.startup_dir / LAUNCHER_FILENAME

    def _allow_startup_write(self) -> bool:
        """Allow modifying the startup directory only when explicitly provided or outside pytest on Windows."""
        if self._explicit_startup_dir:
            return True
        return IS_WINDOWS and not bool(os.environ.get("PYTEST_CURRENT_TEST"))

    def _build_launcher_cmd(self) -> str:
        py_exe = _resolve_background_python()
        return (
            "@echo off\r\n"
            "setlocal\r\n"
            "set ZEROG_AUTO_TUNNEL=1\r\n"
            f'cd /d "{self.repo_root}"\r\n'
            f'start /b "" "{py_exe}" -m server.app\r\n'
        )

    def get_autostart_status(self, db: Any = None) -> dict[str, Any]:
        """Read current auto-start and tunnel email notification configuration."""
        saved: dict[str, Any] = {}
        last_url: str | None = None
        last_at: float | None = None
        if db is not None and hasattr(db, "get_kv"):
            raw_cfg = db.get_kv("autostart_config", {})
            if isinstance(raw_cfg, dict):
                saved = raw_cfg
            raw_url = db.get_kv("last_notified_public_url")
            if isinstance(raw_url, str) and raw_url.strip():
                last_url = raw_url.strip()
            raw_at = db.get_kv("last_notified_at")
            if isinstance(raw_at, (int, float)):
                last_at = float(raw_at)

        launcher_exists = self.launcher_path.is_file()
        enabled = bool(saved.get("enabled", launcher_exists))
        notify_email = (
            str(saved.get("notifyEmail") or DEFAULT_NOTIFY_EMAIL).strip() or DEFAULT_NOTIFY_EMAIL
        )
        auto_email = bool(saved.get("autoEmailOnTunnelChange", True))

        return {
            "ok": True,
            "enabled": enabled,
            "launcherInstalled": launcher_exists,
            "launcherPath": str(self.launcher_path),
            "notifyEmail": notify_email,
            "autoEmailOnTunnelChange": auto_email,
            "lastNotifiedUrl": last_url,
            "lastNotifiedAt": last_at,
        }

    def set_autostart(
        self,
        db: Any = None,
        enabled: bool = True,
        notify_email: str = DEFAULT_NOTIFY_EMAIL,
        auto_email: bool = True,
    ) -> dict[str, Any]:
        """Persist auto-start settings and install/remove the Windows Startup .cmd launcher."""
        clean_email = (notify_email or DEFAULT_NOTIFY_EMAIL).strip() or DEFAULT_NOTIFY_EMAIL
        cfg = {
            "enabled": bool(enabled),
            "notifyEmail": clean_email,
            "autoEmailOnTunnelChange": bool(auto_email),
            "updatedAt": time.time(),
        }
        if db is not None and hasattr(db, "set_kv"):
            db.set_kv("autostart_config", cfg)

        if self._allow_startup_write():
            try:
                if enabled:
                    self.startup_dir.mkdir(parents=True, exist_ok=True)
                    self.launcher_path.write_text(self._build_launcher_cmd(), encoding="utf-8")
                else:
                    if self.launcher_path.is_file():
                        self.launcher_path.unlink(missing_ok=True)
            except OSError:
                pass

        return self.get_autostart_status(db=db)

    async def _dispatch_agentapi_email(
        self,
        agy_bridge: Any,
        notify_email: str,
        public_url: str,
        pairing_url: str,
        code: str,
    ) -> bool:
        """Spawn a non-blocking agentapi subprocess instructing Antigravity to email the pairing link."""
        if agy_bridge is None or not hasattr(agy_bridge, "_resolve_agentapi_bin"):
            return False
        bin_path = agy_bridge._resolve_agentapi_bin()
        if not bin_path:
            return False

        subject = f"Zero-G Antigravity Remote Link ({public_url})"
        prompt = (
            f"Send an email to {notify_email} with subject '{subject}' containing the active Zero-G "
            f"Antigravity Mobile Remote link and pairing code:\n"
            f"- Public Tunnel URL: {public_url}\n"
            f"- 1-Tap Pairing Link: {pairing_url}\n"
            f"- 6-Digit Pairing Code: {code}\n\n"
            f"Use `gmail mutate send` to deliver the email to {notify_email}, or fall back to "
            f"`gmail mutate create-draft` if unattended send is blocked."
        )

        args = [
            "new-conversation",
            f"--title=Zero-G Tunnel Notification ({notify_email})",
            prompt,
        ]
        if bin_path.lower().endswith(".py"):
            cmd = [sys.executable, bin_path, *args]
        elif IS_WINDOWS and bin_path.lower().endswith((".bat", ".cmd")):
            cmd = ["cmd.exe", "/c", bin_path, *args]
        else:
            cmd = [bin_path, *args]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
            )
            asyncio.create_task(self._reap_process(proc))
            return True
        except Exception:
            return False

    @staticmethod
    async def _reap_process(proc: asyncio.subprocess.Process, timeout: float = 25.0) -> None:
        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    async def notify_tunnel_url(
        self,
        state: Any,
        public_url: str,
        pairing: dict[str, Any],
        force: bool = False,
    ) -> dict[str, Any]:
        """Notify phone via Web Push and email notifyEmail via agentapi when the public tunnel URL changes."""
        clean_url = (public_url or "").strip()
        low_url = clean_url.lower()
        is_localhost = (
            not clean_url
            or "127.0.0.1" in low_url
            or "localhost" in low_url
            or low_url.startswith("http://[::1]")
        )
        if is_localhost and not force:
            return {
                "ok": True,
                "skipped": True,
                "reason": "localhost_url",
                "publicUrl": clean_url,
            }

        db = getattr(state, "db", None)
        last_url = db.get_kv("last_notified_public_url") if (db is not None and hasattr(db, "get_kv")) else None
        if last_url == clean_url and not force:
            return {
                "ok": True,
                "skipped": True,
                "reason": "already_notified",
                "publicUrl": clean_url,
            }

        now = time.time()
        if db is not None and hasattr(db, "set_kv"):
            db.set_kv("last_notified_public_url", clean_url)
            db.set_kv("last_notified_at", now)

        pairing_dict = pairing if isinstance(pairing, dict) else {}
        pairing_url = str(
            pairing_dict.get("pairingUrl")
            or pairing_dict.get("pairUrl")
            or pairing_dict.get("url")
            or clean_url
        )
        code = str(pairing_dict.get("code") or "")

        push_res: dict[str, Any] = {"ok": False, "sent": 0}
        auth = getattr(state, "auth", None)
        if auth is not None and hasattr(auth, "send_push_notification"):
            try:
                push_res = auth.send_push_notification(
                    title="Zero-G Antigravity Tunnel Active",
                    body=f"Connect at {clean_url} (Code: {code})" if code else f"Connect at {clean_url}",
                    tag="0g-tunnel-url",
                    data={
                        "eventType": "tunnel.updated",
                        "url": pairing_url,
                        "ts": now,
                    },
                )
            except Exception as exc:
                push_res = {"ok": False, "sent": 0, "error": str(exc)}

        status = self.get_autostart_status(db=db)
        notify_email = status["notifyEmail"]
        auto_email = status["autoEmailOnTunnelChange"]

        email_queued = bool(auto_email or force)
        email_dispatched = False

        if db is not None and hasattr(db, "set_kv") and email_queued:
            db.set_kv(
                "last_email_notification",
                {
                    "to": notify_email,
                    "publicUrl": clean_url,
                    "pairingUrl": pairing_url,
                    "code": code,
                    "ts": now,
                },
            )

        in_pytest = bool(os.environ.get("PYTEST_CURRENT_TEST"))
        if email_queued and (not in_pytest or os.environ.get("ZEROG_RUN_AGENTAPI_IN_TEST") == "1"):
            email_dispatched = await self._dispatch_agentapi_email(
                getattr(state, "agy_bridge", None),
                notify_email=notify_email,
                public_url=clean_url,
                pairing_url=pairing_url,
                code=code,
            )

        return {
            "ok": True,
            "skipped": False,
            "publicUrl": clean_url,
            "pairingUrl": pairing_url,
            "code": code,
            "notifyEmail": notify_email,
            "emailQueued": email_queued,
            "emailDispatched": email_dispatched,
            "push": push_res,
            "notifiedAt": now,
        }
