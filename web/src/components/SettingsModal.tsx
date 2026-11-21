import React, { useEffect, useState } from "react";
import {
  Battery,
  BatteryCharging,
  BellRing,
  Check,
  Copy,
  Cpu,
  Fingerprint,
  HardDrive,
  KeyRound,
  Laptop,
  Lock,
  Mail,
  MonitorOff,
  Palette,
  Radio,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Unlock,
  X,
  Zap,
} from "lucide-react";
import { api } from "../lib/api";
import { useZeroG } from "../lib/store";
import type {
  InterfaceLayout,
  PermissionPreset,
  PowerGear,
  SettingsSection,
  ThemePreset,
  TunnelBackend,
} from "../types/contracts";
import { QrSvg } from "./QrSvg";

const PERMISSION_PRESETS: Array<{
  id: PermissionPreset;
  label: string;
  desc: string;
}> = [
  {
    id: "request_review",
    label: "Request Review",
    desc: "Hold commands & edits for mobile approval",
  },
  {
    id: "default",
    label: "Default",
    desc: "Standard Antigravity workspace review policy",
  },
  {
    id: "auto",
    label: "Auto",
    desc: "Auto-approve safe workspace operations",
  },
  {
    id: "turbo",
    label: "Turbo",
    desc: "Maximum speed · Tier-3 guard still blocks destructive ops",
  },
];

const POWER_GEARS: Array<{ id: PowerGear; label: string; desc: string }> = [
  { id: "ultra_sip", label: "Ultra-Sip", desc: "60% CPU cap · S0 ready" },
  { id: "auto_turbo", label: "Auto-Turbo", desc: "100% burst on active job" },
  { id: "balanced", label: "Balanced", desc: "Standard Windows profile" },
  { id: "max_turbo", label: "Max Turbo", desc: "Full clock · High perf" },
  {
    id: "low_battery_guard",
    label: "Low-Batt Guard",
    desc: "Strict battery protection",
  },
];

const THEME_CARDS: Array<{
  id: ThemePreset;
  label: string;
  desc: string;
}> = [
  {
    id: "obsidian",
    label: "Obsidian",
    desc: "High-contrast dark remote workspace",
  },
  {
    id: "outdoor",
    label: "Outdoor",
    desc: "Daylight-legible high-luminance surface",
  },
  {
    id: "wireframe",
    label: "Wireframe",
    desc: "Crisp monochrome structural blueprint",
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

export const SettingsModal: React.FC = () => {
  const {
    settingsModalOpen,
    settingsSection,
    openSettingsModal,
    closeSettingsModal,
    interfaceLayout,
    setInterfaceLayout,
    permissionPreset,
    setPermissionPreset,
    autostartStatus,
    updateAutostart,
    theme,
    setTheme,
    hostGlance,
    updatePowerGear,
    panicLock,
    unlockHost,
    tunnelStatus,
    startTunnel,
    stopTunnel,
    pairingCode,
    generatePairingCode,
  } = useZeroG();

  const [autoEnabled, setAutoEnabled] = useState<boolean>(
    autostartStatus?.enabled ?? false
  );
  const [notifyEmail, setNotifyEmail] = useState<string>(
    autostartStatus?.notifyEmail || "blagoslov333@gmail.com"
  );
  const [autoEmailTunnel, setAutoEmailTunnel] = useState<boolean>(
    autostartStatus?.autoEmailOnTunnelChange ?? true
  );
  const [savingAutostart, setSavingAutostart] = useState(false);
  const [autostartMsg, setAutostartMsg] = useState<string | null>(null);

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [busyTunnel, setBusyTunnel] = useState(false);
  const [busyPanic, setBusyPanic] = useState(false);
  const [autoHibernate, setAutoHibernate] = useState(false);
  const [securityMsg, setSecurityMsg] = useState<string | null>(null);

  useEffect(() => {
    if (autostartStatus) {
      setAutoEnabled(Boolean(autostartStatus.enabled));
      if (autostartStatus.notifyEmail) {
        setNotifyEmail(autostartStatus.notifyEmail);
      }
      setAutoEmailTunnel(
        autostartStatus.autoEmailOnTunnelChange !== undefined
          ? Boolean(autostartStatus.autoEmailOnTunnelChange)
          : true
      );
    }
  }, [autostartStatus]);

  if (!settingsModalOpen) return null;

  const hostname = hostGlance?.hostname || "LAPSTATION";
  const isLocked = Boolean(hostGlance?.hostLocked);
  const publicUrl =
    tunnelStatus?.publicUrl || tunnelStatus?.localUrl || "http://127.0.0.1:8790";
  const qrTarget =
    pairingCode?.pairUrl ||
    (pairingCode?.code ? `${publicUrl}/?pair=${pairingCode.code}` : publicUrl);

  const ramPct =
    hostGlance && hostGlance.ramTotalMb > 0
      ? Math.round((hostGlance.ramUsedMb / hostGlance.ramTotalMb) * 100)
      : 0;

  const handleSaveAutostart = async (sendTestNow = false) => {
    setSavingAutostart(true);
    setAutostartMsg(null);
    try {
      const res = await updateAutostart({
        enabled: autoEnabled,
        notifyEmail: notifyEmail.trim() || "blagoslov333@gmail.com",
        autoEmailOnTunnelChange: autoEmailTunnel,
        sendTestNow,
      });
      setAutostartMsg(
        sendTestNow
          ? `Test link dispatched to ${res.notifyEmail || notifyEmail}`
          : "Windows login & Gmail link delivery settings saved."
      );
    } catch (err) {
      setAutostartMsg(
        err instanceof Error ? err.message : "Failed to update Auto-Start"
      );
    } finally {
      setSavingAutostart(false);
    }
  };

  const handleCopyTunnelUrl = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // Ignore clipboard failure
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

  const handleEnablePush = async () => {
    setSecurityMsg(null);
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        setSecurityMsg("Web Push is not supported in this browser.");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setSecurityMsg("Notification permission denied.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.getVapidPublicKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.subscribePush(sub.toJSON());
      setSecurityMsg("Phone Web Push alerts enabled.");
    } catch (err) {
      setSecurityMsg(
        err instanceof Error ? err.message : "Failed to enable Web Push"
      );
    }
  };

  const handleEnrollPasskey = async () => {
    setSecurityMsg(null);
    try {
      const options = await api.getWebAuthnOptions("register");
      if (!window.PublicKeyCredential || !navigator.credentials) {
        await api.verifyWebAuthn({
          fallbackPinVerified: true,
          challenge: options.challenge,
        });
        setSecurityMsg("Passkey fallback verified with host daemon.");
        return;
      }
      const challengeStr = String(options.challenge || "0g-challenge");
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: new TextEncoder().encode(challengeStr),
          rp: { name: "Antigravity Remote", id: window.location.hostname },
          user: {
            id: new TextEncoder().encode("0g-owner"),
            name: "0g-owner",
            displayName: "Antigravity Owner",
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 30000,
          authenticatorSelection: { userVerification: "preferred" },
        },
      })) as PublicKeyCredential | null;
      await api.verifyWebAuthn({
        credId: cred?.id || "webauthn-enrolled",
        challenge: challengeStr,
      });
      setSecurityMsg("Passkey enrolled for approvals & unlock.");
    } catch (err) {
      setSecurityMsg(
        err instanceof Error ? err.message : "Passkey enrollment cancelled"
      );
    }
  };

  const navItems: Array<{
    id: SettingsSection;
    label: string;
    Icon: React.FC<{ className?: string }>;
  }> = [
    { id: "general", label: "General", Icon: Sliders },
    { id: "appearance", label: "Appearance", Icon: Palette },
    { id: "computer", label: `This Computer (${hostname})`, Icon: Laptop },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      style={{ backgroundColor: "var(--overlay-scrim)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agy-settings-title"
    >
      <div className="surface-card w-full max-w-3xl h-[92dvh] sm:h-[82dvh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div
          className="px-4 py-3 border-b flex items-center justify-between gap-2 shrink-0"
          style={{ borderColor: "var(--border-default)" }}
        >
          <h2 id="agy-settings-title" className="font-display text-base font-bold">
            Antigravity Settings
          </h2>
          <button
            type="button"
            onClick={closeSettingsModal}
            className="agy-icon-btn"
            aria-label="Close settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Section Tabs + Content */}
        <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
          {/* Left / Top Section Picker */}
          <nav
            aria-label="Settings Sections"
            className="flex md:flex-col gap-1 p-2 border-b md:border-b-0 md:border-r md:w-56 shrink-0 overflow-x-auto"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
            }}
          >
            {navItems.map(({ id, label, Icon }) => {
              const active = settingsSection === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => openSettingsModal(id)}
                  className="min-h-[44px] px-3 py-2 rounded-[var(--radius-inner)] border flex items-center gap-2 text-xs font-semibold whitespace-nowrap text-left shrink-0 md:w-full"
                  style={{
                    backgroundColor: active
                      ? "var(--bg-elevated)"
                      : "transparent",
                    borderColor: active
                      ? "var(--accent-primary)"
                      : "transparent",
                    color: active
                      ? "var(--text-primary)"
                      : "var(--text-muted)",
                  }}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </nav>

          {/* Active Section Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* ==============================================================
                SECTION 1: GENERAL
               ============================================================== */}
            {settingsSection === "general" && (
              <>
                {/* Interface Layout */}
                <section className="space-y-2">
                  <div>
                    <h3 className="font-display text-sm font-bold">
                      Interface Layout
                    </h3>
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                      Switch between full Software Engineering tools and streamlined Knowledge Work mode.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(
                      [
                        {
                          id: "software_engineering" as InterfaceLayout,
                          title: "Software Engineering",
                          desc: "Worktrees, Git Diffs & Commit/Push, Live Port Preview, Terminal & Swarm",
                        },
                        {
                          id: "knowledge_work" as InterfaceLayout,
                          title: "Knowledge Work",
                          desc: "Clean distraction-free canvas with Artifacts & Subagents",
                        },
                      ] as const
                    ).map((opt) => {
                      const active = interfaceLayout === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => void setInterfaceLayout(opt.id)}
                          className={`rounded-[var(--radius-inner)] border p-3 text-left min-h-[56px] space-y-1 ${
                            active ? "btn-primary !items-start !flex-col" : ""
                          }`}
                          style={
                            active
                              ? undefined
                              : {
                                  backgroundColor: "var(--bg-subtle)",
                                  borderColor: "var(--border-default)",
                                  color: "var(--text-primary)",
                                }
                          }
                        >
                          <div className="text-xs font-bold">{opt.title}</div>
                          <div className="text-[11px] opacity-85">
                            {opt.desc}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Global Permission Preset */}
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck
                      className="w-4 h-4 shrink-0"
                      style={{ color: "var(--accent-primary)" }}
                    />
                    <div>
                      <h3 className="font-display text-sm font-bold">
                        Global Permission Preset
                      </h3>
                      <p
                        className="text-xs"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Default autonomy policy when a project uses{" "}
                        <code>Inherit Global</code>.
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {PERMISSION_PRESETS.map((p) => {
                      const active = permissionPreset === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => void setPermissionPreset(p.id)}
                          className={
                            active
                              ? "btn-primary !flex-col !items-start !h-auto py-2.5 text-left"
                              : "btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
                          }
                        >
                          <span className="text-xs font-bold">{p.label}</span>
                          <span className="text-[11px] opacity-85">
                            {p.desc}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Windows Login Auto-Start & Gmail Link Delivery */}
                <section className="surface-subtle p-3.5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Mail
                      className="w-4 h-4 shrink-0"
                      style={{ color: "var(--accent-secondary)" }}
                    />
                    <div>
                      <h3 className="font-display text-sm font-bold">
                        Windows Login Auto-Start &amp; Gmail Link Delivery
                      </h3>
                      <p
                        className="text-xs"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Automatically launch Zero-G on Windows login and deliver the fresh Cloudflare Tunnel pairing link via Web Push &amp; Gmail.
                      </p>
                    </div>
                  </div>

                  <label className="flex items-center gap-2.5 min-h-[44px] text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoEnabled}
                      onChange={(e) => setAutoEnabled(e.target.checked)}
                      className="w-5 h-5"
                    />
                    <span className="font-semibold">
                      Launch Zero-G automatically at Windows login
                    </span>
                  </label>

                  <label className="block space-y-1">
                    <span
                      className="text-xs font-medium"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Delivery Email Address
                    </span>
                    <input
                      type="email"
                      value={notifyEmail}
                      onChange={(e) => setNotifyEmail(e.target.value)}
                      placeholder="blagoslov333@gmail.com"
                      className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5 text-base font-mono"
                      style={{
                        backgroundColor: "var(--bg-surface)",
                        borderColor: "var(--border-default)",
                        color: "var(--text-primary)",
                      }}
                    />
                  </label>

                  <label className="flex items-center gap-2.5 min-h-[44px] text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoEmailTunnel}
                      onChange={(e) => setAutoEmailTunnel(e.target.checked)}
                      className="w-5 h-5"
                    />
                    <span>
                      Auto-email fresh pairing URL whenever Cloudflare Tunnel starts or rotates
                    </span>
                  </label>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      disabled={savingAutostart}
                      onClick={() => void handleSaveAutostart(false)}
                      className="btn-primary !min-h-[44px] text-xs"
                    >
                      {savingAutostart ? "Saving…" : "Save Auto-Start"}
                    </button>
                    <button
                      type="button"
                      disabled={savingAutostart}
                      onClick={() => void handleSaveAutostart(true)}
                      className="btn-secondary !min-h-[44px] text-xs"
                    >
                      <Mail className="w-4 h-4" />
                      Send Test Link Now
                    </button>
                  </div>

                  {autostartMsg && (
                    <p
                      className="text-xs font-medium"
                      style={{ color: "var(--status-success-fg)" }}
                    >
                      {autostartMsg}
                    </p>
                  )}
                </section>
              </>
            )}

            {/* ==============================================================
                SECTION 2: APPEARANCE
               ============================================================== */}
            {settingsSection === "appearance" && (
              <section className="space-y-3">
                <div>
                  <h3 className="font-display text-sm font-bold">
                    Structural Theme Preset
                  </h3>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Select your preferred surface contrast preset across mobile and desktop.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  {THEME_CARDS.map((card) => {
                    const active = theme === card.id;
                    return (
                      <button
                        key={card.id}
                        type="button"
                        onClick={() => setTheme(card.id)}
                        className={
                          active
                            ? "btn-primary !flex-col !items-start !h-auto p-3.5 text-left"
                            : "btn-secondary !flex-col !items-start !h-auto p-3.5 text-left"
                        }
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="font-display text-sm font-bold">
                            {card.label}
                          </span>
                          {active && <Check className="w-4 h-4 shrink-0" />}
                        </div>
                        <span className="text-xs opacity-85">{card.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ==============================================================
                SECTION 3: THIS COMPUTER (LAPSTATION)
               ============================================================== */}
            {settingsSection === "computer" && (
              <div className="space-y-4">
                {/* Power & Backpack Governor */}
                <section className="surface-subtle p-3.5 space-y-3">
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
                        <h3 className="font-display text-sm font-bold">
                          Backpack Power Governor ({hostname})
                        </h3>
                        <p
                          className="text-xs font-mono tabular-nums"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {hostGlance?.batteryPercent ?? "--"}% ·{" "}
                          {hostGlance?.acPluggedIn ? "AC Plugged" : "On Battery"}
                          {hostGlance?.batteryRemainingMin
                            ? ` · ~${hostGlance.batteryRemainingMin}m`
                            : ""}{" "}
                          ·{" "}
                          {hostGlance?.keepAwakeActive ? "S0 Ready" : "Standard"}
                        </p>
                      </div>
                    </div>

                    <label className="inline-flex items-center gap-2 min-h-[44px] text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(hostGlance?.autoGovernorEnabled)}
                        onChange={(e) =>
                          void updatePowerGear({
                            autoGovernorEnabled: e.target.checked,
                          })
                        }
                        className="w-5 h-5"
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
                          <span className="inline-flex items-center gap-1 text-xs font-bold">
                            <Zap className="w-3.5 h-3.5 shrink-0" />
                            {g.label}
                          </span>
                          <span className="text-[10px] opacity-80">
                            {g.desc}
                          </span>
                        </button>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => void updatePowerGear({ displayOff: true })}
                      className="btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
                    >
                      <span className="inline-flex items-center gap-1 text-xs font-bold">
                        <MonitorOff className="w-3.5 h-3.5 shrink-0" />
                        Display Off
                      </span>
                      <span className="text-[10px] opacity-80">
                        Safe in closed bag
                      </span>
                    </button>
                  </div>

                  <div className="pt-1 space-y-1.5">
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
                      className="w-full min-h-[44px]"
                      aria-label="Low Battery Guard Threshold"
                    />
                    <label className="flex items-center gap-2 min-h-[44px] text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoHibernate}
                        onChange={(e) => {
                          setAutoHibernate(e.target.checked);
                          void updatePowerGear({
                            autoHibernateAtThreshold: e.target.checked,
                          });
                        }}
                        className="w-5 h-5"
                      />
                      <span>Hibernate laptop automatically at threshold</span>
                    </label>
                  </div>
                </section>

                {/* Hardware Telemetry */}
                <section className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="surface-subtle p-2.5 space-y-0.5">
                    <div
                      className="flex items-center gap-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <Cpu className="w-3.5 h-3.5" />
                      CPU
                    </div>
                    <div className="font-mono text-sm font-bold tabular-nums">
                      {hostGlance
                        ? `${hostGlance.cpuPercent.toFixed(1)}%`
                        : "--"}
                    </div>
                  </div>

                  <div className="surface-subtle p-2.5 space-y-0.5">
                    <div
                      className="flex items-center gap-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <Server className="w-3.5 h-3.5" />
                      RAM ({ramPct}%)
                    </div>
                    <div className="font-mono text-sm font-bold tabular-nums">
                      {hostGlance
                        ? `${Math.round(hostGlance.ramUsedMb / 1024)}/${Math.round(
                            hostGlance.ramTotalMb / 1024
                          )} GB`
                        : "--"}
                    </div>
                  </div>

                  <div className="surface-subtle p-2.5 space-y-0.5">
                    <div
                      className="flex items-center gap-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <HardDrive className="w-3.5 h-3.5" />
                      Disk Free
                    </div>
                    <div className="font-mono text-sm font-bold tabular-nums">
                      {hostGlance
                        ? `${hostGlance.diskFreeGb.toFixed(0)}/${hostGlance.diskTotalGb.toFixed(
                            0
                          )} GB`
                        : "--"}
                    </div>
                  </div>

                  <div className="surface-subtle p-2.5 space-y-0.5">
                    <div style={{ color: "var(--text-muted)" }}>GPU / VRAM</div>
                    <div className="font-mono text-xs font-bold tabular-nums truncate">
                      {hostGlance?.gpuName
                        ? `${hostGlance.gpuLoadPercent ?? 0}% · ${
                            hostGlance.vramUsedMb ?? 0
                          }MB`
                        : "Integrated"}
                    </div>
                  </div>
                </section>

                {/* Cloudflare Tunnel + QR Pairing */}
                <section className="surface-subtle p-3.5 space-y-3">
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
                      <h3 className="font-display text-sm font-bold">
                        Cloudflare Tunnel &amp; QR Pairing
                      </h3>
                    </div>
                    <span
                      className="font-mono text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {tunnelStatus?.backend || "local"} ·{" "}
                      {tunnelStatus?.status || "stopped"}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <code
                      className="flex-1 min-w-0 truncate rounded-[var(--radius-inner)] border px-3 py-2 font-mono text-xs"
                      style={{
                        backgroundColor: "var(--bg-surface)",
                        borderColor: "var(--border-default)",
                        color: "var(--accent-secondary)",
                      }}
                    >
                      {publicUrl}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleCopyTunnelUrl()}
                      className="btn-secondary !min-h-[44px] !px-3 shrink-0"
                      aria-label="Copy tunnel URL"
                    >
                      {copiedUrl ? (
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
                      onClick={() => void handleStartTunnel("cloudflare")}
                      className="btn-primary !min-h-[44px] text-xs"
                    >
                      Cloudflare
                    </button>
                    <button
                      type="button"
                      disabled={busyTunnel}
                      onClick={() => void handleStartTunnel("tailscale")}
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

                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <QrSvg
                      value={qrTarget}
                      svgHtml={pairingCode?.qrSvg || tunnelStatus?.qrSvg}
                      size={116}
                      label="Pairing QR Code"
                    />
                    <div className="flex-1 min-w-[170px] space-y-2">
                      <button
                        type="button"
                        onClick={() => void generatePairingCode()}
                        className="btn-secondary w-full !min-h-[44px] text-xs"
                      >
                        <KeyRound className="w-4 h-4" />
                        Generate 6-Digit Code
                      </button>
                      {pairingCode?.code && (
                        <div
                          className="rounded-[var(--radius-inner)] border px-3 py-2 text-center font-mono text-xl font-bold tracking-[0.22em] tabular-nums"
                          style={{
                            backgroundColor: "var(--bg-surface)",
                            borderColor: "var(--border-default)",
                            color: "var(--accent-primary)",
                          }}
                        >
                          {pairingCode.code}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
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
                      Enable Web Push
                    </button>
                  </div>
                  {securityMsg && (
                    <p
                      className="text-xs"
                      style={{ color: "var(--accent-secondary)" }}
                    >
                      {securityMsg}
                    </p>
                  )}
                </section>

                {/* PANIC Host Lock / Unlock */}
                <section className="pt-1">
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
                      className="btn-danger w-full !min-h-[48px] text-xs font-bold"
                    >
                      <ShieldAlert className="w-4 h-4" />
                      PANIC — Lock Host Hooks &amp; Terminate Active Jobs
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
                      className="btn-primary w-full !min-h-[48px] text-xs font-bold"
                    >
                      <Unlock className="w-4 h-4" />
                      <Lock className="w-4 h-4" />
                      HOST LOCKED — Reset &amp; Unlock {hostname}
                    </button>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
