import React, { useState } from "react";
import {
  Activity,
  Battery,
  BatteryCharging,
  BellRing,
  Check,
  Copy,
  Cpu,
  Fingerprint,
  HardDrive,
  KeyRound,
  MonitorOff,
  Radio,
  Server,
  Terminal,
  Zap,
} from "lucide-react";
import { api } from "../lib/api";
import { useZeroG } from "../lib/store";
import type { PowerGear, TunnelBackend } from "../types/contracts";
import { ProviderBadge } from "./ProviderBadge";
import { QrSvg } from "./QrSvg";

const POWER_GEARS: Array<{ id: PowerGear; label: string; desc: string }> = [
  { id: "ultra_sip", label: "Ultra-Sip", desc: "60% CPU cap · S0 ready" },
  { id: "auto_turbo", label: "Auto-Turbo", desc: "100% burst on active job" },
  { id: "balanced", label: "Balanced", desc: "Windows Balanced overlay" },
  { id: "max_turbo", label: "Max Turbo", desc: "Full clock · High perf" },
  {
    id: "low_battery_guard",
    label: "Low-Batt Guard",
    desc: "Strict power saving",
  },
];

const TERMINAL_PRESETS = [
  { label: "git status", cmd: "git status -sb\r" },
  { label: "nvidia-smi", cmd: "nvidia-smi\r" },
  { label: "pytest", cmd: "pytest -q\r" },
  { label: "ports", cmd: "netstat -ano -p TCP | Select-String LISTENING\r" },
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

export const HostTab: React.FC = () => {
  const {
    hostGlance,
    updatePowerGear,
    ptySessions,
    activePtyId,
    setActivePtyId,
    ptyOutputBySession,
    createPty,
    sendPtyInput,
    tunnelStatus,
    startTunnel,
    stopTunnel,
    pairingCode,
    generatePairingCode,
    hookConfigs,
  } = useZeroG();

  const [termInput, setTermInput] = useState("");
  const [autoHibernate, setAutoHibernate] = useState(false);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyTunnel, setBusyTunnel] = useState(false);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleSendTerminal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePtyId || !termInput.trim()) return;
    sendPtyInput(activePtyId, termInput + "\r");
    setTermInput("");
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
      setSecurityNotice("Web Push enabled (zero-secret alert channel ready).");
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
        await api.verifyWebAuthn({ fallbackPinVerified: true, challenge: options.challenge });
        setSecurityNotice("Passkey fallback verified with daemon.");
        return;
      }
      const challengeStr = String(options.challenge || "0g-challenge");
      const challengeBytes = new TextEncoder().encode(challengeStr);
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: challengeBytes,
          rp: { name: "0G Remote Control", id: window.location.hostname },
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
      setSecurityNotice("WebAuthn Passkey enrolled for Tier-3 step-up & unlock.");
    } catch (err) {
      setSecurityNotice(
        err instanceof Error ? err.message : "Passkey enrollment cancelled or failed"
      );
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

  const publicUrl =
    tunnelStatus?.publicUrl || tunnelStatus?.localUrl || "http://127.0.0.1:8790";
  const qrTarget =
    pairingCode?.pairUrl ||
    (pairingCode?.code ? `${publicUrl}/?pair=${pairingCode.code}` : publicUrl);

  const ramPct =
    hostGlance && hostGlance.ramTotalMb > 0
      ? Math.round((hostGlance.ramUsedMb / hostGlance.ramTotalMb) * 100)
      : 0;

  return (
    <div className="space-y-5">
      {/* 1. Interactive Backpack Power Governor */}
      <section aria-label="Backpack Power Governor" className="surface-card p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {hostGlance?.acPluggedIn ? (
              <BatteryCharging
                className="w-5 h-5"
                style={{ color: "var(--status-success)" }}
              />
            ) : (
              <Battery
                className="w-5 h-5"
                style={{ color: "var(--status-warning)" }}
              />
            )}
            <div>
              <h2 className="font-display text-sm font-bold">
                Backpack Power Governor
              </h2>
              <p className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
                {hostGlance?.batteryPercent ?? "--"}% ·{" "}
                {hostGlance?.acPluggedIn ? "AC Plugged" : "On Battery"}
                {hostGlance?.batteryRemainingMin
                  ? ` · ~${hostGlance.batteryRemainingMin}m left`
                  : ""}
              </p>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs cursor-pointer min-h-[44px]">
            <input
              type="checkbox"
              checked={Boolean(hostGlance?.autoGovernorEnabled ?? true)}
              onChange={(e) =>
                void updatePowerGear({ autoGovernorEnabled: e.target.checked })
              }
              className="h-4 w-4"
            />
            <span className="font-semibold">Auto-Governor</span>
          </label>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {POWER_GEARS.map((g) => {
            const active = hostGlance?.powerGear === g.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => void updatePowerGear({ gear: g.id })}
                className={
                  active
                    ? "btn-primary !flex-col !items-start !h-auto py-2.5 text-left"
                    : "btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
                }
              >
                <span className="inline-flex items-center gap-1.5 text-xs font-bold">
                  <Zap className="w-3.5 h-3.5" />
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
              <MonitorOff className="w-3.5 h-3.5" />
              Display Off
            </span>
            <span className="text-[11px] opacity-80">Lid-closed backpack</span>
          </button>
        </div>

        <div className="surface-subtle p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span>Low-Battery Guard Threshold</span>
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
            className="w-full"
            aria-label="Low-Battery Guard Threshold"
          />
          <label className="flex items-center gap-2 text-xs cursor-pointer min-h-[36px]">
            <input
              type="checkbox"
              checked={autoHibernate}
              onChange={(e) => {
                setAutoHibernate(e.target.checked);
                void updatePowerGear({
                  autoHibernateAtThreshold: e.target.checked,
                });
              }}
              className="h-4 w-4"
            />
            <span>Arm automatic hibernate at threshold (on DC battery)</span>
          </label>
        </div>
      </section>

      {/* 2. Live Host Vitals */}
      <section aria-label="Host Vitals" className="surface-card p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity
              className="w-4 h-4"
              style={{ color: "var(--accent-secondary)" }}
            />
            <h2 className="font-display text-sm font-bold">
              Host Vitals ({hostGlance?.hostname || "Windows 11 Host"})
            </h2>
          </div>
          <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
            {hostGlance?.keepAwakeActive ? "Keep-Awake S0" : "Normal Sleep"}
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
                : "No NVIDIA GPU"}
            </div>
          </div>
        </div>

        {hostGlance && hostGlance.listeningPorts.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
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

      {/* 3. Interactive Phone Terminal (pwsh) */}
      <section aria-label="Phone Terminal" className="surface-card p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Terminal
              className="w-4 h-4"
              style={{ color: "var(--accent-primary)" }}
            />
            <h2 className="font-display text-sm font-bold">
              Interactive Phone Terminal (pwsh)
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            {ptySessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActivePtyId(s.id)}
                className={
                  activePtyId === s.id
                    ? "btn-primary !min-h-[44px] !px-2.5 text-xs font-mono"
                    : "btn-secondary !min-h-[44px] !px-2.5 text-xs font-mono"
                }
              >
                {s.id.slice(0, 8)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void createPty()}
              className="btn-secondary !min-h-[44px] !px-3 text-xs"
            >
              + New Shell
            </button>
          </div>
        </div>

        <pre
          className="surface-subtle p-3 h-52 overflow-y-auto font-mono text-xs whitespace-pre-wrap break-all leading-relaxed"
        >
          {activePtyId
            ? ptyOutputBySession[activePtyId] ||
              "PowerShell session ready. Type a command or tap a preset below."
            : "Tap '+ New Shell' to open a Job-Object protected pwsh terminal."}
        </pre>

        <div className="flex flex-wrap gap-1.5">
          {TERMINAL_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={!activePtyId}
              onClick={() =>
                activePtyId && sendPtyInput(activePtyId, preset.cmd)
              }
              className="btn-secondary !min-h-[44px] !px-2.5 text-xs font-mono"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSendTerminal} className="flex gap-2">
          <input
            type="text"
            value={termInput}
            onChange={(e) => setTermInput(e.target.value)}
            placeholder={
              activePtyId
                ? "Enter PowerShell command..."
                : "Create a shell first..."
            }
            disabled={!activePtyId}
            className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2 font-mono text-sm"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          />
          <button
            type="submit"
            disabled={!activePtyId || !termInput.trim()}
            className="btn-primary shrink-0 text-xs"
          >
            Run
          </button>
        </form>
      </section>

      {/* 4. Tunnel & QR Pairing */}
      <section aria-label="Tunnel and Pairing" className="surface-card p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Radio
              className="w-4 h-4"
              style={{ color: "var(--accent-secondary)" }}
            />
            <h2 className="font-display text-sm font-bold">
              Hotspot Tunnel &amp; QR Pairing
            </h2>
          </div>
          <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>
            {tunnelStatus?.status || "stopped"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <code
            className="flex-1 min-w-0 truncate rounded-[var(--radius-inner)] border px-3 py-2 font-mono text-xs"
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
            className="btn-secondary !px-3 shrink-0"
            aria-label="Copy public URL"
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
            className="btn-primary text-xs"
          >
            Cloudflare
          </button>
          <button
            type="button"
            disabled={busyTunnel}
            onClick={() => void handleTunnelStart("tailscale")}
            className="btn-secondary text-xs"
          >
            Tailscale
          </button>
          <button
            type="button"
            disabled={busyTunnel}
            onClick={() => void stopTunnel()}
            className="btn-secondary text-xs"
          >
            Local Only
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-1">
          <QrSvg
            value={qrTarget}
            svgHtml={pairingCode?.qrSvg || tunnelStatus?.qrSvg}
            size={132}
            label="0G Pairing QR Code"
          />
          <div className="flex-1 min-w-[180px] space-y-2">
            <button
              type="button"
              onClick={() => void generatePairingCode()}
              className="btn-secondary w-full text-xs"
            >
              <KeyRound className="w-4 h-4" />
              Generate 6-Digit Pairing Code
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
              <p className="font-mono text-[11px] break-all" style={{ color: "var(--status-warning)" }}>
                {tunnelStatus.installHint}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* 5. WebAuthn Passkey & Web Push Opt-In */}
      <section aria-label="Security and Push" className="surface-card p-3.5 space-y-3">
        <h2 className="font-display text-sm font-bold">
          Passkey Step-Up &amp; Web Push Alerts
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void handleEnrollPasskey()}
            className="btn-secondary text-xs"
          >
            <Fingerprint className="w-4 h-4" />
            Enroll WebAuthn Passkey
          </button>
          <button
            type="button"
            onClick={() => void handleEnablePush()}
            className="btn-secondary text-xs"
          >
            <BellRing className="w-4 h-4" />
            Enable Zero-Secret Web Push
          </button>
        </div>
        {securityNotice && (
          <p className="text-xs" style={{ color: "var(--accent-secondary)" }}>
            {securityNotice}
          </p>
        )}
      </section>

      {/* 6. Multi-Provider Hook Setup Viewer */}
      <section aria-label="Multi-Provider Hook Setup" className="surface-card p-3.5 space-y-3">
        <h2 className="font-display text-sm font-bold">
          Multi-Provider Hook Snippets
        </h2>
        {hookConfigs.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Hook configs load when connected to the 0G daemon.
          </p>
        ) : (
          <div className="space-y-2.5">
            {hookConfigs.map((cfg) => {
              const formatted =
                typeof cfg.snippet === "string"
                  ? cfg.snippet
                  : JSON.stringify(cfg.snippet, null, 2);
              return (
                <div key={cfg.provider} className="surface-subtle p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderBadge provider={cfg.provider} />
                      <span
                        className="font-mono text-[11px] truncate"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {cfg.configPath}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopy(`hook-${cfg.provider}`, formatted)
                      }
                      className="btn-secondary !min-h-[44px] !px-2.5 text-xs shrink-0"
                    >
                      {copiedId === `hook-${cfg.provider}` ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      Copy
                    </button>
                  </div>
                  <pre className="font-mono text-[11px] overflow-x-auto max-h-40 leading-relaxed">
                    {formatted}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
