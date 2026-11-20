import React, { useMemo, useState } from "react";
import {
  Brain,
  Clock,
  FileCode2,
  FileDiff,
  GitBranch,
  Monitor,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Square,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useZeroG } from "../lib/store";
import { FileChangeDrawer } from "./FileChangeDrawer";
import { ProjectIcon } from "./ProjectIcon";
import { ProviderBadge } from "./ProviderBadge";

export const ProjectsFeedTab: React.FC = () => {
  const {
    loading,
    apiError,
    refreshAll,
    projects,
    sessions,
    selectedProjectId,
    setSelectedProjectId,
    selectedSessionId,
    setSelectedSessionId,
    timelinesBySession,
    artifactsBySession,
    sendSteering,
    cancelWorker,
    outboxItems,
    flushOutboxNow,
    discardOutboxItem,
    setActiveTab,
    wsStatus,
  } = useZeroG();

  const [sourceFilter, setSourceFilter] = useState<"all" | "desktop_hook" | "phone_worker">("all");
  const [showThoughts, setShowThoughts] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [steerInput, setSteerInput] = useState("");
  const [steerStatus, setSteerStatus] = useState<string | null>(null);
  const [sendingSteer, setSendingSteer] = useState(false);

  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      if (selectedProjectId && s.projectId !== selectedProjectId) return false;
      if (sourceFilter !== "all" && s.source !== sourceFilter) return false;
      return true;
    });
  }, [sessions, selectedProjectId, sourceFilter]);

  const activeSession = useMemo(() => {
    return (
      filteredSessions.find((s) => s.id === selectedSessionId) ||
      filteredSessions[0] ||
      sessions[0] ||
      null
    );
  }, [filteredSessions, selectedSessionId, sessions]);

  const activeTimeline = useMemo(() => {
    if (!activeSession) return [];
    const steps = timelinesBySession[activeSession.id] || [];
    return showThoughts ? steps : steps.filter((st) => st.role !== "thought");
  }, [activeSession, timelinesBySession, showThoughts]);

  const activeArtifacts = activeSession
    ? artifactsBySession[activeSession.id] || []
    : [];

  const sessionOutbox = activeSession
    ? outboxItems.filter((item) => item.sessionId === activeSession.id)
    : outboxItems;

  const activeProject =
    projects.find((p) => p.id === (activeSession?.projectId || selectedProjectId)) ||
    projects[0] ||
    null;

  const handleSteerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession || !steerInput.trim()) return;
    setSendingSteer(true);
    setSteerStatus(null);
    try {
      const outcome = await sendSteering(activeSession.id, steerInput);
      setSteerInput("");
      setSteerStatus(
        outcome === "queued"
          ? "Saved offline in IndexedDB outbox — auto-flushes on reconnect."
          : "Steering prompt sent to agent."
      );
    } catch (err) {
      setSteerStatus(
        err instanceof Error ? err.message : "Failed to deliver steering message"
      );
    } finally {
      setSendingSteer(false);
    }
  };

  return (
    <div className="space-y-4">
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
          <span>{apiError}</span>
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry
          </button>
        </div>
      )}

      {/* Project Selector Cards */}
      <section aria-label="Projects" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-sm font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Projects ({projects.length})
          </h2>
          {selectedProjectId && (
            <button
              type="button"
              onClick={() => setSelectedProjectId(null)}
              className="btn-ghost !min-h-[44px] !px-2.5 text-xs"
            >
              Show All
            </button>
          )}
        </div>

        {loading && projects.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="skeleton-shimmer h-20 w-full" />
            <div className="skeleton-shimmer h-20 w-full" />
          </div>
        ) : projects.length === 0 ? (
          <div className="surface-card p-4 flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No local scratch or Video production repositories discovered yet.
            </p>
            <button
              type="button"
              onClick={() => setActiveTab("new")}
              className="btn-primary text-xs shrink-0"
            >
              <Plus className="w-4 h-4" />
              New Worker
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {projects.map((proj) => {
              const selected = selectedProjectId === proj.id;
              const slotCls = `project-slot-${proj.icon || "folder"}`;
              return (
                <button
                  key={proj.id}
                  type="button"
                  onClick={() =>
                    setSelectedProjectId(selected ? null : proj.id)
                  }
                  className={`surface-card ${slotCls} p-3 text-left flex items-center gap-3 w-full min-w-0`}
                  style={{
                    borderColor: selected
                      ? "var(--accent-primary)"
                      : "var(--border-default)",
                  }}
                >
                  <ProjectIcon
                    icon={proj.icon}
                    accentToken={proj.accentToken}
                    size="md"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display text-sm font-bold truncate">
                        {proj.name}
                      </span>
                      {proj.isSeededDemo && (
                        <span
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0"
                          style={{
                            borderColor: "var(--accent-secondary)",
                            color: "var(--accent-secondary)",
                          }}
                        >
                          STUDIO
                        </span>
                      )}
                    </div>
                    <p
                      className="text-xs font-mono truncate"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {proj.path}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-[11px] font-mono tabular-nums" style={{ color: "var(--text-muted)" }}>
                      {proj.gitBranch && (
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="w-3 h-3" />
                          {proj.gitBranch}
                        </span>
                      )}
                      <span>{proj.activeSessions} active</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Unified Desktop + Phone Session Feed */}
      <section aria-label="Unified Session Feed" className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-sm font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Unified Feed
          </h2>
          <div className="flex items-center gap-1.5">
            {(
              [
                { id: "all", label: "All" },
                { id: "desktop_hook", label: "Desktop" },
                { id: "phone_worker", label: "Phone" },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setSourceFilter(f.id)}
                className={
                  sourceFilter === f.id
                    ? "btn-primary !min-h-[44px] !px-3 text-xs"
                    : "btn-secondary !min-h-[44px] !px-3 text-xs"
                }
              >
                {f.id === "desktop_hook" && <Monitor className="w-3.5 h-3.5" />}
                {f.id === "phone_worker" && <Smartphone className="w-3.5 h-3.5" />}
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {loading && sessions.length === 0 ? (
          <div className="space-y-2">
            <div className="skeleton-shimmer h-20 w-full" />
            <div className="skeleton-shimmer h-20 w-full" />
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="surface-card p-6 text-center space-y-3">
            <p className="text-sm font-medium">No sessions in this view</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Start an Antigravity, Claude Code, Codex, or Grok worker from your phone
              or run a tool on your desktop IDE.
            </p>
            <button
              type="button"
              onClick={() => setActiveTab("new")}
              className="btn-primary text-xs"
            >
              <Plus className="w-4 h-4" />
              Spawn New Worker
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredSessions.map((sess) => {
              const isSelected = activeSession?.id === sess.id;
              return (
                <button
                  key={sess.id}
                  type="button"
                  onClick={() => setSelectedSessionId(sess.id)}
                  className="surface-card w-full p-3 text-left space-y-2"
                  style={{
                    borderColor: isSelected
                      ? "var(--accent-primary)"
                      : "var(--border-default)",
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border shrink-0"
                        style={{
                          backgroundColor: "var(--bg-subtle)",
                          borderColor: "var(--border-default)",
                          color: "var(--text-primary)",
                        }}
                      >
                        {sess.source === "desktop_hook" ? (
                          <Monitor className="w-3 h-3" />
                        ) : (
                          <Smartphone className="w-3 h-3" />
                        )}
                        {sess.source === "desktop_hook" ? "Desktop" : "Phone"}
                      </span>
                      <ProviderBadge provider={sess.provider} />
                    </div>
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-mono uppercase"
                      style={{
                        backgroundColor:
                          sess.status === "waiting_approval"
                            ? "var(--status-warning-bg)"
                            : sess.status === "error" || sess.status === "cancelled"
                              ? "var(--status-danger-bg)"
                              : sess.status === "running"
                                ? "var(--status-success-bg)"
                                : "var(--bg-subtle)",
                        color:
                          sess.status === "waiting_approval"
                            ? "var(--status-warning-fg)"
                            : sess.status === "error" || sess.status === "cancelled"
                              ? "var(--status-danger-fg)"
                              : sess.status === "running"
                                ? "var(--status-success-fg)"
                                : "var(--text-muted)",
                      }}
                    >
                      {sess.status.replace("_", " ")}
                    </span>
                  </div>

                  <div className="font-display text-sm font-semibold break-words">
                    {sess.title}
                  </div>

                  <div
                    className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <span>{sess.projectName}</span>
                    <span>step #{sess.stepIdx}</span>
                    <span>{sess.totalTokens.toLocaleString()} tok</span>
                    {sess.worktreeBranch && (
                      <span className="inline-flex items-center gap-1" style={{ color: "var(--accent-secondary)" }}>
                        <GitBranch className="w-3 h-3" />
                        {sess.worktreeBranch}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Active Session Timeline + Steering + Artifacts + Git Drawer Trigger */}
      {activeSession && (
        <section
          aria-label="Active Session Detail"
          className="surface-card p-3.5 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-display text-base font-bold break-words">
                {activeSession.title}
              </h3>
              <p
                className="text-xs font-mono truncate"
                style={{ color: "var(--text-muted)" }}
              >
                {activeSession.worktreePath || activeSession.cwd || activeProject?.path || "workspace"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowThoughts((v) => !v)}
                className={
                  showThoughts ? "btn-primary !px-2.5 text-xs" : "btn-secondary !px-2.5 text-xs"
                }
              >
                <Brain className="w-3.5 h-3.5" />
                Thoughts
              </button>
              <button
                type="button"
                onClick={() => setShowArtifacts((v) => !v)}
                className={
                  showArtifacts ? "btn-primary !px-2.5 text-xs" : "btn-secondary !px-2.5 text-xs"
                }
              >
                <FileCode2 className="w-3.5 h-3.5" />
                Artifacts ({activeArtifacts.length})
              </button>
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="btn-secondary !px-2.5 text-xs"
              >
                <FileDiff className="w-3.5 h-3.5" />
                Changes &amp; Undo
              </button>
              {activeSession.status === "running" && (
                <button
                  type="button"
                  onClick={() => void cancelWorker(activeSession.id)}
                  className="btn-danger !px-2.5 text-xs"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </button>
              )}
            </div>
          </div>

          {showArtifacts && (
            <div className="surface-subtle p-3 space-y-2">
              <div className="text-xs font-semibold">Session Artifacts</div>
              {activeArtifacts.length === 0 ? (
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  No artifacts emitted in this session yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {activeArtifacts.map((art) => (
                    <div
                      key={art.path}
                      className="rounded-[var(--radius-inner)] border p-2 text-xs space-y-1"
                      style={{ borderColor: "var(--border-default)" }}
                    >
                      <div className="font-mono font-semibold">{art.name}</div>
                      {art.preview && (
                        <pre
                          className="font-mono text-[11px] whitespace-pre-wrap break-words"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {art.preview}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Timeline Steps */}
          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {activeTimeline.length === 0 ? (
              <div className="surface-subtle p-4 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                Waiting for redacted agent steps...
              </div>
            ) : (
              activeTimeline.map((step) => (
                <div
                  key={step.id}
                  className="surface-subtle p-2.5 space-y-1 text-xs"
                  style={{
                    borderColor:
                      step.role === "error"
                        ? "var(--status-danger)"
                        : step.role === "user"
                          ? "var(--accent-primary)"
                          : "var(--border-default)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-mono uppercase text-[11px]">
                      <span
                        style={{
                          color:
                            step.role === "user"
                              ? "var(--accent-primary)"
                              : step.role === "thought"
                                ? "var(--accent-secondary)"
                                : step.role === "error"
                                  ? "var(--status-danger)"
                                  : "var(--text-muted)",
                        }}
                      >
                        {step.role}
                        {step.toolName ? ` · ${step.toolName}` : ""}
                      </span>
                      {step.redacted && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: "var(--status-warning-bg)",
                            color: "var(--status-warning-fg)",
                          }}
                        >
                          <ShieldCheck className="w-3 h-3" />
                          REDACTED
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                      #{step.stepIdx}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                    {step.content}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* IndexedDB Offline Outbox Badges */}
          {sessionOutbox.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: "var(--status-warning)" }}>
                  <WifiOff className="w-3.5 h-3.5" />
                  Offline Outbox ({sessionOutbox.length})
                </span>
                <button
                  type="button"
                  onClick={() => void flushOutboxNow()}
                  className="btn-secondary !min-h-[44px] !px-3 text-xs"
                >
                  Flush Now
                </button>
              </div>
              {sessionOutbox.map((item) => (
                <div
                  key={item.clientMsgId}
                  className="rounded-[var(--radius-inner)] border p-2.5 flex items-start justify-between gap-2 text-xs"
                  style={{
                    backgroundColor:
                      item.status === "failed"
                        ? "var(--status-danger-bg)"
                        : "var(--status-warning-bg)",
                    borderColor:
                      item.status === "failed"
                        ? "var(--status-danger)"
                        : "var(--status-warning)",
                  }}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                      <Clock className="w-3 h-3 shrink-0" />
                      <span>
                        {item.status === "failed"
                          ? "Guard Conflict"
                          : "Queued (Guarded by step #" +
                            (item.expectedStepIdx ?? 0) +
                            (item.expectedGitHeadSha
                              ? ` & ${item.expectedGitHeadSha.slice(0, 7)}`
                              : "") +
                            ")"}
                      </span>
                    </div>
                    <p className="break-words">{item.message}</p>
                    {item.errorReason && (
                      <p className="text-[11px]" style={{ color: "var(--status-danger-fg)" }}>
                        {item.errorReason}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void discardOutboxItem(item.clientMsgId)}
                    className="btn-ghost !p-1.5 shrink-0"
                    aria-label="Discard queued message"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Steering Input Box */}
          <form onSubmit={(e) => void handleSteerSubmit(e)} className="space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={steerInput}
                onChange={(e) => setSteerInput(e.target.value)}
                placeholder={
                  wsStatus === "connected"
                    ? "Steer this agent on next turn..."
                    : "Offline — prompt will queue safely in IndexedDB..."
                }
                className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2.5"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
              <button
                type="submit"
                disabled={sendingSteer || !steerInput.trim()}
                className="btn-primary shrink-0"
                aria-label="Send steering prompt"
              >
                <Send className="w-4 h-4" />
                <span className="hidden sm:inline">Steer</span>
              </button>
            </div>
            {steerStatus && (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                {steerStatus}
              </p>
            )}
          </form>
        </section>
      )}

      <FileChangeDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        session={activeSession}
        repoPath={activeProject?.path || ""}
      />
    </div>
  );
};
