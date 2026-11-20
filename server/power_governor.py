"""Windows 11 adaptive backpack power governor using Win32 ctypes APIs."""

from __future__ import annotations

import asyncio
import ctypes
import logging
import os
import subprocess
import threading
import time
import uuid
from ctypes import wintypes
from typing import Any, Callable

from server.contracts import PowerGear, PowerGearUpdateRequest

logger = logging.getLogger("0g.power_governor")

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000

# Win32 Power & Display constants
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
HWND_BROADCAST = 0xFFFF
WM_SYSCOMMAND = 0x0112
SC_MONITORPOWER = 0xF170
MONITOR_POWER_OFF = 2

# Windows 11 Power Overlay GUIDs
OVERLAY_POWER_SAVER = "961cc777-2547-4f9d-8174-7d8618157d7a"
OVERLAY_BALANCED = "00000000-0000-0000-0000-000000000000"
OVERLAY_HIGH_PERFORMANCE = "ded574b5-45a0-4f42-8737-46345c09c238"

# Gear -> (overlay_guid, proc_throttle_max_pct, perf_boost_mode)
_GEAR_PROFILES: dict[PowerGear, tuple[str, int, int]] = {
    "ultra_sip": (OVERLAY_POWER_SAVER, 60, 0),
    "low_battery_guard": (OVERLAY_POWER_SAVER, 50, 0),
    "balanced": (OVERLAY_BALANCED, 100, 1),
    "auto_turbo": (OVERLAY_HIGH_PERFORMANCE, 100, 2),
    "max_turbo": (OVERLAY_HIGH_PERFORMANCE, 100, 2),
}


class SYSTEM_POWER_STATUS(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", wintypes.BYTE),
        ("BatteryFlag", wintypes.BYTE),
        ("BatteryLifePercent", wintypes.BYTE),
        ("SystemStatusFlag", wintypes.BYTE),
        ("BatteryLifeTime", wintypes.DWORD),
        ("BatteryFullLifeTime", wintypes.DWORD),
    ]


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", wintypes.BYTE * 8),
    ]


def _guid_from_str(guid_str: str) -> GUID:
    return GUID.from_buffer_copy(uuid.UUID(guid_str).bytes_le)


def read_system_power_status() -> dict[str, Any]:
    """Read battery percentage, AC status, and remaining minutes via GetSystemPowerStatus."""
    if not IS_WINDOWS:
        return {
            "batteryPercent": None,
            "acPluggedIn": None,
            "batteryRemainingMin": None,
            "batterySaverActive": False,
        }

    status = SYSTEM_POWER_STATUS()
    try:
        ok = ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status))
    except Exception:
        ok = 0

    if not ok:
        return {
            "batteryPercent": None,
            "acPluggedIn": None,
            "batteryRemainingMin": None,
            "batterySaverActive": False,
        }

    ac_plugged: bool | None
    if status.ACLineStatus == 1:
        ac_plugged = True
    elif status.ACLineStatus == 0:
        ac_plugged = False
    else:
        ac_plugged = None

    no_battery = bool(status.BatteryFlag & 128)
    if no_battery or status.BatteryLifePercent == 255:
        battery_pct = None
    else:
        battery_pct = max(0, min(100, int(status.BatteryLifePercent)))

    if status.BatteryLifeTime == 0xFFFFFFFF or no_battery:
        remaining_min = None
    else:
        remaining_min = max(0, int(status.BatteryLifeTime // 60))

    return {
        "batteryPercent": battery_pct,
        "acPluggedIn": ac_plugged,
        "batteryRemainingMin": remaining_min,
        "batterySaverActive": bool(status.SystemStatusFlag & 1),
    }


class BackpackPowerGovernor:
    """Adaptive Windows 11 laptop power governor for backpack hotspot operation."""

    def __init__(
        self,
        cooldown_sec: float = 60.0,
        low_battery_threshold: int = 15,
        auto_governor_enabled: bool = True,
        on_low_battery: Callable[[dict[str, Any]], Any] | None = None,
        on_state_change: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self.cooldown_sec = max(5.0, float(cooldown_sec))
        self.low_battery_threshold = max(5, min(50, int(low_battery_threshold)))
        self.auto_governor_enabled = bool(auto_governor_enabled)
        self.auto_hibernate_at_threshold = False

        self.current_gear: PowerGear = "ultra_sip"
        self.manual_gear: PowerGear | None = None
        self.keep_awake_active = False
        self.display_off_requested = False

        self._active_jobs: set[str] = set()
        self._tunnel_active = False
        self._last_job_finished_at: float = 0.0
        self._last_transition_at: float = time.time()
        self._low_battery_alert_active = False
        self._hibernate_triggered = False

        self._on_low_battery = on_low_battery
        self._on_state_change = on_state_change
        self._task: asyncio.Task[None] | None = None
        self._stop_event: asyncio.Event | None = None

    def set_callbacks(
        self,
        on_low_battery: Callable[[dict[str, Any]], Any] | None = None,
        on_state_change: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        with self._lock:
            if on_low_battery is not None:
                self._on_low_battery = on_low_battery
            if on_state_change is not None:
                self._on_state_change = on_state_change

    def set_tunnel_active(self, active: bool) -> dict[str, Any]:
        """Update whether an outbound tunnel requires S0 network readiness."""
        with self._lock:
            self._tunnel_active = bool(active)
            self._sync_execution_state()
            return self.get_state()

    def notify_job_started(self, job_id: str) -> dict[str, Any]:
        """Mark an agent job/command active; immediately engages auto_turbo if auto-governor is on."""
        with self._lock:
            self._active_jobs.add(str(job_id))
            if self.auto_governor_enabled and self.manual_gear is None:
                if self.current_gear != "auto_turbo":
                    self._transition_gear("auto_turbo")
            self._sync_execution_state()
            state = self.get_state()
        self._emit_callback(self._on_state_change, state)
        return state

    def notify_job_finished(self, job_id: str) -> dict[str, Any]:
        """Mark an agent job/command finished; starts idle cooldown toward ultra_sip."""
        with self._lock:
            self._active_jobs.discard(str(job_id))
            if not self._active_jobs:
                self._last_job_finished_at = time.time()
            self._sync_execution_state()
            state = self.get_state()
        self._emit_callback(self._on_state_change, state)
        return state

    def apply_gear(self, request: PowerGearUpdateRequest | dict[str, Any]) -> dict[str, Any]:
        """Apply manual gear override, auto-governor toggle, display-off, or battery guard."""
        if isinstance(request, dict):
            req = PowerGearUpdateRequest(**request)
        else:
            req = request

        state_changed = False
        with self._lock:
            if req.autoGovernorEnabled is not None:
                self.auto_governor_enabled = bool(req.autoGovernorEnabled)
                if self.auto_governor_enabled and req.gear is None:
                    self.manual_gear = None
                state_changed = True

            if req.lowBatteryThreshold is not None:
                self.low_battery_threshold = max(5, min(50, int(req.lowBatteryThreshold)))
                state_changed = True

            if req.autoHibernateAtThreshold is not None:
                self.auto_hibernate_at_threshold = bool(req.autoHibernateAtThreshold)
                if not self.auto_hibernate_at_threshold:
                    self._hibernate_triggered = False
                state_changed = True

            if req.gear is not None:
                if req.gear == "auto_turbo" and req.autoGovernorEnabled is not False:
                    # Selecting Auto-Turbo enables automatic scaling unless explicitly disabled
                    self.manual_gear = None
                    self.auto_governor_enabled = True
                elif req.autoGovernorEnabled is True:
                    self.manual_gear = None
                    self.auto_governor_enabled = True
                else:
                    # Any explicit manual gear click (including Ultra-Sip, Balanced, Max Turbo,
                    # Low-Batt Guard) locks that gear and disables Auto-Governor so agent runs
                    # never flip it back behind the user's back.
                    self.manual_gear = req.gear
                    self.auto_governor_enabled = False
                if self.current_gear != req.gear:
                    self._transition_gear(req.gear)
                state_changed = True

            if req.displayOff is not None:
                self.display_off_requested = bool(req.displayOff)
                if self.display_off_requested:
                    self.turn_display_off()
                state_changed = True

            self._sync_execution_state()
            state = self.get_state()

        if state_changed:
            self._emit_callback(self._on_state_change, state)
        return state

    def turn_display_off(self) -> bool:
        """Explicitly power off the laptop panel via WM_SYSCOMMAND SC_MONITORPOWER."""
        if not IS_WINDOWS:
            return False
        try:
            ctypes.windll.user32.PostMessageW(
                HWND_BROADCAST,
                WM_SYSCOMMAND,
                SC_MONITORPOWER,
                MONITOR_POWER_OFF,
            )
            with self._lock:
                self.display_off_requested = True
            return True
        except Exception as exc:
            logger.warning("PostMessageW SC_MONITORPOWER failed: %s", exc)
            return False

    def lock_workstation(self) -> bool:
        """Explicitly lock the Windows session (ONLY for PANIC lock action)."""
        if not IS_WINDOWS:
            return False
        try:
            return bool(ctypes.windll.user32.LockWorkStation())
        except Exception as exc:
            logger.warning("LockWorkStation failed: %s", exc)
            return False

    def tick(self) -> dict[str, Any]:
        """Run one adaptive governor cycle: idle ultra_sip check, keep-awake, and battery guard."""
        low_battery_payload: dict[str, Any] | None = None
        state_changed = False

        with self._lock:
            power = read_system_power_status()
            battery_pct = power["batteryPercent"]
            ac_plugged = power["acPluggedIn"]
            now = time.time()

            # 1. Low-battery guard check (only when actively discharging on battery)
            on_battery = ac_plugged is False
            if battery_pct is not None and on_battery and battery_pct <= self.low_battery_threshold:
                if not self._low_battery_alert_active:
                    self._low_battery_alert_active = True
                    low_battery_payload = {
                        "batteryPercent": battery_pct,
                        "threshold": self.low_battery_threshold,
                        "batteryRemainingMin": power["batteryRemainingMin"],
                        "autoHibernateArmed": self.auto_hibernate_at_threshold,
                        "ts": now,
                    }
                if self.current_gear != "low_battery_guard":
                    self._transition_gear("low_battery_guard")
                    state_changed = True
                if self.auto_hibernate_at_threshold and not self._hibernate_triggered:
                    self._hibernate_triggered = True
                    self._trigger_hibernate()
            else:
                if self._low_battery_alert_active and (ac_plugged is True or (battery_pct is not None and battery_pct > self.low_battery_threshold + 2)):
                    self._low_battery_alert_active = False
                    self._hibernate_triggered = False

                # 2. Adaptive auto-governor idle/active transitions
                if self.auto_governor_enabled and self.manual_gear is None:
                    if self._active_jobs:
                        if self.current_gear != "auto_turbo":
                            self._transition_gear("auto_turbo")
                            state_changed = True
                    else:
                        idle_for = now - (self._last_job_finished_at or self._last_transition_at)
                        if idle_for >= self.cooldown_sec and self.current_gear != "ultra_sip":
                            self._transition_gear("ultra_sip")
                            state_changed = True

            self._sync_execution_state()
            state = self.get_state()

        if low_battery_payload is not None:
            self._emit_callback(self._on_low_battery, low_battery_payload)
        if state_changed:
            self._emit_callback(self._on_state_change, state)
        return state

    def get_state(self) -> dict[str, Any]:
        """Passive read of governor and Win32 battery state (never triggers lock/hibernate/display-off)."""
        with self._lock:
            power = read_system_power_status()
            return {
                "powerGear": self.current_gear,
                "autoGovernorEnabled": self.auto_governor_enabled,
                "manualGear": self.manual_gear,
                "keepAwakeActive": self.keep_awake_active,
                "displayOffRequested": self.display_off_requested,
                "lowBatteryThreshold": self.low_battery_threshold,
                "autoHibernateAtThreshold": self.auto_hibernate_at_threshold,
                "lowBatteryAlert": self._low_battery_alert_active,
                "activeJobsCount": len(self._active_jobs),
                "activeJobIds": sorted(self._active_jobs),
                "tunnelActive": self._tunnel_active,
                "cooldownSec": self.cooldown_sec,
                "lastTransitionAt": self._last_transition_at,
                "batteryPercent": power["batteryPercent"],
                "acPluggedIn": power["acPluggedIn"],
                "batteryRemainingMin": power["batteryRemainingMin"],
            }

    async def start(self, interval_sec: float = 10.0) -> None:
        """Start background adaptive governor loop."""
        if self._task is not None and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run_loop(max(2.0, float(interval_sec))))

    async def stop(self) -> None:
        """Stop background governor loop and release S0 execution state cleanly."""
        if self._stop_event is not None:
            self._stop_event.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        with self._lock:
            self._tunnel_active = False
            self._active_jobs.clear()
            self._sync_execution_state()

    async def _run_loop(self, interval_sec: float) -> None:
        assert self._stop_event is not None
        while not self._stop_event.is_set():
            try:
                await asyncio.to_thread(self.tick)
            except Exception as exc:
                logger.debug("Power governor tick error: %s", exc)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=interval_sec)
            except asyncio.TimeoutError:
                continue

    def _transition_gear(self, target_gear: PowerGear) -> None:
        self.current_gear = target_gear
        self._last_transition_at = time.time()
        self._apply_windows_power_profile(target_gear)

    def _apply_windows_power_profile(self, gear: PowerGear) -> None:
        if not IS_WINDOWS:
            return
        overlay_guid, throttle_pct, boost_mode = _GEAR_PROFILES[gear]

        # 1. Try Windows 11 Power Mode Overlay API (zero-registry-mutation, safe)
        try:
            powrprof = ctypes.windll.powrprof
            set_overlay = getattr(powrprof, "PowerSetActiveOverlayScheme", None)
            if set_overlay is not None:
                guid = _guid_from_str(overlay_guid)
                set_overlay(ctypes.byref(guid))
        except Exception as exc:
            logger.debug("PowerSetActiveOverlayScheme unavailable: %s", exc)

        # 2. Adjust processor max throttle & turbo boost via powercfg on current scheme
        commands = [
            ["powercfg", "/setdcvalueindex", "SCHEME_CURRENT", "SUB_PROCESSOR", "PROCTHROTTLEMAX", str(throttle_pct)],
            ["powercfg", "/setacvalueindex", "SCHEME_CURRENT", "SUB_PROCESSOR", "PROCTHROTTLEMAX", str(throttle_pct)],
            ["powercfg", "/setdcvalueindex", "SCHEME_CURRENT", "SUB_PROCESSOR", "PERFBOOSTMODE", str(boost_mode)],
            ["powercfg", "/setacvalueindex", "SCHEME_CURRENT", "SUB_PROCESSOR", "PERFBOOSTMODE", str(boost_mode)],
            ["powercfg", "/setactive", "SCHEME_CURRENT"],
        ]
        for cmd in commands:
            try:
                subprocess.run(
                    cmd,
                    capture_output=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=2.5,
                    creationflags=CREATE_NO_WINDOW,
                )
            except Exception:
                break

    def _sync_execution_state(self) -> None:
        should_keep_awake = bool(self._tunnel_active or self._active_jobs)
        if should_keep_awake == self.keep_awake_active:
            return
        self.keep_awake_active = should_keep_awake
        if not IS_WINDOWS:
            return
        try:
            flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED if should_keep_awake else ES_CONTINUOUS
            ctypes.windll.kernel32.SetThreadExecutionState(flags)
        except Exception as exc:
            logger.debug("SetThreadExecutionState failed: %s", exc)

    def _trigger_hibernate(self) -> bool:
        if not IS_WINDOWS:
            return False
        try:
            return bool(ctypes.windll.powrprof.SetSuspendState(True, False, False))
        except Exception as exc:
            logger.warning("SetSuspendState failed: %s", exc)
            return False

    def _emit_callback(self, cb: Callable[[dict[str, Any]], Any] | None, payload: dict[str, Any]) -> None:
        if cb is None:
            return
        try:
            res = cb(payload)
            if asyncio.iscoroutine(res):
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(res)
                except RuntimeError:
                    pass
        except Exception as exc:
            logger.debug("Governor callback failed: %s", exc)
