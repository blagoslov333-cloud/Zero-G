import React, { useEffect, useState } from "react";
import {
  Battery,
  BatteryCharging,
  Check,
  Clock,
  Lock,
  Palette,
  Shield,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  Unlock,
  Zap,
} from "lucide-react";
import { useZeroG } from "../lib/store";
import type { ApprovalItem, PowerGear, ThemePreset } from "../types/contracts";

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
    agentGateMode,
    setAgentGateMode,
    panicLock,
    unlockHost,
    setActiveTab,
    isAuxPane,
    approvals,
    decideApproval,
  } = useZeroG();

  const [confirmPanic, setConfirmPanic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState<number>(() => Date.now() / 1000);

  const pendingApprovals = approvals.filter((a) => a.status === "pending");

  useEffect(() => {
    if (pendingApprovals.length === 0) return;
    setNowSec(Date.now() / 1000);
    const timer = window.setInterval(() => {
      setNowSec(Date.now() / 1000);
    }, 250);
    return () => window.clearInterval(timer);
  }, [pendingApprovals.length]);

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

  const handleApproval = async (
    item: ApprovalItem,
    action: "approve" | "allow_30m" | "deny"
  ) => {
    setBusyApprovalId(item.id);
    try {
      await decideApproval(item.id, { action });
    } finally {
      setBusyApprovalId(null);
    }
  };

  const wsDotColor =
    wsStatus === "connected"
      ? "var(--status-success)"
      : wsStatus === "offline"
        ? "var(--status-danger)"
        : "var(--status-warning)";

  const wsLabel =
    wsStatus === "connected"
      ? "Live"
      : wsStatus === "offline"
        ? "Offline"
        : "Sync";

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
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-1.5 px-2.5 sm:px-4 py-2 min-h-[54px]">
        {/* Brand + Live Connection Pill */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="font-display text-xs sm:text-sm font-bold tracking-tight px-2 py-1 rounded-[var(--radius-inner)] border truncate"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          >
            Zero-G · Antigravity
          </span>
          <div
            className="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums px-2 py-1 rounded-full border shrink-0"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-muted)",
            }}
            title={`WebSocket: ${wsStatus} (#${lastSeq})`}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: wsDotColor }}
              aria-hidden="true"
            />
            <span>{wsLabel}</span>
            <span className="hidden sm:inline">#{lastSeq}</span>
          </div>
        </div>

        {/* Agent Permission Pill + Battery/Power + Theme + PANIC */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {!isAuxPane && (
            <>
              <button
                type="button"
                onClick={() =>
                  void setAgentGateMode(
                    agentGateMode === "agent_turbo"
                      ? "ask_on_phone"
                      : "agent_turbo"
                  )
                }
                className="btn-secondary !min-h-[44px] !min-w-[44px] !px-2 sm:!px-2.5 text-xs"
                title="Toggle Agent Permission Mode (Ask on Phone vs Agent Turbo)"
                aria-label={`Agent permission mode: ${
                  agentGateMode === "agent_turbo" ? "Agent Turbo" : "Ask on Phone"
                }`}
              >
                {agentGateMode === "agent_turbo" ? (
                  <Zap
                    className="w-4 h-4 shrink-0"
                    style={{ color: "var(--accent-secondary)" }}
                  />
                ) : (
                  <ShieldCheck
                    className="w-4 h-4 shrink-0"
                    style={{ color: "var(--accent-primary)" }}
                  />
                )}
                <span className="hidden md:inline font-semibold">
                  {agentGateMode === "agent_turbo"
                    ? "Agent Turbo"
                    : "Ask on Phone"}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("laptop")}
                className="btn-secondary !min-h-[44px] !min-w-[44px] !px-2 sm:!px-2.5 text-xs tabular-nums"
                title="Open Laptop Power & Settings"
                aria-label={`Laptop battery ${battery ?? "--"} percent, hardware gear ${GEAR_LABEL[gear]}`}
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
                <span className="font-mono font-semibold hidden sm:inline">
                  {typeof battery === "number" ? `${battery}%` : "--"}
                </span>
                <span
                  className="hidden lg:inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
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
            </>
          )}

          <button
            type="button"
            onClick={cycleTheme}
            className="btn-secondary !min-h-[44px] !min-w-[44px] !px-2 sm:!px-2.5 text-xs"
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
              className="btn-danger !min-h-[44px] !min-w-[44px] !px-2.5 sm:!px-3 text-xs font-bold tracking-wide"
              aria-label={
                confirmPanic
                  ? "Confirm PANIC host lock"
                  : "PANIC lock host immediately"
              }
            >
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">
                {confirmPanic ? "CONFIRM?" : "PANIC"}
              </span>
              {confirmPanic && <span className="sm:hidden">?</span>}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleUnlock()}
              disabled={busy}
              className="btn-primary !min-h-[44px] !min-w-[44px] !px-2.5 sm:!px-3 text-xs font-bold"
              aria-label="Unlock host"
            >
              <Unlock className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">UNLOCK</span>
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
          <div className="flex items-center gap-2 min-w-0">
            <Lock className="w-4 h-4 shrink-0" />
            <span className="break-words">
              <strong>HOST LOCKED</strong> — Hooks denying all writes &amp;
              active terminal jobs terminated.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleUnlock()}
            disabled={busy}
            className="btn-secondary !min-h-[44px] !py-1 !px-3 text-xs shrink-0"
          >
            Reset Lock
          </button>
        </div>
      )}

      {/* Global Inline Permission Request Banner (visible on ANY tab) */}
      {pendingApprovals.length > 0 && (
        <section
          aria-label="Pending Permission Request"
          role="region"
          className="border-t"
          style={{
            backgroundColor: "var(--status-warning-bg)",
            borderColor: "var(--status-warning)",
          }}
        >
          <div className="mx-auto max-w-4xl px-3 py-2.5 space-y-2">
            {pendingApprovals.map((item) => {
              const remaining = Math.max(0, item.expiresAt - nowSec);
              const isBusy = busyApprovalId === item.id;
              const previewText =
                item.commandPreview ||
                (typeof item.rawArgs?.command === "string"
                  ? item.rawArgs.command
                  : typeof item.rawArgs?.path === "string"
                    ? item.rawArgs.path
                    : JSON.stringify(item.rawArgs || {}));

              return (
                <div
                  key={item.id}
                  className="rounded-[var(--radius-inner)] border p-2.5 space-y-2"
                  style={{
                    backgroundColor: "var(--bg-surface)",
                    borderColor: "var(--status-warning)",
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Shield
                        className="w-4 h-4 shrink-0"
                        style={{ color: "var(--status-warning)" }}
                      />
                      <span className="text-xs font-semibold truncate">
                        Antigravity wants to run{" "}
                        <code
                          className="font-mono"
                          style={{ color: "var(--accent-secondary)" }}
                        >
                          {item.toolName}
                        </code>
                      </span>
                    </div>
                    <span
                      className="inline-flex items-center gap-1 font-mono text-xs font-bold tabular-nums shrink-0"
                      style={{
                        color:
                          remaining <= 6
                            ? "var(--status-danger)"
                            : "var(--status-warning)",
                      }}
                    >
                      <Clock className="w-3.5 h-3.5" />
                      {remaining.toFixed(0)}s
                    </span>
                  </div>

                  <div
                    className="rounded-[var(--radius-inner)] border px-2.5 py-1.5 font-mono text-xs break-all max-h-20 overflow-y-auto"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      borderColor: "var(--border-default)",
                      color: "var(--text-primary)",
                    }}
                  >
                    {previewText}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleApproval(item, "approve")}
                      className="btn-primary !min-h-[44px] !px-2 text-xs"
                    >
                      <Check className="w-4 h-4 shrink-0" />
                      <span>Approve</span>
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleApproval(item, "allow_30m")}
                      className="btn-secondary !min-h-[44px] !px-2 text-xs"
                    >
                      <Shield className="w-4 h-4 shrink-0" />
                      <span>Allow 30m</span>
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleApproval(item, "deny")}
                      className="btn-danger !min-h-[44px] !px-2 text-xs"
                    >
                      <ShieldBan className="w-4 h-4 shrink-0" />
                      <span>Deny</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </header>
  );
};
