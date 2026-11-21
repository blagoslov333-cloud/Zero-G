"""Zero-psutil Windows 11 host telemetry collector using Win32 ctypes APIs."""

from __future__ import annotations

import asyncio
import csv
import ctypes
import io
import os
import platform
import re
import shutil
import socket
import subprocess
import time
from ctypes import wintypes
from typing import Any

from server.contracts import HostGlanceSnapshot
from server.power_governor import BackpackPowerGovernor, read_system_power_status

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000

DEV_PORT_LABELS: dict[int, str] = {
    3000: "Web Dev (3000)",
    3001: "Web Dev (3001)",
    4173: "Vite Preview",
    5173: "Vite Dev",
    5174: "Vite Dev (Alt)",
    8000: "API Server",
    8080: "HTTP Proxy/Dev",
    8790: "0G Bridge Daemon",
    8888: "Jupyter / Dev",
    9000: "Dev Service",
}

AGENT_PROCESS_KEYWORDS = (
    "python",
    "node",
    "claude",
    "codex",
    "grok",
    "agy",
    "antigravity",
    "cloudflared",
    "tailscale",
)


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", wintypes.DWORD),
        ("dwMemoryLoad", wintypes.DWORD),
        ("ullTotalPhys", ctypes.c_uint64),
        ("ullAvailPhys", ctypes.c_uint64),
        ("ullTotalPageFile", ctypes.c_uint64),
        ("ullAvailPageFile", ctypes.c_uint64),
        ("ullTotalVirtual", ctypes.c_uint64),
        ("ullAvailVirtual", ctypes.c_uint64),
        ("ullAvailExtendedVirtual", ctypes.c_uint64),
    ]


class FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", wintypes.DWORD),
        ("dwHighDateTime", wintypes.DWORD),
    ]


def _filetime_to_int(ft: FILETIME) -> int:
    return (int(ft.dwHighDateTime) << 32) | int(ft.dwLowDateTime)


def _read_system_times() -> tuple[int, int, int] | None:
    if not IS_WINDOWS:
        return None
    idle = FILETIME()
    kernel = FILETIME()
    user = FILETIME()
    try:
        ok = ctypes.windll.kernel32.GetSystemTimes(
            ctypes.byref(idle),
            ctypes.byref(kernel),
            ctypes.byref(user),
        )
    except Exception:
        return None
    if not ok:
        return None
    return (
        _filetime_to_int(idle),
        _filetime_to_int(kernel),
        _filetime_to_int(user),
    )


def _parse_proc_meminfo(text: str) -> tuple[int, int]:
    """Parse /proc/meminfo kB values into (used_mb, total_mb)."""
    values_kb: dict[str, int] = {}
    for raw_line in text.splitlines():
        if ":" not in raw_line:
            continue
        key, rest = raw_line.split(":", 1)
        parts = rest.strip().split()
        if not parts:
            continue
        try:
            values_kb[key.strip()] = int(parts[0])
        except ValueError:
            continue

    total_kb = values_kb.get("MemTotal", 0)
    if total_kb <= 0:
        return 0, 0

    if "MemAvailable" in values_kb:
        avail_kb = values_kb["MemAvailable"]
    else:
        avail_kb = (
            values_kb.get("MemFree", 0)
            + values_kb.get("Buffers", 0)
            + values_kb.get("Cached", 0)
        )

    total_mb = total_kb // 1024
    if total_mb <= 0:
        return 0, 0
    avail_mb = max(0, avail_kb // 1024)
    return max(0, total_mb - avail_mb), total_mb


def _read_memory_mb() -> tuple[int, int]:
    if IS_WINDOWS:
        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        try:
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                total_mb = int(stat.ullTotalPhys // (1024 * 1024))
                avail_mb = int(stat.ullAvailPhys // (1024 * 1024))
                return max(0, total_mb - avail_mb), total_mb
        except Exception:
            pass

    try:
        with open("/proc/meminfo", "r", encoding="utf-8", errors="replace") as f:
            used_mb, total_mb = _parse_proc_meminfo(f.read())
        if total_mb > 0:
            return used_mb, total_mb
    except Exception:
        pass

    if hasattr(os, "sysconf"):
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            if isinstance(pages, int) and isinstance(page_size, int) and pages > 0 and page_size > 0:
                total_mb = int((pages * page_size) // (1024 * 1024))
                if total_mb > 0:
                    return 0, total_mb
        except Exception:
            pass

    try:
        import psutil  # type: ignore[import-not-found]

        vm = psutil.virtual_memory()
        return int(vm.used // (1024 * 1024)), int(vm.total // (1024 * 1024))
    except Exception:
        return 0, 0


def _read_gpu_stats() -> dict[str, Any]:
    empty = {
        "gpuName": None,
        "gpuLoadPercent": None,
        "vramUsedMb": None,
        "vramTotalMb": None,
    }
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return empty
    try:
        proc = subprocess.run(
            [
                nvidia_smi,
                "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=1.5,
            creationflags=CREATE_NO_WINDOW if IS_WINDOWS else 0,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return empty
        first_line = proc.stdout.strip().splitlines()[0]
        parts = [p.strip() for p in first_line.split(",")]
        if len(parts) < 4:
            return empty

        def _parse_float(val: str) -> float | None:
            try:
                return float(val)
            except ValueError:
                return None

        def _parse_int(val: str) -> int | None:
            try:
                return int(float(val))
            except ValueError:
                return None

        return {
            "gpuName": parts[0] or None,
            "gpuLoadPercent": _parse_float(parts[1]),
            "vramUsedMb": _parse_int(parts[2]),
            "vramTotalMb": _parse_int(parts[3]),
        }
    except Exception:
        return empty


def _parse_host_port(addr_token: str) -> tuple[str, int] | None:
    addr = addr_token.strip()
    if addr.startswith("["):
        match = re.match(r"^\[([^\]]+)\]:(\d+)$", addr)
        if not match:
            return None
        return match.group(1), int(match.group(2))
    if ":" not in addr:
        return None
    host, _, port_str = addr.rpartition(":")
    if not port_str.isdigit():
        return None
    return host, int(port_str)


def _read_listening_ports() -> list[dict[str, Any]]:
    if not IS_WINDOWS:
        return []
    try:
        proc = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=2.0,
            creationflags=CREATE_NO_WINDOW,
        )
        if proc.returncode != 0:
            return []
    except Exception:
        return []

    seen: set[tuple[int, int]] = set()
    ports: list[dict[str, Any]] = []
    for raw_line in proc.stdout.splitlines():
        line = raw_line.strip()
        if not line.startswith("TCP"):
            continue
        cols = line.split()
        if len(cols) < 5:
            continue
        local_addr, state, pid_str = cols[1], cols[3], cols[4]
        if state.upper() != "LISTENING":
            continue
        parsed = _parse_host_port(local_addr)
        if not parsed:
            continue
        host, port = parsed
        if host not in ("127.0.0.1", "0.0.0.0", "::1", "::"):
            continue
        try:
            pid = int(pid_str)
        except ValueError:
            pid = 0
        key = (port, pid)
        if key in seen:
            continue
        seen.add(key)
        is_dev = port in DEV_PORT_LABELS or (3000 <= port <= 9999 and port not in (5040, 7680))
        ports.append(
            {
                "port": port,
                "address": host,
                "pid": pid,
                "isDevPort": is_dev,
                "label": DEV_PORT_LABELS.get(port),
            }
        )

    ports.sort(key=lambda item: (not item["isDevPort"], item["port"]))
    return ports[:32]


def _parse_tasklist_mem_mb(mem_str: str) -> float:
    digits = re.sub(r"[^\d]", "", mem_str or "")
    if not digits:
        return 0.0
    kb = int(digits)
    return round(kb / 1024.0, 1)


def _read_active_agents() -> list[dict[str, Any]]:
    if not IS_WINDOWS:
        return []
    try:
        proc = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=2.0,
            creationflags=CREATE_NO_WINDOW,
        )
        if proc.returncode != 0:
            return []
    except Exception:
        return []

    agents: list[dict[str, Any]] = []
    reader = csv.reader(io.StringIO(proc.stdout))
    for row in reader:
        if len(row) < 5:
            continue
        image_name = row[0].strip()
        lower_name = image_name.lower()
        if not any(kw in lower_name for kw in AGENT_PROCESS_KEYWORDS):
            continue
        try:
            pid = int(row[1].strip())
        except ValueError:
            continue
        agents.append(
            {
                "name": image_name,
                "pid": pid,
                "sessionName": row[2].strip(),
                "memoryMb": _parse_tasklist_mem_mb(row[4]),
            }
        )
    agents.sort(key=lambda item: item["memoryMb"], reverse=True)
    return agents[:40]


class HostTelemetry:
    """Zero-psutil Windows host telemetry collector producing HostGlanceSnapshot."""

    def __init__(
        self,
        power_governor: BackpackPowerGovernor | None = None,
        drive_path: str | None = None,
    ) -> None:
        self.power_governor = power_governor
        if drive_path:
            self.drive_path = drive_path
        else:
            drive = os.path.splitdrive(os.getcwd())[0]
            self.drive_path = f"{drive}\\" if drive else ("C:\\" if IS_WINDOWS else "/")

        self._prev_times: tuple[int, int, int] | None = _read_system_times()
        self._last_cpu_percent: float = 0.0
        self._hostname = socket.gethostname()
        self._os_version = f"{platform.system()} {platform.release()}"

    def _read_cpu_percent(self) -> float:
        current = _read_system_times()
        if current is not None:
            if self._prev_times is None:
                self._prev_times = current
                time.sleep(0.05)
                current = _read_system_times() or current
            idle0, kernel0, user0 = self._prev_times
            idle1, kernel1, user1 = current
            d_idle = max(0, idle1 - idle0)
            d_kernel = max(0, kernel1 - kernel0)
            d_user = max(0, user1 - user0)
            total = d_kernel + d_user
            if total > 0:
                self._prev_times = current
                busy = max(0, total - d_idle)
                self._last_cpu_percent = round(min(100.0, (busy / total) * 100.0), 1)
            return self._last_cpu_percent

        try:
            import psutil  # type: ignore[import-not-found]

            self._last_cpu_percent = float(psutil.cpu_percent(interval=None))
            return self._last_cpu_percent
        except Exception:
            return self._last_cpu_percent

    def snapshot(self, host_locked: bool = False) -> HostGlanceSnapshot:
        """Collect synchronous host telemetry snapshot (safe passive read)."""
        cpu_pct = self._read_cpu_percent()
        ram_used_mb, ram_total_mb = _read_memory_mb()

        try:
            disk = shutil.disk_usage(self.drive_path)
            disk_free_gb = round(disk.free / (1024**3), 2)
            disk_total_gb = round(disk.total / (1024**3), 2)
        except Exception:
            disk_free_gb = 0.0
            disk_total_gb = 0.0

        gpu = _read_gpu_stats()
        ports = _read_listening_ports()
        agents = _read_active_agents()

        if self.power_governor is not None:
            gov_state = self.power_governor.get_state()
        else:
            power = read_system_power_status()
            gov_state = {
                "batteryPercent": power["batteryPercent"],
                "acPluggedIn": power["acPluggedIn"],
                "batteryRemainingMin": power["batteryRemainingMin"],
                "powerGear": "ultra_sip",
                "autoGovernorEnabled": True,
                "keepAwakeActive": False,
                "displayOffRequested": False,
                "lowBatteryThreshold": 15,
            }

        return HostGlanceSnapshot(
            hostname=self._hostname,
            osVersion=self._os_version,
            cpuPercent=cpu_pct,
            ramUsedMb=ram_used_mb,
            ramTotalMb=ram_total_mb,
            diskFreeGb=disk_free_gb,
            diskTotalGb=disk_total_gb,
            batteryPercent=gov_state.get("batteryPercent"),
            acPluggedIn=gov_state.get("acPluggedIn"),
            batteryRemainingMin=gov_state.get("batteryRemainingMin"),
            gpuName=gpu["gpuName"],
            gpuLoadPercent=gpu["gpuLoadPercent"],
            vramUsedMb=gpu["vramUsedMb"],
            vramTotalMb=gpu["vramTotalMb"],
            listeningPorts=ports,
            activeAgents=agents,
            powerGear=gov_state.get("powerGear", "ultra_sip"),
            autoGovernorEnabled=bool(gov_state.get("autoGovernorEnabled", True)),
            keepAwakeActive=bool(gov_state.get("keepAwakeActive", False)),
            displayOffRequested=bool(gov_state.get("displayOffRequested", False)),
            lowBatteryThreshold=int(gov_state.get("lowBatteryThreshold", 15)),
            hostLocked=bool(host_locked),
            ts=time.time(),
        )

    async def asnapshot(self, host_locked: bool = False) -> HostGlanceSnapshot:
        """Async wrapper running subprocess/WMI-free telemetry off the event loop."""
        return await asyncio.to_thread(self.snapshot, host_locked)
