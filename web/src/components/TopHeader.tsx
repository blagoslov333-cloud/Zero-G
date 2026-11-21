import React from "react";
import {
  Battery,
  BatteryCharging,
  Laptop,
  Lock,
  PanelLeft,
  PanelRight,
  SquarePen,
  Zap,
} from "lucide-react";
import { useZeroG } from "../lib/store";
import type { PowerGear } from "../types/contracts";

const GEAR_SHORT: Record<PowerGear, string> = {
  ultra_sip: "Sip",
  auto_turbo: "Auto",
  balanced: "Bal",
  max_turbo: "Max",
  low_battery_guard: "Guard",
};

export const TopHeader: React.FC = () => {
  const {
    isAuxPane,
    leftSidebarOpen,
    toggleLeftSidebar,
    rightAuxOpen,
    toggleRightAux,
    openSettingsModal,
    startFreshNewConversationView,
    wsStatus,
    hostGlance,
    approvals,
    agyConversations,
    activeConversationId,
    activeConversationDetail,
    isNewChatDraft,
    selectedProject,
    devPorts,
  } = useZeroG();

  const pendingApprovalsCount = approvals.filter(
    (a) => a.status === "pending"
  ).length;
  const dirtyGitCount = selectedProject?.dirtyCount || 0;
  const subagentsCount =
    activeConversationDetail?.subagents?.length ||
    agyConversations.find((c) => c.id === activeConversationId)?.subagentCount ||
    0;
  const activePortsCount = devPorts.length;

  const auxBadgeTotal =
    pendingApprovalsCount +
    (dirtyGitCount > 0 ? 1 : 0) +
    (subagentsCount > 0 ? 1 : 0) +
    (activePortsCount > 0 ? 1 : 0);

  const activeConv =
    activeConversationDetail?.conversation ||
    agyConversations.find((c) => c.id === activeConversationId) ||
    null;

  const activeTitle =
    isNewChatDraft || !activeConv
      ? "New conversation"
      : activeConv.title || "Conversation";

  const hostname = hostGlance?.hostname || "LAPSTATION";
  const battery = hostGlance?.batteryPercent;
  const acPlugged = hostGlance?.acPluggedIn;
  const gear = hostGlance?.powerGear || "ultra_sip";
  const isLocked = Boolean(hostGlance?.hostLocked);

  const wsDotColor =
    wsStatus === "connected"
      ? "var(--status-success)"
      : wsStatus === "offline"
        ? "var(--status-danger)"
        : "var(--status-warning)";

  const onlineText =
    wsStatus === "connected"
      ? "Online"
      : wsStatus === "offline"
        ? "Offline"
        : "Syncing";

  if (isAuxPane) {
    return (
      <header
        className="sticky top-0 z-30 border-b px-3 py-2 flex items-center justify-between gap-2 min-h-[52px]"
        style={{
          backgroundColor: "var(--bg-surface)",
          borderColor: "var(--border-default)",
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: wsDotColor }}
          />
          <span className="font-display text-sm font-bold truncate">
            {hostname} · Antigravity Companion
          </span>
        </div>
        <span
          className="font-mono text-xs tabular-nums shrink-0"
          style={{ color: "var(--text-muted)" }}
        >
          {typeof battery === "number" ? `${battery}%` : onlineText}
        </span>
      </header>
    );
  }

  return (
    <header
      className="shrink-0 z-30 border-b px-2 sm:px-3 flex items-center justify-between gap-1.5 min-h-[54px]"
      style={{
        backgroundColor: "var(--bg-surface)",
        borderColor: "var(--border-default)",
      }}
    >
      {/* Left: Sidebar Toggle + New Conversation */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          onClick={toggleLeftSidebar}
          className="agy-icon-btn"
          aria-label={leftSidebarOpen ? "Close left sidebar" : "Open left sidebar"}
          aria-expanded={leftSidebarOpen}
          title="Toggle Sidebar"
        >
          <PanelLeft
            className="w-5 h-5"
            style={{
              color: leftSidebarOpen
                ? "var(--accent-primary)"
                : "var(--text-muted)",
            }}
          />
        </button>

        <button
          type="button"
          onClick={() => startFreshNewConversationView()}
          className="agy-icon-btn"
          aria-label="New conversation"
          title="New conversation"
        >
          <SquarePen className="w-5 h-5" />
        </button>
      </div>

      {/* Center: Computer Instance Pill + Active Conversation Title */}
      <div className="flex items-center justify-center gap-2 min-w-0 flex-1">
        <button
          type="button"
          onClick={() => openSettingsModal("computer")}
          className="agy-pill-btn !px-2.5 sm:!px-3 max-w-full min-w-0 shrink"
          title="Open Settings → This Computer"
          aria-label={`Computer instance ${hostname}, status ${onlineText}`}
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              backgroundColor: isLocked ? "var(--status-danger)" : wsDotColor,
            }}
            aria-hidden="true"
          />
          {isLocked ? (
            <Lock
              className="w-3.5 h-3.5 shrink-0"
              style={{ color: "var(--status-danger)" }}
            />
          ) : (
            <Laptop
              className="w-3.5 h-3.5 shrink-0 hidden xs:inline sm:inline"
              style={{ color: "var(--text-muted)" }}
            />
          )}
          <span className="font-semibold truncate max-w-[115px] sm:max-w-[180px]">
            {hostname}
          </span>
          <span
            className="hidden sm:inline text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            · {isLocked ? "Locked" : onlineText}
          </span>

          {typeof battery === "number" && (
            <span
              className="inline-flex items-center gap-0.5 font-mono text-[11px] tabular-nums shrink-0 pl-1 border-l"
              style={{
                borderColor: "var(--border-default)",
                color:
                  battery <= 20 && !acPlugged
                    ? "var(--status-warning)"
                    : "var(--text-muted)",
              }}
            >
              {acPlugged ? (
                <BatteryCharging
                  className="w-3.5 h-3.5 shrink-0"
                  style={{ color: "var(--status-success)" }}
                />
              ) : (
                <Battery className="w-3.5 h-3.5 shrink-0" />
              )}
              <span>{battery}%</span>
            </span>
          )}

          <span
            className="hidden md:inline-flex items-center gap-0.5 font-mono text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
            style={{
              backgroundColor: "var(--bg-elevated)",
              color: "var(--accent-secondary)",
            }}
          >
            <Zap className="w-2.5 h-2.5" />
            {GEAR_SHORT[gear]}
          </span>
        </button>

        <span
          className="hidden md:inline text-xs font-medium truncate max-w-[240px] lg:max-w-[340px]"
          style={{ color: "var(--text-muted)" }}
          title={activeTitle}
        >
          {activeTitle}
        </span>
      </div>

      {/* Right: Auxiliary Pane Toggle + Actionable Badge */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={toggleRightAux}
          className="agy-icon-btn relative"
          aria-label={
            rightAuxOpen ? "Close auxiliary pane" : "Open auxiliary pane"
          }
          aria-expanded={rightAuxOpen}
          title="Toggle Right Auxiliary Pane"
        >
          <PanelRight
            className="w-5 h-5"
            style={{
              color: rightAuxOpen
                ? "var(--accent-primary)"
                : pendingApprovalsCount > 0
                  ? "var(--status-warning)"
                  : "var(--text-muted)",
            }}
          />
          {auxBadgeTotal > 0 && (
            <span
              className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono font-bold tabular-nums inline-flex items-center justify-center"
              style={{
                backgroundColor:
                  pendingApprovalsCount > 0
                    ? "var(--status-warning)"
                    : "var(--accent-primary)",
                color: "var(--accent-primary-fg)",
              }}
            >
              {pendingApprovalsCount > 0 ? pendingApprovalsCount : auxBadgeTotal}
            </span>
          )}
        </button>
      </div>
    </header>
  );
};
