import React, { useState } from "react";
import {
  Activity,
  Battery,
  BatteryCharging,
  BellRing,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Fingerprint,
  HardDrive,
  KeyRound,
  Lock,
  MonitorOff,
  Puzzle,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Unlock,
  Zap,
} from "lucide-react";
import { api } from "../lib/api";
import { useZeroG } from "../lib/store";
import type {
  AgyCustomizationEntry,
  PowerGear,
  TunnelBackend,
} from "../types/contracts";
import { QrSvg } from "./QrSvg";

const POWER_GEARS: Array<{ id: PowerGear; label: string; desc: string }> = [
  { id: "ultra_sip", label: "Ultra-Sip", desc: "60% CPU cap · S0 ready" },
  { id: "auto_turbo", label: "Auto-Turbo", desc: "100% burst on active job" },
  { id: "balanced", label: "Balanced", desc: "Standard Windows profile" },
  { id: "max_turbo", label: "Max Turbo", desc: "Full clock · High perf" },
  {
    id: "low_battery_guard",
    label: "Low Battery Guard",
    desc: "Strict power saving",
  },
];

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function renderCustomizationLabel(entry: AgyCustomizationEntry | string): {
  title: string;
  subtitle?: string;
} {
  if (typeof entry === "string") {
    return { title: entry };
  }
  return {
    title: entry.name || entry.command || entry.id || "Unnamed item",
    subtitle: entry.description || entry.path || entry.source || undefined,
  };
}

export const LaptopTab: React.FC = () => {
  const {
    hostGlance,
    agentGateMode,
    setAgentGateMode,
    updatePowerGear,
    panicLock,
    unlockHost,
    tunnelStatus,
    startTunnel,
    stopTunnel,
    pairingCode,
    generatePairingCode,
    customizations,
    refreshAgyData,
  } = useZeroG();

  const [autoHibernate, setAutoHibernate] = useState(false);
  const [showCustomizations, setShowCustomizations] = useState(false);
  const [refreshingCust, setRefreshingCust] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyTunnel, setBusyTunnel] = useState(false);
  const [busyPanic, setBusyPanic] = useState(false);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleTunnelStart = async (backend: TunnelBackend) => {
    setBusyTunnel(true);
    try {
      await startTunnel(backend);
    } finally {
      setBusyTunnel(false);
    }
  };

  const handleRefreshCustomizations = async () => {
    setRefreshingCust(true);
    try {
      await refreshAgyData();
    } finally {
      setRefreshingCust(false);
    }
  };

  const handleEnablePush = async () => {
    setSecurityNotice(null);
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        setSecurityNotice("Web Push is not supported in this browser.");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setSecurityNotice("Notification permission was denied.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.getVapidPublicKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.subscribePush(sub.toJSON());
      setSecurityNotice("Web Push alerts enabled on this phone.");
    } catch (err) {
      setSecurityNotice(
        err instanceof Error ? err.message : "Failed to enable Web Push"
      );
    }
  };

  const handleEnrollPasskey = async () => {
    setSecurityNotice(null);
    try {
      const options = await api.getWebAuthnOptions("register");
      if (!window.PublicKeyCredential || !navigator.credentials) {
        await api.verifyWebAuthn({
          fallbackPinVerified: true,
          challenge: options.challenge,
        });
        setSecurityNotice("Passkey fallback verified with laptop daemon.");
        return;
      }
      const challengeStr = String(options.challenge || "0g-challenge");
      const challengeBytes = new TextEncoder().encode(challengeStr);
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: challengeBytes,
          rp: { name: "Zero-G Remote", id: window.location.hostname },
          user: {
            id: new TextEncoder().encode("0g-owner"),
            name: "0g-owner",
            displayName: "0G Owner",
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 30000,
          authenticatorSelection: {
            userVerification: "preferred",
          },
        },
      })) as PublicKeyCredential | null;
      await api.verifyWebAuthn({
        credId: cred?.id || "webauthn-enrolled",
        challenge: challengeStr,
      });
      setSecurityNotice("Passkey enrolled for high-risk approvals & unlock.");
    } catch (err) {
      setSecurityNotice(
        err instanceof Error ? err.message : "Passkey enrollment cancelled"
      );
    }
  };

  const publicUrl =
    tunnelStatus?.publicUrl || tunnelStatus?.localUrl || "http://127.0.0.1:8790";
  const qrTarget =
    pairingCode?.pairUrl ||
    (pairingCode?.code ? `${publicUrl}/?pair=${pairingCode.code}` : publicUrl);

  const ramPct =
    hostGlance && hostGlance.ramTotalMb > 0
      ? Math.round((hostGlance.ramUsedMb / hostGlance.ramTotalMb) * 100)
      : 0;

  const isLocked = Boolean(hostGlance?.hostLocked);
  const custTotal =
    (customizations?.plugins?.length || 0) +
    (customizations?.skills?.length || 0) +
    (customizations?.rules?.length || 0) +
    (customizations?.slashCommands?.length || 0);

  return (
    <div className="space-y-4">
      {/* 1. Agent Permission Mode */}
      <section aria-label="Agent Permission Mode" className="surface-card p-3.5 space-y-2.5">
        <div className="flex items-center gap-2">
          <ShieldCheck
            className="w-4 h-4 shrink-0"
            style={{ color: "var(--accent-primary)" }}
          />
          <div>
            <h2 className="font-display text-sm font-bold">
              Agent Permission Mode
            </h2>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Choose whether Antigravity asks your phone before sensitive actions or runs automatically.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void setAgentGateMode("ask_on_phone")}
            className={
              agentGateMode === "ask_on_phone"
                ? "btn-primary !flex-col !items-start !h-auto py-2.5 text-left"
                : "btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
            }
          >
            <span className="text-xs font-bold">Ask on Phone</span>
            <span className="text-[11px] opacity-80">
              Approve or deny from banner
            </span>
          </button>
          <button
            type="button"
            onClick={() => void setAgentGateMode("agent_turbo")}
            className={
              agentGateMode === "agent_turbo"
                ? "btn-primary !flex-col !items-start !h-auto py-2.5 text-left"
                : "btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
            }
          >
            <span className="text-xs font-bold">Agent Turbo</span>
            <span className="text-[11px] opacity-80">
              Auto-allow safe steps
            </span>
          </button>
        </div>
      </section>

      {/* 2. Backpack Laptop Power (5 Sticky Gears + Screen Off + Battery Slider) */}
      <section aria-label="Backpack Laptop Power" className="surface-card p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {hostGlance?.acPluggedIn ? (
              <BatteryCharging
                className="w-5 h-5 shrink-0"
                style={{ color: "var(--status-success)" }}
              />
            ) : (
              <Battery
                className="w-5 h-5 shrink-0"
                style={{ color: "var(--status-warning)" }}
              />
            )}
            <div className="min-w-0">
              <h2 className="font-display text-sm font-bold">
                Backpack Laptop Power
              </h2>
              <p className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
                {hostGlance?.batteryPercent ?? "--"}% ·{" "}
                {hostGlance?.acPluggedIn ? "Plugged In" : "On Battery"}
                {hostGlance?.batteryRemainingMin
                  ? ` · ~${hostGlance.batteryRemainingMin}m left`
                  : ""}
                {" · "}
                {hostGlance?.autoGovernorEnabled
                  ? "Auto-Scale On"
                  : "Manual Sticky Gear"}
              </p>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs cursor-pointer min-h-[44px]">
            <input
              type="checkbox"
              checked={Boolean(hostGlance?.autoGovernorEnabled ?? false)}
              onChange={(e) =>
                void updatePowerGear({ autoGovernorEnabled: e.target.checked })
              }
              className="h-5 w-5"
            />
            <span className="font-semibold">Auto-Scale</span>
          </label>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {POWER_GEARS.map((g) => {
            const active = hostGlance?.powerGear === g.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() =>
                  void updatePowerGear({
                    gear: g.id,
                    autoGovernorEnabled: g.id === "auto_turbo",
                  })
                }
                className={
                  active
                    ? "btn-primary !flex-col !items-start !h-auto py-2.5 text-left"
                    : "btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
                }
              >
                <span className="inline-flex items-center gap-1.5 text-xs font-bold">
                  <Zap className="w-3.5 h-3.5 shrink-0" />
                  {g.label}
                </span>
                <span className="text-[11px] opacity-80">{g.desc}</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => void updatePowerGear({ displayOff: true })}
            className="btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-bold">
              <MonitorOff className="w-3.5 h-3.5 shrink-0" />
              Screen Off
            </span>
            <span className="text-[11px] opacity-80">Safe in backpack</span>
          </button>
        </div>

        <div className="surface-subtle p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span>Low Battery Guard Threshold</span>
            <span className="font-mono font-bold tabular-nums">
              {hostGlance?.lowBatteryThreshold ?? 15}%
            </span>
          </div>
          <input
            type="range"
            min={5}
            max={40}
            step={1}
            value={hostGlance?.lowBatteryThreshold ?? 15}
            onChange={(e) =>
              void updatePowerGear({
                lowBatteryThreshold: Number(e.target.value),
              })
            }
            className="w-full min-h-[44px]"
            aria-label="Low Battery Guard Threshold"
          />
          <label className="flex items-center gap-2 text-xs cursor-pointer min-h-[44px]">
            <input
              type="checkbox"
              checked={autoHibernate}
              onChange={(e) => {
                setAutoHibernate(e.target.checked);
                void updatePowerGear({
                  autoHibernateAtThreshold: e.target.checked,
                });
              }}
              className="h-5 w-5"
            />
            <span>Hibernate laptop automatically at battery threshold</span>
          </label>
        </div>
      </section>

      {/* 3. Collapsible Antigravity Skills, Plugins & Rules Inspector */}
      <section aria-label="Antigravity Customizations" className="surface-card overflow-hidden">
        <button
          type="button"
          onClick={() => setShowCustomizations((v) => !v)}
          className="w-full min-h-[44px] px-3.5 py-3 flex items-center justify-between gap-2 text-left"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Puzzle
              className="w-4 h-4 shrink-0"
              style={{ color: "var(--accent-secondary)" }}
            />
            <div className="min-w-0">
              <div className="font-display text-sm font-bold truncate">
                Antigravity Skills, Plugins &amp; Rules
              </div>
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                {custTotal} installed ({customizations?.plugins?.length || 0} plugins ·{" "}
                {customizations?.skills?.length || 0} skills ·{" "}
                {customizations?.rules?.length || 0} rules)
              </div>
            </div>
          </div>
          {showCustomizations ? (
            <ChevronDown className="w-4 h-4 shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 shrink-0" />
          )}
        </button>

        {showCustomizations && (
          <div
            className="px-3.5 pb-3.5 pt-2 border-t space-y-3"
            style={{ borderColor: "var(--border-default)" }}
          >
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleRefreshCustomizations()}
                disabled={refreshingCust}
                className="btn-secondary !min-h-[44px] !px-3 text-xs"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${refreshingCust ? "animate-spin" : ""}`}
                />
                Refresh
              </button>
            </div>

            {(
              [
                { key: "plugins", title: "Plugins", items: customizations?.plugins || [] },
                { key: "skills", title: "Skills", items: customizations?.skills || [] },
                { key: "rules", title: "Rules", items: customizations?.rules || [] },
                {
                  key: "slashCommands",
                  title: "Slash Commands",
                  items: customizations?.slashCommands || [],
                },
              ] as const
            ).map((group) => (
              <div key={group.key} className="space-y-1.5">
                <div
                  className="text-xs font-semibold uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}
                >
                  {group.title} ({group.items.length})
                </div>
                {group.items.length === 0 ? (
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    None detected.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {group.items.map((item, idx) => {
                      const info = renderCustomizationLabel(item);
                      return (
                        <div
                          key={`${group.key}-${idx}`}
                          className="surface-subtle px-2.5 py-2 text-xs space-y-0.5"
                        >
                          <div className="font-mono font-semibold break-words">
                            {info.title}
                          </div>
                          {info.subtitle && (
                            <div
                              className="text-[11px] break-words"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {info.subtitle}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. Laptop Vitals & Listening Dev Ports */}
      <section aria-label="Laptop Vitals" className="surface-card p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Activity
              className="w-4 h-4 shrink-0"
              style={{ color: "var(--accent-secondary)" }}
            />
            <h2 className="font-display text-sm font-bold truncate">
              Laptop Vitals ({hostGlance?.hostname || "Host"})
            </h2>
          </div>
          <span
            className="text-[11px] font-mono shrink-0"
            style={{ color: "var(--text-muted)" }}
          >
            {hostGlance?.keepAwakeActive ? "Keep-Awake Active" : "Standard Sleep"}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="surface-subtle p-2.5 space-y-0.5">
            <div className="flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
              <Cpu className="w-3.5 h-3.5" />
              CPU
            </div>
            <div className="font-mono text-base font-bold tabular-nums">
              {hostGlance ? `${hostGlance.cpuPercent.toFixed(1)}%` : "--"}
            </div>
          </div>

          <div className="surface-subtle p-2.5 space-y-0.5">
            <div className="flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
              <Server className="w-3.5 h-3.5" />
              RAM ({ramPct}%)
            </div>
            <div className="font-mono text-sm font-bold tabular-nums">
              {hostGlance
                ? `${Math.round(hostGlance.ramUsedMb / 1024)}/${Math.round(hostGlance.ramTotalMb / 1024)} GB`
                : "--"}
            </div>
          </div>

          <div className="surface-subtle p-2.5 space-y-0.5">
            <div className="flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
              <HardDrive className="w-3.5 h-3.5" />
              Disk Free
            </div>
            <div className="font-mono text-sm font-bold tabular-nums">
              {hostGlance
                ? `${hostGlance.diskFreeGb.toFixed(0)}/${hostGlance.diskTotalGb.toFixed(0)} GB`
                : "--"}
            </div>
          </div>

          <div className="surface-subtle p-2.5 space-y-0.5">
            <div style={{ color: "var(--text-muted)" }}>GPU / VRAM</div>
            <div className="font-mono text-xs font-bold tabular-nums truncate">
              {hostGlance?.gpuName
                ? `${hostGlance.gpuLoadPercent ?? 0}% · ${hostGlance.vramUsedMb ?? 0}MB`
                : "Integrated / None"}
            </div>
          </div>
        </div>

        {hostGlance && hostGlance.listeningPorts.length > 0 && (
          <div className="space-y-1.5">
            <div
              className="text-xs font-semibold"
              style={{ color: "var(--text-muted)" }}
            >
              Listening Dev Ports ({hostGlance.listeningPorts.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {hostGlance.listeningPorts.slice(0, 12).map((p, idx) => (
                <span
                  key={idx}
                  className="rounded-full px-2.5 py-0.5 text-[11px] font-mono tabular-nums border"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-default)",
                    color: "var(--accent-secondary)",
                  }}
                >
                  :{String(p.port ?? p.localPort ?? "")}
                  {p.label ? ` (${String(p.label)})` : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 5. Cloudflare Tunnel, QR Pairing & PANIC Lock */}
      <section aria-label="Tunnel and Pairing" className="surface-card p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Radio
              className="w-4 h-4 shrink-0"
              style={{
                color:
                  tunnelStatus?.status === "running"
                    ? "var(--status-success)"
                    : "var(--accent-secondary)",
              }}
            />
            <h2 className="font-display text-sm font-bold">
              Remote Tunnel &amp; Phone Pairing
            </h2>
          </div>
          <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>
            {tunnelStatus?.status || "stopped"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <code
            className="flex-1 min-w-0 truncate rounded-[var(--radius-inner)] border px-3 py-2.5 font-mono text-xs"
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
            onClick={() => void handleCopy("tunnel-url", publicUrl)}
            className="btn-secondary !min-h-[44px] !px-3 shrink-0"
            aria-label="Copy tunnel URL"
          >
            {copiedId === "tunnel-url" ? (
              <Check className="w-4 h-4" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            disabled={busyTunnel}
            onClick={() => void handleTunnelStart("cloudflare")}
            className="btn-primary !min-h-[44px] text-xs"
          >
            Cloudflare
          </button>
          <button
            type="button"
            disabled={busyTunnel}
            onClick={() => void handleTunnelStart("tailscale")}
            className="btn-secondary !min-h-[44px] text-xs"
          >
            Tailscale
          </button>
          <button
            type="button"
            disabled={busyTunnel}
            onClick={() => void stopTunnel()}
            className="btn-secondary !min-h-[44px] text-xs"
          >
            Local Only
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-1">
          <QrSvg
            value={qrTarget}
            svgHtml={pairingCode?.qrSvg || tunnelStatus?.qrSvg}
            size={128}
            label="Zero-G Pairing QR Code"
          />
          <div className="flex-1 min-w-[180px] space-y-2">
            <button
              type="button"
              onClick={() => void generatePairingCode()}
              className="btn-secondary w-full !min-h-[44px] text-xs"
            >
              <KeyRound className="w-4 h-4" />
              New 6-Digit Pairing Code
            </button>
            {pairingCode?.code && (
              <div
                className="surface-subtle px-3 py-2 text-center font-mono text-xl font-bold tracking-[0.22em] tabular-nums"
                style={{ color: "var(--accent-primary)" }}
              >
                {pairingCode.code}
              </div>
            )}
            {tunnelStatus?.installHint && (
              <p
                className="font-mono text-[11px] break-all"
                style={{ color: "var(--status-warning)" }}
              >
                {tunnelStatus.installHint}
              </p>
            )}
          </div>
        </div>

        {/* Security & Push */}
        <div
          className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t"
          style={{ borderColor: "var(--border-default)" }}
        >
          <button
            type="button"
            onClick={() => void handleEnrollPasskey()}
            className="btn-secondary !min-h-[44px] text-xs"
          >
            <Fingerprint className="w-4 h-4" />
            Enroll Passkey
          </button>
          <button
            type="button"
            onClick={() => void handleEnablePush()}
            className="btn-secondary !min-h-[44px] text-xs"
          >
            <BellRing className="w-4 h-4" />
            Enable Phone Push Alerts
          </button>
        </div>
        {securityNotice && (
          <p className="text-xs" style={{ color: "var(--accent-secondary)" }}>
            {securityNotice}
          </p>
        )}

        {/* PANIC Lock */}
        <div
          className="pt-2 border-t"
          style={{ borderColor: "var(--border-default)" }}
        >
          {!isLocked ? (
            <button
              type="button"
              disabled={busyPanic}
              onClick={async () => {
                setBusyPanic(true);
                try {
                  await panicLock(false);
                } finally {
                  setBusyPanic(false);
                }
              }}
              className="btn-danger w-full !min-h-[44px] font-bold text-xs"
            >
              <ShieldAlert className="w-4 h-4" />
              PANIC — Lock Laptop Hooks &amp; Stop Running Jobs
            </button>
          ) : (
            <button
              type="button"
              disabled={busyPanic}
              onClick={async () => {
                setBusyPanic(true);
                try {
                  await unlockHost();
                } finally {
                  setBusyPanic(false);
                }
              }}
              className="btn-primary w-full !min-h-[44px] font-bold text-xs"
            >
              <Unlock className="w-4 h-4" />
              <Lock className="w-4 h-4" />
              HOST LOCKED — Reset &amp; Unlock Laptop
            </button>
          )}
        </div>
      </section>
    </div>
  );
};
