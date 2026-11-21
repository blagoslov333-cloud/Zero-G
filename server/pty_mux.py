"""Windows Job-Object-bound PTY / PowerShell multiplexer for 0G remote terminal & macros."""

from __future__ import annotations

import asyncio
import ctypes
import logging
import os
import shutil
import time
import uuid
from collections import deque
from ctypes import wintypes
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger("0g.pty_mux")

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000


def _is_powershell(shell_path: str) -> bool:
    """Return True when shell_path refers to pwsh or powershell."""
    return os.path.basename(shell_path).lower().startswith(("pwsh", "powershell"))

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JobObjectExtendedLimitInformation = 9
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _Win32JobObject:
    """Wrapper around a Windows Job Object with KILL_ON_JOB_CLOSE."""

    def __init__(self) -> None:
        self.handle: int | None = None
        if not IS_WINDOWS:
            return
        self._create()

    def _create(self) -> None:
        if not IS_WINDOWS:
            return
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            logger.warning("CreateJobObjectW failed: err=%s", ctypes.get_last_error())
            return

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            logger.warning("SetInformationJobObject failed: err=%s", ctypes.get_last_error())
        self.handle = int(handle)

    def assign_pid(self, pid: int) -> bool:
        if not IS_WINDOWS or not self.handle or pid <= 0:
            return False
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = wintypes.HANDLE
        proc_handle = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, int(pid))
        if not proc_handle:
            return False
        try:
            ok = kernel32.AssignProcessToJobObject(wintypes.HANDLE(self.handle), proc_handle)
            return bool(ok)
        finally:
            kernel32.CloseHandle(proc_handle)

    def terminate_and_reset(self) -> bool:
        if not IS_WINDOWS or not self.handle:
            return False
        kernel32 = ctypes.windll.kernel32
        ok = bool(kernel32.TerminateJobObject(wintypes.HANDLE(self.handle), 1))
        kernel32.CloseHandle(wintypes.HANDLE(self.handle))
        self.handle = None
        self._create()
        return ok

    def close(self) -> None:
        if IS_WINDOWS and self.handle:
            ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(self.handle))
            self.handle = None


@dataclass
class _PtySession:
    session_id: str
    pid: int
    shell: str
    cwd: str
    backend: str  # "winpty" | "pipe"
    created_at: float
    process: Any = None
    winpty_proc: Any = None
    output_ring: deque[str] = field(default_factory=lambda: deque(maxlen=1500))
    reader_tasks: list[asyncio.Task[Any]] = field(default_factory=list)
    on_output: Callable[[str, str], Any] | None = None
    closed: bool = False


class JobObjectPtyMux:
    """Interactive PowerShell multiplexer bound to a Win32 Job Object for instant PANIC kill."""

    def __init__(self, max_buffer_lines: int = 1500) -> None:
        self.max_buffer_lines = max(100, int(max_buffer_lines))
        self._job = _Win32JobObject()
        self._sessions: dict[str, _PtySession] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def resolve_shell(preferred: str | None = None) -> str:
        if preferred and shutil.which(preferred):
            return shutil.which(preferred) or preferred
        candidates = (
            ("pwsh", "powershell.exe", "powershell")
            if IS_WINDOWS
            else ("bash", "sh", "zsh", "pwsh")
        )
        for candidate in candidates:
            found = shutil.which(candidate)
            if found:
                return found
        return "powershell.exe" if IS_WINDOWS else "/bin/sh"

    async def create_session(
        self,
        cwd: str | None = None,
        shell: str | None = None,
        cols: int = 100,
        rows: int = 30,
        on_output: Callable[[str, str], Any] | None = None,
    ) -> dict[str, Any]:
        """Spawn a new interactive PowerShell session bound to the Win32 Job Object."""
        resolved_cwd = cwd if (cwd and os.path.isdir(cwd)) else os.getcwd()
        resolved_shell = self.resolve_shell(shell)
        session_id = f"pty-{uuid.uuid4().hex[:10]}"

        # Try winpty.PtyProcess first if installed
        winpty_proc = None
        backend = "pipe"
        try:
            from winpty import PtyProcess  # type: ignore[import-not-found]

            winpty_proc = PtyProcess.spawn(
                [resolved_shell, "-NoLogo"],
                cwd=resolved_cwd,
                dimensions=(rows, cols),
            )
            backend = "winpty"
        except Exception:
            winpty_proc = None

        if winpty_proc is not None:
            pid = int(getattr(winpty_proc, "pid", 0) or 0)
            self._job.assign_pid(pid)
            sess = _PtySession(
                session_id=session_id,
                pid=pid,
                shell=resolved_shell,
                cwd=resolved_cwd,
                backend="winpty",
                created_at=time.time(),
                winpty_proc=winpty_proc,
                output_ring=deque(maxlen=self.max_buffer_lines),
                on_output=on_output,
            )
            sess.reader_tasks.append(asyncio.create_task(self._read_winpty_loop(sess)))
        else:
            args = (
                [resolved_shell, "-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"]
                if _is_powershell(resolved_shell)
                else [resolved_shell]
            )
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=resolved_cwd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
            )
            pid = int(proc.pid or 0)
            self._job.assign_pid(pid)
            sess = _PtySession(
                session_id=session_id,
                pid=pid,
                shell=resolved_shell,
                cwd=resolved_cwd,
                backend="pipe",
                created_at=time.time(),
                process=proc,
                output_ring=deque(maxlen=self.max_buffer_lines),
                on_output=on_output,
            )
            if proc.stdout is not None:
                sess.reader_tasks.append(asyncio.create_task(self._read_stream_loop(sess, proc.stdout, "stdout")))
            if proc.stderr is not None:
                sess.reader_tasks.append(asyncio.create_task(self._read_stream_loop(sess, proc.stderr, "stderr")))

        async with self._lock:
            self._sessions[session_id] = sess

        return self._serialize_session(sess)

    async def write_input(self, session_id: str, data: str) -> bool:
        """Write input string to an active PTY session."""
        async with self._lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            return False

        if sess.backend == "winpty" and sess.winpty_proc is not None:
            try:
                await asyncio.to_thread(sess.winpty_proc.write, data)
                return True
            except Exception as exc:
                logger.debug("winpty write failed for %s: %s", session_id, exc)
                return False

        proc = sess.process
        if proc is None or proc.stdin is None or proc.returncode is not None:
            return False

        payload = data.replace("\r\n", "\n").replace("\r", "\n")
        try:
            proc.stdin.write(payload.encode("utf-8", errors="replace"))
            await proc.stdin.drain()
            return True
        except Exception as exc:
            logger.debug("pipe write failed for %s: %s", session_id, exc)
            return False

    def get_output(self, session_id: str, tail_lines: int = 200) -> str:
        """Return recent buffered terminal output for a session."""
        sess = self._sessions.get(session_id)
        if sess is None:
            return ""
        lines = list(sess.output_ring)
        if tail_lines > 0:
            lines = lines[-tail_lines:]
        return "\n".join(lines)

    def list_sessions(self) -> list[dict[str, Any]]:
        """List active and recently closed PTY sessions."""
        return [self._serialize_session(sess) for sess in self._sessions.values()]

    async def close_session(self, session_id: str) -> bool:
        """Close a specific PTY session cleanly."""
        async with self._lock:
            sess = self._sessions.pop(session_id, None)
        if sess is None:
            return False
        await self._shutdown_session(sess)
        return True

    async def terminate_all(self) -> int:
        """PANIC kill: terminate the Win32 Job Object and all bound terminal processes instantaneously."""
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()

        count = len(sessions)
        self._job.terminate_and_reset()

        for sess in sessions:
            await self._shutdown_session(sess)
        return count

    async def run_macro(
        self,
        command: str,
        cwd: str | None = None,
        timeout_sec: float = 30.0,
    ) -> dict[str, Any]:
        """Run a One-Tap Preset Shortcut command bound to the Win32 Job Object."""
        resolved_cwd = cwd if (cwd and os.path.isdir(cwd)) else os.getcwd()
        shell_exe = self.resolve_shell()
        started = time.time()

        args = (
            [shell_exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
            if _is_powershell(shell_exe)
            else [shell_exe, "-c", command]
        )

        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=resolved_cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
        )
        if proc.pid:
            self._job.assign_pid(proc.pid)

        timed_out = False
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=max(1.0, float(timeout_sec)))
        except asyncio.TimeoutError:
            timed_out = True
            try:
                proc.kill()
            except Exception:
                pass
            stdout_b, stderr_b = await proc.communicate()

        return {
            "ok": (proc.returncode == 0) and not timed_out,
            "returncode": proc.returncode,
            "timedOut": timed_out,
            "stdout": stdout_b.decode("utf-8", errors="replace"),
            "stderr": stderr_b.decode("utf-8", errors="replace"),
            "cwd": resolved_cwd,
            "durationMs": int((time.time() - started) * 1000),
        }

    def close(self) -> None:
        for sess in list(self._sessions.values()):
            sess.closed = True
            for task in sess.reader_tasks:
                task.cancel()
            if sess.process is not None and sess.process.returncode is None:
                try:
                    sess.process.kill()
                except Exception:
                    pass
        self._sessions.clear()
        self._job.close()

    async def _read_stream_loop(self, sess: _PtySession, stream: asyncio.StreamReader, kind: str) -> None:
        try:
            while not sess.closed:
                chunk = await stream.read(4096)
                if not chunk:
                    break
                text = chunk.decode("utf-8", errors="replace")
                self._append_output(sess, text)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.debug("PTY stream reader (%s) error on %s: %s", kind, sess.session_id, exc)

    async def _read_winpty_loop(self, sess: _PtySession) -> None:
        proc = sess.winpty_proc
        try:
            while not sess.closed and proc is not None and proc.isalive():
                chunk = await asyncio.to_thread(proc.read, 4096)
                if chunk:
                    self._append_output(sess, str(chunk))
                else:
                    await asyncio.sleep(0.03)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.debug("winpty reader error on %s: %s", sess.session_id, exc)

    def _append_output(self, sess: _PtySession, text: str) -> None:
        for line in text.replace("\r\n", "\n").splitlines():
            sess.output_ring.append(line)
        if sess.on_output is not None:
            try:
                res = sess.on_output(sess.session_id, text)
                if asyncio.iscoroutine(res):
                    asyncio.get_running_loop().create_task(res)
            except Exception:
                pass

    async def _shutdown_session(self, sess: _PtySession) -> None:
        sess.closed = True
        for task in sess.reader_tasks:
            task.cancel()
        if sess.reader_tasks:
            await asyncio.gather(*sess.reader_tasks, return_exceptions=True)
        if sess.winpty_proc is not None:
            try:
                await asyncio.to_thread(sess.winpty_proc.terminate, True)
            except Exception:
                pass
        if sess.process is not None:
            if sess.process.stdin is not None:
                try:
                    sess.process.stdin.close()
                except Exception:
                    pass
            if sess.process.returncode is None:
                try:
                    sess.process.kill()
                    await asyncio.wait_for(sess.process.wait(), timeout=2.0)
                except Exception:
                    pass

    def _serialize_session(self, sess: _PtySession) -> dict[str, Any]:
        alive = False
        if not sess.closed:
            if sess.backend == "winpty" and sess.winpty_proc is not None:
                alive = bool(sess.winpty_proc.isalive())
            elif sess.process is not None:
                alive = sess.process.returncode is None
        return {
            "sessionId": sess.session_id,
            "pid": sess.pid,
            "shell": os.path.basename(sess.shell),
            "cwd": sess.cwd,
            "backend": sess.backend,
            "alive": alive,
            "createdAt": sess.created_at,
            "bufferLines": len(sess.output_ring),
        }
