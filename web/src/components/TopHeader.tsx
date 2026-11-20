import React, { useState } from "react";
import {
  Battery,
  BatteryCharging,
  Lock,
  Palette,
  ShieldAlert,
  Unlock,
  Zap,
} from "lucide-react";
import { useZeroG } from "../lib/store";
import type { PowerGear, ThemePreset } from "../types/contracts";

const GEAR_LABEL: Record<PowerGear, string> = {
  ultra_sip: "Ultra-Sip",
  auto_turbo: "Auto-Turbo",
  balanced: "Balanced",
  max_turbo: "Max Turbo",
  low_battery_guard: "Low-Batt Guard",
};

const THEME_CYCLE: ThemePreset[] = ["obsidian", "outdoor", "wireframe"];
const THEME_LABEL: Record<ThemePreset, string> = {
  obsidian: "Obsidian",
  outdoor: "Outdoor",
  wireframe: "Wireframe",
};

export const TopHeader: React.FC = () => {
  const {
    theme,
    setTheme,
    wsStatus,
    lastSeq,
    hostGlance,
    panicLock,
    unlockHost,
    setActiveTab,
    isAuxPane,
  } = useZeroG();

  const [confirmPanic, setConfirmPanic] = useState(false);
  const [busy, setBusy] = useState(false);

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    setTheme(next);
  };

  const handlePanicClick = async () => {
    if (!confirmPanic) {
      setConfirmPanic(true);
      window.setTimeout(() => setConfirmPanic(false), 4000);
      return;
    }
    setBusy(true);
    try {
      await panicLock(false);
    } finally {
      setBusy(false);
      setConfirmPanic(false);
    }
  };

  const handleUnlock = async () => {
    setBusy(true);
    try {
      await unlockHost();
    } finally {
      setBusy(false);
    }
  };

  const wsDotColor =
    wsStatus === "connected"
      ? "var(--status-success)"
      : wsStatus === "offline"
        ? "var(--status-danger)"
        : "var(--status-warning)";

  const gear = hostGlance?.powerGear || "ultra_sip";
  const battery = hostGlance?.batteryPercent;
  const acPlugged = hostGlance?.acPluggedIn;
  const isLocked = Boolean(hostGlance?.hostLocked);

  return (
    <header
      className="sticky top-0 z-30 border-b"
      style={{
        backgroundColor: "var(--bg-surface)",
        borderColor: "var(--border-default)",
      }}
    >
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-2 px-3 py-2 min-h-[54px]">
        {/* Brand + WS Live Seq */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="font-display text-lg font-bold tracking-tight px-2 py-1 rounded-[var(--radius-inner)] border"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          >
            0G
          </span>
          <div
            className="inline-flex items-center gap-1.5 text-xs font-mono tabular-nums px-2 py-1 rounded-full border"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-muted)",
            }}
            title={`WebSocket: ${wsStatus}`}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: wsDotColor }}
              aria-hidden="true"
            />
            <span>WS #{lastSeq}</span>
          </div>
        </div>

        {/* Battery + Power Gear + Theme + PANIC */}
        <div className="flex items-center gap-1.5 shrink-0">
          {!isAuxPane && (
            <button
              type="button"
              onClick={() => setActiveTab("host")}
              className="btn-secondary !min-h-[44px] !px-2.5 text-xs tabular-nums"
              title="Open Backpack Power Governor"
              aria-label={`Battery ${battery ?? "--"} percent, Power gear ${GEAR_LABEL[gear]}`}
            >
              {acPlugged ? (
                <BatteryCharging
                  className="w-4 h-4 shrink-0"
                  style={{ color: "var(--status-success)" }}
                />
              ) : (
                <Battery
                  className="w-4 h-4 shrink-0"
                  style={{
                    color:
                      typeof battery === "number" && battery <= 20
                        ? "var(--status-warning)"
                        : "var(--text-primary)",
                  }}
                />
              )}
              <span className="font-mono font-semibold">
                {typeof battery === "number" ? `${battery}%` : "--"}
              </span>
              <span
                className="hidden sm:inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{
                  backgroundColor:
                    gear === "auto_turbo" || gear === "max_turbo"
                      ? "var(--status-info-bg)"
                      : "var(--status-success-bg)",
                  color:
                    gear === "auto_turbo" || gear === "max_turbo"
                      ? "var(--status-info-fg)"
                      : "var(--status-success-fg)",
                }}
              >
                <Zap className="w-3 h-3" />
                {GEAR_LABEL[gear]}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={cycleTheme}
            className="btn-secondary !min-h-[44px] !px-2.5 text-xs"
            aria-label={`Switch theme (current: ${THEME_LABEL[theme]})`}
            title={`Theme: ${THEME_LABEL[theme]} (tap to switch)`}
          >
            <Palette className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">{THEME_LABEL[theme]}</span>
          </button>

          {!isLocked ? (
            <button
              type="button"
              onClick={() => void handlePanicClick()}
              disabled={busy}
              className="btn-danger !min-h-[44px] !px-3 text-xs font-bold tracking-wide"
              aria-label={
                confirmPanic
                  ? "Confirm PANIC host lock"
                  : "PANIC lock host immediately"
              }
            >
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{confirmPanic ? "CONFIRM?" : "PANIC"}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleUnlock()}
              disabled={busy}
              className="btn-primary !min-h-[44px] !px-3 text-xs font-bold"
              aria-label="Unlock host"
            >
              <Unlock className="w-4 h-4 shrink-0" />
              <span>UNLOCK</span>
            </button>
          )}
        </div>
      </div>

      {/* Persistent HOST_LOCKED Banner */}
      {isLocked && (
        <div
          role="alert"
          className="border-t px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs font-medium"
          style={{
            backgroundColor: "var(--status-danger-bg)",
            borderColor: "var(--status-danger)",
            color: "var(--status-danger-fg)",
          }}
        >
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 shrink-0" />
            <span>
              <strong>HOST LOCKED</strong> — Hooks denying all writes &amp;
              active PTY jobs terminated.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleUnlock()}
            disabled={busy}
            className="btn-secondary !min-h-[44px] !py-1 !px-3 text-xs"
          >
            Reset Lock
          </button>
        </div>
      )}
    </header>
  );
};
