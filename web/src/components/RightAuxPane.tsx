import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AtSign,
  Check,
  ChevronLeft,
  Clock,
  ExternalLink,
  FileCode2,
  FileDiff,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Shield,
  Terminal,
  Trash2,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { api, buildPreviewUrl } from "../lib/api";
import { useZeroG } from "../lib/store";
import type {
  AgyArtifactContentResponse,
  AgyArtifactSummary,
  AgyFileEntry,
  AgyFileReadResponse,
  GitStatusResponse,
  RightAuxTab,
} from "../types/contracts";

function folderBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stripAnsi(input: string): string {
  return input
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

interface TerminalLogItem {
  id: string;
  command: string;
  cwd: string;
  returncode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export const RightAuxPane: React.FC = () => {
  const {
    rightAuxOpen,
    setRightAuxOpen,
    rightAuxTab,
    setRightAuxTab,
    focusedArtifactPath,
    setFocusedArtifactPath,
    interfaceLayout,
    activeConversationId,
    setActiveConversationId,
    activeConversationDetail,
    swarmDetail,
    refreshSwarmDetail,
    nudgeConversation,
    sendAgyChatMessage,
    selectedProject,
    selectedProjectPath,
    agyProjects,
    refreshAgyData,
    setComposerDraft,
    devPorts,
    refreshDevPorts,
    selectedPreviewPort,
    setSelectedPreviewPort,
    terminalCwd,
    setTerminalCwd,
    sessions,
    cancelWorker,
    approvals,
    decideApproval,
    macros,
    runMacro,
    outboxItems,
    flushOutboxNow,
    discardOutboxItem,
  } = useZeroG();

  // Tab list based on Interface Layout
  const tabs = useMemo<
    Array<{
      id: RightAuxTab;
      label: string;
      Icon: React.FC<{ className?: string }>;
    }>
  >(() => {
    if (interfaceLayout === "knowledge_work") {
      return [
        { id: "artifacts", label: "Artifacts", Icon: FileCode2 },
        { id: "subagents", label: "Subagents", Icon: Users },
      ];
    }
    return [
      { id: "subagents", label: "Subagents", Icon: Users },
      { id: "files", label: "Files", Icon: FileDiff },
      { id: "preview", label: "Preview", Icon: Globe },
      { id: "artifacts", label: "Artifacts", Icon: FileCode2 },
      { id: "terminal", label: "Terminal", Icon: Terminal },
      { id: "tasks", label: "Tasks", Icon: ListChecks },
    ];
  }, [interfaceLayout]);

  // Subagents & Swarm state
  const [nudgeTargetId, setNudgeTargetId] = useState<string>("");
  const [nudgeText, setNudgeText] = useState<string>("");
  const [nudging, setNudging] = useState(false);
  const [nudgeStatus, setNudgeStatus] = useState<string | null>(null);

  // Files (Changes vs Browse) state
  const [filesMode, setFilesMode] = useState<"changes" | "browse">("changes");
  const [activeFolderOverride, setActiveFolderOverride] = useState<
    string | null
  >(null);
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitMsg, setGitMsg] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const [diffsMap, setDiffsMap] = useState<Record<string, string>>({});
  const [revertingPath, setRevertingPath] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);

  const [browseDir, setBrowseDir] = useState("");
  const [browseEntries, setBrowseEntries] = useState<AgyFileEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [openFile, setOpenFile] = useState<AgyFileReadResponse | null>(null);
  const [readingFile, setReadingFile] = useState(false);

  // Preview state
  const [customPortInput, setCustomPortInput] = useState("");
  const [iframeKey, setIframeKey] = useState(0);
  const [portError, setPortError] = useState<string | null>(null);

  // Artifacts state
  const [selectedArtifact, setSelectedArtifact] =
    useState<AgyArtifactSummary | null>(null);
  const [artifactData, setArtifactData] =
    useState<AgyArtifactContentResponse | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);

  // Terminal state
  const [termCommand, setTermCommand] = useState("");
  const [termRunning, setTermRunning] = useState(false);
  const [termLogs, setTermLogs] = useState<TerminalLogItem[]>([]);

  const projectFolders = useMemo(() => {
    const convPaths =
      activeConversationDetail?.conversation.workspacePaths || [];
    if (selectedProject?.folders && selectedProject.folders.length > 0) {
      return selectedProject.folders;
    }
    if (selectedProject?.path) return [selectedProject.path];
    if (convPaths.length > 0) return convPaths;
    if (selectedProjectPath) return [selectedProjectPath];
    return agyProjects.map((p) => p.path);
  }, [
    activeConversationDetail?.conversation.workspacePaths,
    selectedProject,
    selectedProjectPath,
    agyProjects,
  ]);

  const effectiveRepoPath =
    activeFolderOverride && projectFolders.includes(activeFolderOverride)
      ? activeFolderOverride
      : projectFolders[0] || agyProjects[0]?.path || "";

  // Sync nudge target to activeConversationId
  useEffect(() => {
    if (activeConversationId) {
      setNudgeTargetId(activeConversationId);
    }
  }, [activeConversationId]);

  // Load Git Changes or Browse Directory when Files tab is open
  const loadGit = useCallback(async (repoPath: string) => {
    if (!repoPath) return;
    setGitLoading(true);
    try {
      const st = await api.getGitStatus(repoPath);
      setGitStatus(st);
    } catch (err) {
      setGitStatus(null);
      setGitMsg({
        kind: "err",
        text: err instanceof Error ? err.message : "Failed to inspect Git repo",
      });
    } finally {
      setGitLoading(false);
    }
  }, []);

  const loadBrowse = useCallback(async (repoPath: string, dir: string) => {
    if (!repoPath) return;
    setBrowseLoading(true);
    setOpenFile(null);
    try {
      const res = await api.listAgyFiles(repoPath, dir);
      setBrowseDir(res.dir || dir);
      setBrowseEntries(res.entries || []);
    } catch {
      setBrowseEntries([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!rightAuxOpen || rightAuxTab !== "files" || !effectiveRepoPath) return;
    if (filesMode === "changes") {
      void loadGit(effectiveRepoPath);
    } else {
      void loadBrowse(effectiveRepoPath, "");
    }
  }, [rightAuxOpen, rightAuxTab, filesMode, effectiveRepoPath, loadGit, loadBrowse]);

  // Auto-open focused artifact
  const openArtifactItem = useCallback(
    async (art: AgyArtifactSummary) => {
      if (!activeConversationId) return;
      setSelectedArtifact(art);
      setArtifactLoading(true);
      setArtifactData(null);
      try {
        const res = await api.getAgyArtifact(
          activeConversationId,
          art.relativePath
        );
        setArtifactData(res);
      } catch {
        setArtifactData(null);
      } finally {
        setArtifactLoading(false);
      }
    },
    [activeConversationId]
  );

  useEffect(() => {
    const list = activeConversationDetail?.artifacts || [];
    if (!rightAuxOpen || rightAuxTab !== "artifacts" || list.length === 0) {
      return;
    }
    if (focusedArtifactPath) {
      const target =
        list.find(
          (a) =>
            a.relativePath === focusedArtifactPath ||
            a.name === focusedArtifactPath
        ) || list[0];
      setFocusedArtifactPath(null);
      if (target) {
        void openArtifactItem(target);
      }
    } else if (!selectedArtifact) {
      void openArtifactItem(list[0]);
    }
  }, [
    rightAuxOpen,
    rightAuxTab,
    focusedArtifactPath,
    activeConversationDetail?.artifacts,
    selectedArtifact,
    setFocusedArtifactPath,
    openArtifactItem,
  ]);

  if (!rightAuxOpen) return null;

  const subagents =
    swarmDetail?.subagents || activeConversationDetail?.subagents || [];
  const swarmPlan =
    swarmDetail?.swarmPlan || activeConversationDetail?.swarmPlan || null;
  const boardMessages =
    swarmDetail?.boardMessages ||
    activeConversationDetail?.boardMessages ||
    [];
  const artifacts = activeConversationDetail?.artifacts || [];

  const handleNudgeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = nudgeTargetId || activeConversationId;
    if (!target || !nudgeText.trim() || nudging) return;
    setNudging(true);
    setNudgeStatus(null);
    try {
      await nudgeConversation(target, nudgeText.trim());
      setNudgeText("");
      setNudgeStatus("Message dispatched to agent.");
    } catch (err) {
      setNudgeStatus(
        err instanceof Error ? err.message : "Failed to nudge agent"
      );
    } finally {
      setNudging(false);
    }
  };

  const handleToggleDiff = async (filePath: string) => {
    if (!effectiveRepoPath) return;
    if (expandedDiff === filePath) {
      setExpandedDiff(null);
      return;
    }
    setExpandedDiff(filePath);
    if (!diffsMap[filePath]) {
      try {
        const res = await api.getGitDiff(effectiveRepoPath, filePath);
        setDiffsMap((prev) => ({
          ...prev,
          [filePath]: res.diff || "(No textual diff — binary or untracked file)",
        }));
      } catch (err) {
        setDiffsMap((prev) => ({
          ...prev,
          [filePath]: err instanceof Error ? err.message : "Diff failed",
        }));
      }
    }
  };

  const handleRevertFile = async (filePath: string) => {
    if (!effectiveRepoPath) return;
    setRevertingPath(filePath);
    setGitMsg(null);
    try {
      await api.revertGitFile(effectiveRepoPath, filePath);
      setGitMsg({ kind: "ok", text: `Reverted ${filePath}` });
      setExpandedDiff(null);
      await loadGit(effectiveRepoPath);
      void refreshAgyData();
    } catch (err) {
      setGitMsg({
        kind: "err",
        text: err instanceof Error ? err.message : "Revert failed",
      });
    } finally {
      setRevertingPath(null);
    }
  };

  const handleCommitPush = async (push: boolean) => {
    if (!effectiveRepoPath || !commitMessage.trim() || committing) return;
    setCommitting(true);
    setGitMsg(null);
    try {
      const res = await api.gitCommitAndPush({
        repoPath: effectiveRepoPath,
        message: commitMessage.trim(),
        push,
      });
      if (!res.ok) {
        setGitMsg({
          kind: "err",
          text: res.error || "Git commit/push failed",
        });
      } else {
        const shaShort = res.commitSha ? res.commitSha.slice(0, 7) : "HEAD";
        setGitMsg({
          kind: "ok",
          text: res.pushed
            ? `Committed (${shaShort}) & pushed to ${res.branch || "remote"}.`
            : `Committed (${shaShort}) locally.`,
        });
        setCommitMessage("");
        setDiffsMap({});
        await loadGit(effectiveRepoPath);
        void refreshAgyData();
      }
    } catch (err) {
      setGitMsg({
        kind: "err",
        text: err instanceof Error ? err.message : "Git commit/push failed",
      });
    } finally {
      setCommitting(false);
    }
  };

  const handleReadFile = async (relPath: string) => {
    if (!effectiveRepoPath) return;
    setReadingFile(true);
    try {
      const res = await api.readAgyFile(effectiveRepoPath, relPath);
      setOpenFile(res);
    } catch {
      setOpenFile(null);
    } finally {
      setReadingFile(false);
    }
  };

  const handleMentionFileInChat = (relPath: string) => {
    const token = `@[${relPath}] `;
    setComposerDraft((prev) => {
      if (!prev.trim()) return token;
      return `${prev.trimEnd()} ${token}`;
    });
    if (typeof window !== "undefined" && window.innerWidth < 1280) {
      setRightAuxOpen(false);
    }
  };

  const handleApplyCustomPort = (e: React.FormEvent) => {
    e.preventDefault();
    setPortError(null);
    const num = Number(customPortInput.trim());
    if (!Number.isInteger(num) || num < 1024 || num > 65535 || num === 8790) {
      setPortError("Enter a valid port between 1024 and 65535 (excluding 8790).");
      return;
    }
    setSelectedPreviewPort(num);
    setIframeKey((k) => k + 1);
    setCustomPortInput("");
  };

  const handleRunTerm = async (rawCmd: string) => {
    const cmd = rawCmd.trim();
    if (!cmd || termRunning) return;
    setTermRunning(true);
    const cwd = terminalCwd || effectiveRepoPath || null;
    const id = `t_${Date.now()}`;
    try {
      const res = await api.execAgyTerminal(cmd, cwd);
      setTermLogs((prev) => [
        ...prev,
        {
          id,
          command: cmd,
          cwd: res.cwd || cwd || ".",
          returncode: res.returncode,
          stdout: stripAnsi(res.stdout || ""),
          stderr: stripAnsi(res.stderr || ""),
          durationMs: res.durationMs || 0,
          timedOut: Boolean(res.timedOut),
        },
      ]);
      setTermCommand("");
    } catch (err) {
      setTermLogs((prev) => [
        ...prev,
        {
          id,
          command: cmd,
          cwd: cwd || ".",
          returncode: -1,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          error: err instanceof Error ? err.message : "Execution failed",
        },
      ]);
    } finally {
      setTermRunning(false);
    }
  };

  const breadcrumbs = browseDir
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);

  const paneContent = (
    <div
      className="h-full w-full xl:w-[420px] 2xl:w-[460px] flex flex-col border-l"
      style={{
        backgroundColor: "var(--bg-surface)",
        borderColor: "var(--border-default)",
        color: "var(--text-primary)",
      }}
    >
      {/* Top Tab Strip + Close */}
      <div
        className="px-2 py-1.5 border-b flex items-center justify-between gap-1 shrink-0"
        style={{ borderColor: "var(--border-default)" }}
      >
        <div
          role="tablist"
          aria-label="Auxiliary Pane Views"
          className="flex items-center gap-1 overflow-x-auto min-w-0 flex-1"
        >
          {tabs.map(({ id, label, Icon }) => {
            const active = rightAuxTab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setRightAuxTab(id)}
                className="min-h-[44px] px-2.5 py-1.5 rounded-[var(--radius-inner)] flex items-center gap-1.5 text-xs font-semibold shrink-0 cursor-pointer"
                style={{
                  backgroundColor: active
                    ? "var(--bg-elevated)"
                    : "transparent",
                  color: active
                    ? "var(--accent-primary)"
                    : "var(--text-muted)",
                }}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setRightAuxOpen(false)}
          className="agy-icon-btn shrink-0"
          aria-label="Close auxiliary pane"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* ==================================================================
            TAB 1: SUBAGENTS & SWARM
           ================================================================== */}
        {rightAuxTab === "subagents" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-sm font-bold">
                Subagents &amp; Swarm ({subagents.length})
              </h2>
              {activeConversationId && (
                <button
                  type="button"
                  onClick={() => void refreshSwarmDetail(activeConversationId)}
                  className="btn-secondary !min-h-[44px] !px-2.5 text-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh
                </button>
              )}
            </div>

            {/* Child Subagent Cards */}
            {subagents.length === 0 ? (
              <div className="surface-subtle p-4 text-center text-xs space-y-1">
                <p className="font-semibold">No child subagents in this chat</p>
                <p style={{ color: "var(--text-muted)" }}>
                  Use <code>/teamwork</code> in the composer to spawn a parallel agent swarm.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {subagents.map((sub) => (
                  <div
                    key={sub.id}
                    className="surface-subtle p-2.5 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            sub.status === "running" ? "animate-pulse" : ""
                          }`}
                          style={{
                            backgroundColor:
                              sub.status === "running"
                                ? "var(--status-success)"
                                : "var(--text-muted)",
                          }}
                        />
                        <span className="font-mono text-xs font-bold truncate">
                          {sub.agentName || sub.title}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveConversationId(sub.id)}
                        className="btn-ghost !min-h-[44px] !px-2 text-[11px]"
                      >
                        Open
                      </button>
                    </div>

                    {sub.latestMessage && (
                      <p
                        className="text-[11px] line-clamp-3 break-words"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {sub.latestMessage}
                      </p>
                    )}

                    <div
                      className="text-[10px] font-mono tabular-nums"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {sub.status} · {sub.stepCount} steps
                      {sub.lastStepType ? ` · ${sub.lastStepType}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Swarm Plan Overview */}
            {swarmPlan && (
              <div className="surface-subtle p-2.5 space-y-1.5">
                <div
                  className="text-[11px] font-mono uppercase font-semibold"
                  style={{ color: "var(--accent-secondary)" }}
                >
                  Swarm Plan
                </div>
                <pre
                  className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-44 overflow-y-auto p-2 rounded border"
                  style={{
                    backgroundColor: "var(--bg-canvas)",
                    borderColor: "var(--border-default)",
                  }}
                >
                  {JSON.stringify(swarmPlan, null, 2)}
                </pre>
              </div>
            )}

            {/* Swarm Board Feed */}
            {boardMessages.length > 0 && (
              <div className="space-y-1.5">
                <div
                  className="text-[11px] font-mono uppercase font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  Swarm Board ({boardMessages.length})
                </div>
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {boardMessages.slice(-20).map((bm, i) => (
                    <div
                      key={`${bm.seq ?? i}`}
                      className="surface-subtle p-2 text-xs space-y-0.5"
                    >
                      <div className="flex items-center justify-between font-mono text-[10px]">
                        <span
                          className="font-bold"
                          style={{ color: "var(--accent-primary)" }}
                        >
                          @{bm.agent || bm.sender || "agent"}
                        </span>
                        {bm.seq !== undefined && (
                          <span style={{ color: "var(--text-muted)" }}>
                            #{bm.seq}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] whitespace-pre-wrap break-words">
                        {bm.text || bm.content || ""}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Nudge / Send Message Input */}
            {activeConversationId && (
              <form
                onSubmit={(e) => void handleNudgeSubmit(e)}
                className="surface-subtle p-2.5 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">
                    Nudge / Send Message
                  </span>
                  {subagents.length > 0 && (
                    <select
                      value={nudgeTargetId}
                      onChange={(e) => setNudgeTargetId(e.target.value)}
                      aria-label="Nudge target agent"
                      className="rounded border px-2 py-1 text-base font-mono max-w-[180px]"
                      style={{
                        backgroundColor: "var(--bg-surface)",
                        borderColor: "var(--border-default)",
                        color: "var(--text-primary)",
                      }}
                    >
                      <option value={activeConversationId}>Coordinator</option>
                      {subagents.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.agentName || s.title}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={nudgeText}
                    onChange={(e) => setNudgeText(e.target.value)}
                    placeholder="Send steering or board nudge…"
                    className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2 text-base"
                    style={{
                      backgroundColor: "var(--bg-surface)",
                      borderColor: "var(--border-default)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <button
                    type="submit"
                    disabled={nudging || !nudgeText.trim()}
                    className="btn-primary !min-h-[44px] !px-3 text-xs shrink-0"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>

                {nudgeStatus && (
                  <p
                    className="text-[11px]"
                    style={{ color: "var(--accent-secondary)" }}
                  >
                    {nudgeStatus}
                  </p>
                )}
              </form>
            )}
          </div>
        )}

        {/* ==================================================================
            TAB 2: FILES (CHANGES vs READ-ONLY BROWSE)
           ================================================================== */}
        {rightAuxTab === "files" && (
          <div className="space-y-3">
            {/* Folder Selector (when Multi-Folder Project) */}
            {projectFolders.length > 1 && (
              <select
                value={effectiveRepoPath}
                onChange={(e) => setActiveFolderOverride(e.target.value)}
                aria-label="Active project folder"
                className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-base font-mono"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                {projectFolders.map((f) => (
                  <option key={f} value={f}>
                    {folderBasename(f)} — {f}
                  </option>
                ))}
              </select>
            )}

            {/* Toggle: Changes vs Browse */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setFilesMode("changes")}
                className={
                  filesMode === "changes"
                    ? "btn-primary !min-h-[44px] text-xs"
                    : "btn-secondary !min-h-[44px] text-xs"
                }
              >
                <FileDiff className="w-4 h-4" />
                <span>
                  Changes
                  {gitStatus && gitStatus.files.length > 0
                    ? ` (${gitStatus.files.length})`
                    : ""}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setFilesMode("browse")}
                className={
                  filesMode === "browse"
                    ? "btn-primary !min-h-[44px] text-xs"
                    : "btn-secondary !min-h-[44px] text-xs"
                }
              >
                <Folder className="w-4 h-4" />
                <span>Browse</span>
              </button>
            </div>

            {filesMode === "changes" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div
                    className="inline-flex items-center gap-1.5 text-xs font-mono truncate"
                    style={{ color: "var(--accent-secondary)" }}
                  >
                    <GitBranch className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {gitStatus?.branch || "repo"}
                      {gitStatus?.headSha
                        ? ` · ${gitStatus.headSha.slice(0, 7)}`
                        : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={gitLoading}
                    onClick={() => void loadGit(effectiveRepoPath)}
                    className="btn-secondary !min-h-[44px] !px-2.5 text-xs shrink-0"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        gitLoading ? "animate-spin" : ""
                      }`}
                    />
                    Refresh
                  </button>
                </div>

                {gitMsg && (
                  <div
                    className="rounded-[var(--radius-inner)] border p-2.5 text-xs"
                    style={{
                      backgroundColor:
                        gitMsg.kind === "ok"
                          ? "var(--status-success-bg)"
                          : "var(--status-danger-bg)",
                      borderColor:
                        gitMsg.kind === "ok"
                          ? "var(--status-success)"
                          : "var(--status-danger)",
                      color:
                        gitMsg.kind === "ok"
                          ? "var(--status-success-fg)"
                          : "var(--status-danger-fg)",
                    }}
                  >
                    {gitMsg.text}
                  </div>
                )}

                {/* Commit & Push Bar */}
                <div className="surface-subtle p-2.5 space-y-2">
                  <input
                    type="text"
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    placeholder="Commit message…"
                    aria-label="Git commit message"
                    className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-base"
                    style={{
                      backgroundColor: "var(--bg-surface)",
                      borderColor: "var(--border-default)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={
                        committing ||
                        !commitMessage.trim() ||
                        !gitStatus ||
                        gitStatus.files.length === 0
                      }
                      onClick={() => void handleCommitPush(false)}
                      className="btn-secondary !min-h-[44px] text-xs"
                    >
                      <GitCommitHorizontal className="w-4 h-4 shrink-0" />
                      <span>Commit</span>
                    </button>
                    <button
                      type="button"
                      disabled={
                        committing ||
                        !commitMessage.trim() ||
                        !gitStatus ||
                        gitStatus.files.length === 0
                      }
                      onClick={() => void handleCommitPush(true)}
                      className="btn-primary !min-h-[44px] text-xs"
                    >
                      <UploadCloud className="w-4 h-4 shrink-0" />
                      <span>{committing ? "Working…" : "Commit & Push"}</span>
                    </button>
                  </div>
                </div>

                {/* Modified Files + Unified Diffs + Revert */}
                {gitLoading ? (
                  <div className="skeleton-shimmer h-20 w-full" />
                ) : !gitStatus || gitStatus.files.length === 0 ? (
                  <div className="surface-subtle p-5 text-center text-xs">
                    <span style={{ color: "var(--text-muted)" }}>
                      Working tree is clean.
                    </span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {gitStatus.files.map((f) => {
                      const isExp = expandedDiff === f.path;
                      const diffBody = diffsMap[f.path] || "";
                      return (
                        <div
                          key={f.path}
                          className="surface-subtle overflow-hidden"
                        >
                          <div className="p-1.5 flex items-center justify-between gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleToggleDiff(f.path)}
                              className="flex-1 min-w-0 min-h-[44px] px-1.5 flex items-center gap-2 text-left"
                            >
                              <span
                                className="font-mono text-[11px] px-1.5 py-0.5 rounded border shrink-0"
                                style={{
                                  borderColor: "var(--border-default)",
                                  color: "var(--accent-secondary)",
                                }}
                              >
                                {f.status}
                              </span>
                              <span className="font-mono text-xs truncate">
                                {f.path}
                              </span>
                            </button>

                            <button
                              type="button"
                              disabled={revertingPath === f.path}
                              onClick={() => void handleRevertFile(f.path)}
                              className="btn-secondary !min-h-[44px] !px-2.5 text-xs shrink-0"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Revert</span>
                            </button>
                          </div>

                          {isExp && (
                            <pre
                              className="p-2.5 text-[11px] font-mono overflow-x-auto max-h-60 border-t leading-relaxed"
                              style={{
                                backgroundColor: "var(--bg-canvas)",
                                borderColor: "var(--border-default)",
                              }}
                            >
                              {diffBody.split("\n").map((line, idx) => {
                                const add =
                                  line.startsWith("+") &&
                                  !line.startsWith("+++");
                                const del =
                                  line.startsWith("-") &&
                                  !line.startsWith("---");
                                return (
                                  <div
                                    key={idx}
                                    style={{
                                      backgroundColor: add
                                        ? "var(--diff-add-bg)"
                                        : del
                                          ? "var(--diff-del-bg)"
                                          : "transparent",
                                      color: add
                                        ? "var(--diff-add-fg)"
                                        : del
                                          ? "var(--diff-del-fg)"
                                          : "var(--text-primary)",
                                    }}
                                  >
                                    {line || " "}
                                  </div>
                                );
                              })}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              /* Read-Only File Browser */
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-1 text-xs font-mono">
                  <button
                    type="button"
                    onClick={() => void loadBrowse(effectiveRepoPath, "")}
                    className="btn-ghost !min-h-[44px] !px-2 text-xs font-mono"
                    style={{ color: "var(--accent-primary)" }}
                  >
                    {folderBasename(effectiveRepoPath || "root")}
                  </button>
                  {breadcrumbs.map((seg, i) => {
                    const target = breadcrumbs.slice(0, i + 1).join("/");
                    return (
                      <React.Fragment key={target}>
                        <span style={{ color: "var(--text-muted)" }}>/</span>
                        <button
                          type="button"
                          onClick={() =>
                            void loadBrowse(effectiveRepoPath, target)
                          }
                          className="btn-ghost !min-h-[44px] !px-2 text-xs font-mono"
                        >
                          {seg}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>

                {readingFile ? (
                  <div className="skeleton-shimmer h-44 w-full" />
                ) : openFile ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold truncate">
                        {openFile.path}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setOpenFile(null)}
                          className="btn-secondary !min-h-[44px] !px-2.5 text-xs"
                        >
                          <ChevronLeft className="w-4 h-4" />
                          Back
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMentionFileInChat(openFile.path)}
                          className="btn-primary !min-h-[44px] !px-3 text-xs"
                        >
                          <AtSign className="w-3.5 h-3.5" />
                          <span>Mention in Chat</span>
                        </button>
                      </div>
                    </div>

                    <div
                      className="rounded-[var(--radius-inner)] border overflow-x-auto max-h-[55vh]"
                      style={{
                        backgroundColor: "var(--bg-canvas)",
                        borderColor: "var(--border-default)",
                      }}
                    >
                      <table className="w-full border-collapse font-mono text-[11px] leading-relaxed">
                        <tbody>
                          {openFile.content.split("\n").map((ln, idx) => (
                            <tr key={idx}>
                              <td
                                className="select-none px-2 py-0.5 text-right tabular-nums border-r w-9"
                                style={{
                                  color: "var(--text-muted)",
                                  borderColor: "var(--border-default)",
                                }}
                              >
                                {idx + 1}
                              </td>
                              <td className="px-2.5 py-0.5 whitespace-pre">
                                {ln || " "}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : browseLoading ? (
                  <div className="skeleton-shimmer h-20 w-full" />
                ) : (
                  <div className="space-y-1">
                    {browseEntries.map((entry) => (
                      <button
                        key={entry.relPath}
                        type="button"
                        onClick={() => {
                          if (entry.isDir) {
                            void loadBrowse(effectiveRepoPath, entry.relPath);
                          } else {
                            void handleReadFile(entry.relPath);
                          }
                        }}
                        className="surface-subtle w-full min-h-[44px] px-3 py-1.5 flex items-center justify-between gap-2 text-left text-xs font-mono"
                      >
                        <span className="inline-flex items-center gap-2 min-w-0 truncate">
                          {entry.isDir ? (
                            <Folder
                              className="w-4 h-4 shrink-0"
                              style={{ color: "var(--accent-secondary)" }}
                            />
                          ) : (
                            <FileCode2
                              className="w-4 h-4 shrink-0"
                              style={{ color: "var(--text-muted)" }}
                            />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </span>
                        <span
                          className="text-[10px] shrink-0"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {entry.isDir ? "DIR" : formatBytes(entry.sizeBytes)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ==================================================================
            TAB 3: PREVIEW (LIVE LOCALHOST REVERSE PROXY)
           ================================================================== */}
        {rightAuxTab === "preview" && (
          <div className="space-y-3 flex flex-col h-full">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-sm font-bold">
                Live Localhost Preview
              </h2>
              <button
                type="button"
                onClick={() => void refreshDevPorts()}
                className="btn-secondary !min-h-[44px] !px-2.5 text-xs"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Scan Ports
              </button>
            </div>

            {/* Active Port Chips */}
            {devPorts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {devPorts.map((dp) => {
                  const active = selectedPreviewPort === dp.port;
                  return (
                    <button
                      key={dp.port}
                      type="button"
                      onClick={() => {
                        setSelectedPreviewPort(dp.port);
                        setIframeKey((k) => k + 1);
                      }}
                      className={
                        active
                          ? "btn-primary !min-h-[44px] !px-3 text-xs font-mono"
                          : "btn-secondary !min-h-[44px] !px-3 text-xs font-mono"
                      }
                    >
                      :{dp.port}
                      {dp.label ? ` · ${dp.label}` : ""}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Custom Port Form */}
            <form
              onSubmit={handleApplyCustomPort}
              className="flex items-center gap-2"
            >
              <input
                type="number"
                min={1024}
                max={65535}
                value={customPortInput}
                onChange={(e) => setCustomPortInput(e.target.value)}
                placeholder="Custom port (1024–65535)"
                aria-label="Custom localhost port"
                className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2 text-base font-mono"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
              <button
                type="submit"
                className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
              >
                Open
              </button>
            </form>

            {portError && (
              <p
                className="text-xs"
                style={{ color: "var(--status-danger-fg)" }}
              >
                {portError}
              </p>
            )}

            {selectedPreviewPort ? (
              <div className="space-y-2 flex-1 flex flex-col min-h-[380px]">
                <div className="surface-subtle px-2.5 py-1.5 flex items-center justify-between gap-2">
                  <code
                    className="text-xs font-mono truncate"
                    style={{ color: "var(--accent-secondary)" }}
                  >
                    localhost:{selectedPreviewPort}
                  </code>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setIframeKey((k) => k + 1)}
                      className="btn-ghost !min-h-[44px] !px-2.5 text-xs"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Refresh
                    </button>
                    <a
                      href={buildPreviewUrl(selectedPreviewPort)}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-secondary !min-h-[44px] !px-2.5 text-xs no-underline"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Open Full Tab
                    </a>
                  </div>
                </div>

                <iframe
                  key={`${selectedPreviewPort}-${iframeKey}`}
                  title={`Localhost Port ${selectedPreviewPort} Preview`}
                  src={buildPreviewUrl(selectedPreviewPort)}
                  className="w-full flex-1 min-h-[360px] rounded-[var(--radius-inner)] border"
                  style={{
                    backgroundColor: "var(--bg-canvas)",
                    borderColor: "var(--border-default)",
                  }}
                />
              </div>
            ) : (
              <div className="surface-subtle p-6 text-center text-xs space-y-1">
                <p className="font-semibold">No dev server port selected</p>
                <p style={{ color: "var(--text-muted)" }}>
                  Start a dev server (e.g. <code>5173</code> or <code>3000</code>) on your laptop or enter its port above to preview it live over Cloudflare Tunnel.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ==================================================================
            TAB 4: ARTIFACTS
           ================================================================== */}
        {rightAuxTab === "artifacts" && (
          <div className="space-y-3">
            <h2 className="font-display text-sm font-bold">
              Conversation Artifacts ({artifacts.length})
            </h2>

            {artifacts.length === 0 ? (
              <div className="surface-subtle p-5 text-center text-xs space-y-1">
                <p className="font-semibold">No artifacts in this chat yet</p>
                <p style={{ color: "var(--text-muted)" }}>
                  Implementation plans, walkthroughs, and visual outputs appear here automatically.
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {artifacts.map((art) => {
                    const active =
                      selectedArtifact?.relativePath === art.relativePath;
                    return (
                      <button
                        key={art.relativePath}
                        type="button"
                        onClick={() => void openArtifactItem(art)}
                        className={
                          active
                            ? "btn-primary !min-h-[44px] !px-3 text-xs font-mono"
                            : "btn-secondary !min-h-[44px] !px-3 text-xs font-mono"
                        }
                      >
                        {art.kind === "image" ? (
                          <ImageIcon className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <FileCode2 className="w-3.5 h-3.5 shrink-0" />
                        )}
                        <span className="truncate max-w-[160px]">
                          {art.name}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {artifactLoading ? (
                  <div className="skeleton-shimmer h-48 w-full" />
                ) : artifactData ? (
                  <div className="surface-subtle p-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold truncate">
                        {artifactData.name}
                      </span>
                      {activeConversationId &&
                        /plan/i.test(artifactData.name) && (
                          <button
                            type="button"
                            onClick={() =>
                              void sendAgyChatMessage(
                                activeConversationId,
                                "Proceed with the plan."
                              )
                            }
                            className="btn-primary !min-h-[44px] !px-3.5 text-xs"
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>Proceed</span>
                          </button>
                        )}
                    </div>

                    {artifactData.dataUri ? (
                      <img
                        src={artifactData.dataUri}
                        alt={artifactData.name}
                        className="w-full rounded-[var(--radius-inner)] border object-contain"
                        style={{ borderColor: "var(--border-default)" }}
                      />
                    ) : artifactData.kind === "html" && artifactData.content ? (
                      <iframe
                        title={artifactData.name}
                        srcDoc={artifactData.content}
                        sandbox="allow-scripts"
                        className="w-full h-80 rounded-[var(--radius-inner)] border"
                        style={{
                          backgroundColor: "var(--bg-canvas)",
                          borderColor: "var(--border-default)",
                        }}
                      />
                    ) : (
                      <pre
                        className="p-3 rounded-[var(--radius-inner)] border font-mono text-xs whitespace-pre-wrap break-words overflow-x-auto max-h-[56vh] leading-relaxed"
                        style={{
                          backgroundColor: "var(--bg-canvas)",
                          borderColor: "var(--border-default)",
                        }}
                      >
                        {artifactData.content || "(Empty artifact)"}
                      </pre>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}

        {/* ==================================================================
            TAB 5: TERMINAL
           ================================================================== */}
        {rightAuxTab === "terminal" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-sm font-bold">Host Terminal</h2>
              {termLogs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTermLogs([])}
                  className="btn-secondary !min-h-[44px] !px-2.5 text-xs"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear
                </button>
              )}
            </div>

            <select
              value={terminalCwd || effectiveRepoPath}
              onChange={(e) => setTerminalCwd(e.target.value || null)}
              aria-label="Terminal working directory"
              className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-base font-mono"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
            >
              {agyProjects.map((p) => (
                <option key={p.id} value={p.path}>
                  {p.name} — {p.path}
                </option>
              ))}
            </select>

            <div className="flex flex-wrap gap-1.5">
              {["git status -sb", "pytest", "npm run build"].map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={termRunning}
                  onClick={() => void handleRunTerm(chip)}
                  className="btn-secondary !min-h-[44px] !px-3 text-xs font-mono"
                >
                  {chip}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleRunTerm(termCommand);
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={termCommand}
                onChange={(e) => setTermCommand(e.target.value)}
                placeholder="Run shell command…"
                aria-label="Terminal command"
                className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2 text-base font-mono"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
              <button
                type="submit"
                disabled={termRunning || !termCommand.trim()}
                className="btn-primary !min-h-[44px] !px-3.5 text-xs shrink-0"
              >
                <Play className="w-4 h-4" />
                <span>{termRunning ? "…" : "Run"}</span>
              </button>
            </form>

            <div className="space-y-2">
              {termLogs.map((entry) => {
                const ok =
                  entry.returncode === 0 && !entry.error && !entry.timedOut;
                return (
                  <div
                    key={entry.id}
                    className="surface-subtle p-2.5 font-mono text-xs space-y-1.5"
                    style={{
                      borderColor: ok
                        ? "var(--border-default)"
                        : "var(--status-danger)",
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold break-all">
                        $ {entry.command}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor: ok
                            ? "var(--status-success-bg)"
                            : "var(--status-danger-bg)",
                          color: ok
                            ? "var(--status-success-fg)"
                            : "var(--status-danger-fg)",
                        }}
                      >
                        exit {entry.returncode}
                      </span>
                    </div>
                    {entry.stdout && (
                      <pre className="whitespace-pre-wrap break-words text-[11px] max-h-56 overflow-y-auto">
                        {entry.stdout}
                      </pre>
                    )}
                    {entry.stderr && (
                      <pre
                        className="whitespace-pre-wrap break-words text-[11px] max-h-44 overflow-y-auto"
                        style={{ color: "var(--status-danger-fg)" }}
                      >
                        {entry.stderr}
                      </pre>
                    )}
                    {entry.error && (
                      <div style={{ color: "var(--status-danger-fg)" }}>
                        {entry.error}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 6: TASKS (SESSIONS, APPROVALS AUDIT & MACROS)
           ================================================================== */}
        {rightAuxTab === "tasks" && (
          <div className="space-y-4">
            {/* Offline Outbox */}
            {outboxItems.length > 0 && (
              <section className="surface-subtle p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold">
                    Offline Outbox ({outboxItems.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => void flushOutboxNow()}
                    className="btn-secondary !min-h-[44px] !px-2.5 text-xs"
                  >
                    Sync Now
                  </button>
                </div>
                {outboxItems.map((ob) => (
                  <div
                    key={ob.clientMsgId}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate">{ob.message}</span>
                    <button
                      type="button"
                      onClick={() => void discardOutboxItem(ob.clientMsgId)}
                      className="agy-icon-btn"
                      aria-label="Discard queued message"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </section>
            )}

            {/* Background Sessions */}
            <section className="space-y-1.5">
              <h3
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Active Hook Sessions ({sessions.length})
              </h3>
              {sessions.length === 0 ? (
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  No background hook sessions recorded.
                </p>
              ) : (
                sessions.slice(0, 8).map((s) => (
                  <div
                    key={s.id}
                    className="surface-subtle p-2.5 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">
                        {s.title}
                      </div>
                      <div
                        className="text-[10px] font-mono"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {s.status} · step #{s.stepIdx}
                      </div>
                    </div>
                    {s.status === "running" && (
                      <button
                        type="button"
                        onClick={() => void cancelWorker(s.id)}
                        className="btn-danger !min-h-[44px] !px-2.5 text-xs shrink-0"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                ))
              )}
            </section>

            {/* Approvals Audit */}
            <section className="space-y-1.5">
              <h3
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Approvals Audit ({approvals.length})
              </h3>
              {approvals.length === 0 ? (
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  No permission holds logged yet.
                </p>
              ) : (
                approvals.slice(0, 10).map((a) => (
                  <div
                    key={a.id}
                    className="surface-subtle p-2.5 space-y-1 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold truncate">
                        <Shield className="w-3 h-3 inline mr-1" />
                        {a.toolName}
                      </span>
                      <span
                        className="font-mono text-[10px] uppercase"
                        style={{
                          color:
                            a.status === "pending"
                              ? "var(--status-warning)"
                              : a.status === "denied" ||
                                  a.status === "auto_denied"
                                ? "var(--status-danger)"
                                : "var(--status-success)",
                        }}
                      >
                        {a.status}
                      </span>
                    </div>
                    <div
                      className="font-mono text-[11px] truncate"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {a.commandPreview}
                    </div>
                    {a.status === "pending" && (
                      <div className="grid grid-cols-2 gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() =>
                            void decideApproval(a.id, { action: "approve" })
                          }
                          className="btn-primary !min-h-[44px] text-xs"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Allow
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void decideApproval(a.id, { action: "deny" })
                          }
                          className="btn-danger !min-h-[44px] text-xs"
                        >
                          Deny
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </section>

            {/* Quick Macros */}
            {macros.length > 0 && (
              <section className="space-y-1.5">
                <h3
                  className="text-xs font-semibold uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}
                >
                  Host Macros
                </h3>
                <div className="space-y-1.5">
                  {macros.map((m) => (
                    <div
                      key={m.id}
                      className="surface-subtle p-2 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">
                          {m.name}
                        </div>
                        <div
                          className="text-[10px] font-mono truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {m.command}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void runMacro(m.id)}
                        className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
                      >
                        <Clock className="w-3.5 h-3.5" />
                        Run
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Docked Pane */}
      <aside
        aria-label="Antigravity Auxiliary Pane"
        className="hidden xl:flex h-full shrink-0"
      >
        {paneContent}
      </aside>

      {/* Mobile / Tablet Slide-Over Drawer */}
      <div
        className="fixed inset-0 z-40 flex justify-end xl:hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Auxiliary Pane Drawer"
      >
        <div
          className="fixed inset-0"
          style={{ backgroundColor: "var(--overlay-scrim)" }}
          onClick={() => setRightAuxOpen(false)}
          aria-hidden="true"
        />
        <div className="relative z-10 h-full w-full max-w-md">{paneContent}</div>
      </div>
    </>
  );
};
