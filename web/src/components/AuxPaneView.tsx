import React, { useState } from "react";
import {
  Battery,
  BatteryCharging,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Lock,
  MonitorOff,
  Radio,
  ShieldAlert,
  Smartphone,
  Unlock,
  Wrench,
  Zap,
} from "lucide-react";
import { useZeroG } from "../lib/store";
import type { PowerGear, TunnelBackend } from "../types/contracts";
import { QrSvg } from "./QrSvg";

const GEAR_OPTIONS: Array<{ id: PowerGear; label: string }> = [
  { id: "ultra_sip", label: "Ultra-Sip" },
  { id: "auto_turbo", label: "Auto-Turbo" },
  { id: "balanced", label: "Balanced" },
];

export const AuxPaneView: React.FC = () => {
  const {
    hostGlance,
    tunnelStatus,
    startTunnel,
    stopTunnel,
    pairingCode,
    generatePairingCode,
    approvals,
    mobileTools,
    updatePowerGear,
    panicLock,
    unlockHost,
    apiError,
    refreshAll,
  } = useZeroG();

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [busyTunnel, setBusyTunnel] = useState(false);
  const [busyCode, setBusyCode] = useState(false);

  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const publicUrl =
    tunnelStatus?.publicUrl || tunnelStatus?.localUrl || "http://127.0.0.1:8790";
  const qrTarget =
    pairingCode?.pairUrl ||
    (pairingCode?.code ? `${publicUrl}/?pair=${pairingCode.code}` : publicUrl);

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleStartTunnel = async (backend: TunnelBackend) => {
    setBusyTunnel(true);
    try {
      await startTunnel(backend);
    } finally {
      setBusyTunnel(false);
    }
  };

  const handleGenerateCode = async () => {
    setBusyCode(true);
    try {
      await generatePairingCode();
    } finally {
      setBusyCode(false);
    }
  };

  const isLocked = Boolean(hostGlance?.hostLocked);

  return (
    <main className="mx-auto w-full max-w-[420px] px-3 py-3 space-y-3">
      {apiError && (
        <div
          role="alert"
          className="surface-card p-3 flex items-center justify-between gap-2 text-xs"
          style={{
            borderColor: "var(--status-danger)",
            backgroundColor: "var(--status-danger-bg)",
            color: "var(--status-danger-fg)",
          }}
        >
          <span className="truncate">{apiError}</span>
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="btn-secondary !min-h-[36px] !px-2.5 text-xs shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* 1. Tunnel & QR Pairing Card */}
      <section className="surface-card p-3.5 space-y-3" aria-label="Tunnel & QR Pairing">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Radio
              className="w-4 h-4"
              style={{
                color:
                  tunnelStatus?.status === "running"
                    ? "var(--status-success)"
                    : "var(--accent-secondary)",
              }}
            />
            <h2 className="font-display text-sm font-bold">
              Tunnel &amp; Phone Pairing
            </h2>
          </div>
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-mono uppercase border"
            style={{
              borderColor: "var(--border-default)",
              backgroundColor: "var(--bg-subtle)",
              color:
                tunnelStatus?.status === "running"
                  ? "var(--status-success)"
                  : "var(--text-muted)",
            }}
          >
            {tunnelStatus?.backend || "local"} · {tunnelStatus?.status || "stopped"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <code
            className="flex-1 min-w-0 truncate rounded-[var(--radius-inner)] border px-2.5 py-2 text-xs font-mono"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--accent-secondary)",
            }}
          >
            {publicUrl}
          </code>
          <button
            type="button"
            onClick={() => void handleCopyUrl()}
            className="btn-secondary !px-3 shrink-0"
            aria-label="Copy tunnel URL"
          >
            {copiedUrl ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>

        <div className="flex items-center gap-3">
          <QrSvg
            value={qrTarget}
            svgHtml={pairingCode?.qrSvg || tunnelStatus?.qrSvg}
            size={112}
            label="0G Mobile Pairing QR"
          />
          <div className="flex-1 min-w-0 space-y-2">
            <button
              type="button"
              onClick={() => void handleGenerateCode()}
              disabled={busyCode}
              className="btn-primary w-full text-xs"
            >
              <KeyRound className="w-4 h-4" />
              {busyCode ? "Generating..." : "New 6-Digit Code"}
            </button>
            {pairingCode?.code ? (
              <div
                className="surface-subtle px-3 py-2 text-center font-mono text-xl font-bold tracking-[0.22em] tabular-nums"
                style={{ color: "var(--accent-primary)" }}
              >
                {pairingCode.code}
              </div>
            ) : (
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Scan QR or generate a 6-digit code to pair your phone.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            disabled={busyTunnel}
            onClick={() => void handleStartTunnel("cloudflare")}
            className="btn-secondary !px-2 text-xs"
          >
            Cloudflare
          </button>
          <button
            type="button"
            disabled={busyTunnel}
            onClick={() => void handleStartTunnel("tailscale")}
            className="btn-secondary !px-2 text-xs"
          >
            Tailscale
          </button>
          <button
            type="button"
            disabled={busyTunnel}
            onClick={() => void stopTunnel()}
            className="btn-secondary !px-2 text-xs"
          >
            Stop
          </button>
        </div>

        {tunnelStatus?.installHint && tunnelStatus.status === "missing_binary" && (
          <p className="text-[11px] font-mono break-all" style={{ color: "var(--status-warning)" }}>
            Install: {tunnelStatus.installHint}
          </p>
        )}
      </section>

      {/* 2. Backpack Power Governor Card */}
      <section className="surface-card p-3.5 space-y-2.5" aria-label="Backpack Power Governor">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {hostGlance?.acPluggedIn ? (
              <BatteryCharging className="w-4 h-4" style={{ color: "var(--status-success)" }} />
            ) : (
              <Battery className="w-4 h-4" style={{ color: "var(--status-warning)" }} />
            )}
            <h2 className="font-display text-sm font-bold">Backpack Power Governor</h2>
          </div>
          <span className="font-mono text-xs tabular-nums font-semibold">
            {hostGlance?.batteryPercent ?? "--"}% ·{" "}
            {hostGlance?.acPluggedIn ? "AC" : "DC"}
          </span>
        </div>

        <div className="flex items-center justify-between text-xs" style={{ color: "var(--text-muted)" }}>
          <span>
            Mode:{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              {hostGlance?.powerGear || "ultra_sip"}
            </strong>
          </span>
          <span>
            Keep-Awake:{" "}
            <strong style={{ color: "var(--accent-primary)" }}>
              {hostGlance?.keepAwakeActive ? "S0 Ready" : "Idle"}
            </strong>
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {GEAR_OPTIONS.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => void updatePowerGear({ gear: g.id })}
              className={
                hostGlance?.powerGear === g.id ? "btn-primary !px-2 text-xs" : "btn-secondary !px-2 text-xs"
              }
            >
              <Zap className="w-3.5 h-3.5" />
              {g.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void updatePowerGear({ displayOff: true })}
          className="btn-secondary w-full text-xs"
        >
          <MonitorOff className="w-4 h-4" />
          Turn Laptop Display Off (Backpack Safe)
        </button>
      </section>

      {/* 3. Pending Approvals & Mobile Tools Summary */}
      <section className="surface-card p-3.5 grid grid-cols-2 gap-2.5">
        <a
          href="/?tab=inbox"
          target="_blank"
          rel="noreferrer"
          className="surface-subtle p-3 flex flex-col justify-between gap-1 no-underline"
          style={{ color: "var(--text-primary)" }}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Pending Holds
            </span>
            <ExternalLink className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
          </div>
          <div
            className="font-display text-2xl font-bold tabular-nums"
            style={{
              color:
                pendingApprovals.length > 0
                  ? "var(--status-warning)"
                  : "var(--text-primary)",
            }}
          >
            {pendingApprovals.length}
          </div>
        </a>

        <a
          href="/?tab=tools"
          target="_blank"
          rel="noreferrer"
          className="surface-subtle p-3 flex flex-col justify-between gap-1 no-underline"
          style={{ color: "var(--text-primary)" }}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Phone MCP Tools
            </span>
            <Wrench className="w-3.5 h-3.5" style={{ color: "var(--accent-secondary)" }} />
          </div>
          <div className="font-display text-2xl font-bold tabular-nums flex items-center gap-1.5">
            <Smartphone className="w-4 h-4" style={{ color: "var(--accent-primary)" }} />
            {mobileTools.filter((t) => t.enabled).length}
          </div>
        </a>
      </section>

      {/* 4. PANIC Host Lock Switch */}
      <section className="surface-card p-3.5">
        {!isLocked ? (
          <button
            type="button"
            onClick={() => void panicLock(false)}
            className="btn-danger w-full font-bold"
          >
            <ShieldAlert className="w-4 h-4" />
            PANIC — Lock Host &amp; Kill Child Jobs
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void unlockHost()}
            className="btn-primary w-full font-bold"
          >
            <Unlock className="w-4 h-4" />
            <Lock className="w-4 h-4" />
            HOST LOCKED — Reset &amp; Unlock
          </button>
        )}
      </section>
    </main>
  );
};
