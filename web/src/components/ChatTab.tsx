import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AtSign,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Cpu,
  FileCode2,
  Folder,
  FolderUp,
  History,
  Image as ImageIcon,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Slash,
  Sparkles,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { useZeroG } from "../lib/store";
import type {
  AgyArtifactContentResponse,
  AgyArtifactSummary,
  AgyConversationDetail,
  AgyConversationSummary,
  AgyCustomizationEntry,
  AgyFileEntry,
  AgyMessage,
} from "../types/contracts";

const SLASH_PRESETS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/plan ", desc: "Create a step-by-step implementation plan" },
  { cmd: "/grill-me ", desc: "Interactive design & trade-off interview" },
  { cmd: "/boost ", desc: "Maximum depth & thoroughness mode" },
  { cmd: "/teamwork ", desc: "Multi-agent swarm collaboration" },
  { cmd: "/goal ", desc: "Autonomous goal loop until complete" },
  { cmd: "/browser ", desc: "Run browser inspection & verification" },
  { cmd: "/compact ", desc: "Summarize context to free window" },
  { cmd: "/schedule ", desc: "Set up a recurring or timed task" },
  { cmd: "/learn ", desc: "Capture lesson or setup for future runs" },
];

const MODEL_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Auto", value: "" },
  { label: "Gemini 4 Carbon (High)", value: "Gemini 4 Carbon (High)" },
  { label: "Gemini 4 Hydrogen (High)", value: "Gemini 4 Hydrogen (High)" },
  { label: "Gemini 4 Argon (High)", value: "Gemini 4 Argon (High)" },
  { label: "Gemini 3.8 Flash (High)", value: "Gemini 3.8 Flash (High)" },
  { label: "Pro", value: "Pro" },
  { label: "Flash", value: "Flash" },
];

function basename(pathStr?: string | null): string {
  if (!pathStr) return "";
  const parts = pathStr.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || pathStr;
}

function formatRelativeTime(tsSec?: number | null): string {
  if (!tsSec) return "";
  const ms = tsSec > 1e12 ? tsSec : tsSec * 1000;
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function getStatusPillStyle(status: AgyConversationSummary["status"]) {
  if (status === "running") {
    return {
      bg: "var(--status-success-bg)",
      fg: "var(--status-success-fg)",
      border: "var(--status-success)",
      label: "Running",
    };
  }
  if (status === "killed") {
    return {
      bg: "var(--status-danger-bg)",
      fg: "var(--status-danger-fg)",
      border: "var(--status-danger)",
      label: "Killed",
    };
  }
  return {
    bg: "var(--bg-subtle)",
    fg: "var(--text-muted)",
    border: "var(--border-default)",
    label: "Idle",
  };
}

function renderMessageBlocks(text: string): React.ReactNode {
  if (!text) return null;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const inner = part.slice(3, -3);
      const newlineIdx = inner.indexOf("\n");
      const lang = newlineIdx > -1 ? inner.slice(0, newlineIdx).trim() : "";
      const code = newlineIdx > -1 ? inner.slice(newlineIdx + 1) : inner;
      return (
        <div
          key={idx}
          className="my-2 rounded-[var(--radius-inner)] border overflow-hidden"
          style={{
            backgroundColor: "var(--bg-canvas)",
            borderColor: "var(--border-default)",
          }}
        >
          {lang && (
            <div
              className="px-2.5 py-1 text-[10px] font-mono uppercase border-b"
              style={{
                color: "var(--text-muted)",
                borderColor: "var(--border-default)",
              }}
            >
              {lang}
            </div>
          )}
          <pre className="p-2.5 text-xs font-mono overflow-x-auto leading-relaxed">
            {code}
          </pre>
        </div>
      );
    }
    return (
      <div key={idx} className="whitespace-pre-wrap break-words leading-relaxed">
        {part}
      </div>
    );
  });
}

const MessageBubble: React.FC<{ msg: AgyMessage }> = ({ msg }) => {
  const [showThinking, setShowThinking] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>({});
  const isUser = msg.role === "user";

  const toggleTool = (idx: number) => {
    setExpandedTools((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  return (
    <div
      className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}
    >
      <div
        className={`w-full sm:max-w-[88%] rounded-[var(--radius-outer)] border p-3 space-y-2 ${
          isUser ? "ml-auto" : ""
        }`}
        style={{
          backgroundColor: isUser ? "var(--bg-elevated)" : "var(--bg-surface)",
          borderColor: isUser ? "var(--accent-primary)" : "var(--border-default)",
        }}
      >
        {/* Turn header */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-1.5 min-w-0">
            {isUser ? (
              <span
                className="font-semibold"
                style={{ color: "var(--accent-primary)" }}
              >
                You
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 font-semibold"
                style={{ color: "var(--accent-secondary)" }}
              >
                <Bot className="w-3.5 h-3.5 shrink-0" />
                Antigravity
              </span>
            )}
            {msg.model && !isUser && (
              <span
                className="font-mono px-1.5 py-0.5 rounded border text-[10px] truncate max-w-[160px]"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-muted)",
                }}
              >
                {msg.model}
              </span>
            )}
          </div>
          <span
            className="font-mono tabular-nums shrink-0"
            style={{ color: "var(--text-muted)" }}
          >
            #{msg.stepIndex}
            {msg.createdAt ? ` · ${formatRelativeTime(msg.createdAt)}` : ""}
          </span>
        </div>

        {/* Collapsible Thinking */}
        {msg.thinking && (
          <div
            className="rounded-[var(--radius-inner)] border overflow-hidden"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
            }}
          >
            <button
              type="button"
              onClick={() => setShowThinking((v) => !v)}
              className="w-full min-h-[44px] px-3 py-2 flex items-center justify-between gap-2 text-xs font-medium text-left"
              style={{ color: "var(--accent-secondary)" }}
            >
              <span className="inline-flex items-center gap-1.5">
                <Brain className="w-3.5 h-3.5 shrink-0" />
                Thinking
              </span>
              {showThinking ? (
                <ChevronDown className="w-4 h-4 shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 shrink-0" />
              )}
            </button>
            {showThinking && (
              <div
                className="px-3 pb-3 pt-1 text-xs whitespace-pre-wrap break-words border-t leading-relaxed max-h-64 overflow-y-auto"
                style={{
                  borderColor: "var(--border-default)",
                  color: "var(--text-muted)",
                }}
              >
                {msg.thinking}
              </div>
            )}
          </div>
        )}

        {/* Expandable Tool Calls */}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {msg.toolCalls.map((tc, i) => {
              const isOpen = Boolean(expandedTools[i]);
              return (
                <div
                  key={`${msg.id}-tc-${i}`}
                  className="rounded-[var(--radius-inner)] border overflow-hidden"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-default)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleTool(i)}
                    className="w-full min-h-[44px] px-2.5 py-1.5 flex items-center justify-between gap-2 text-left text-xs"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Wrench
                        className="w-3.5 h-3.5 shrink-0"
                        style={{ color: "var(--accent-primary)" }}
                      />
                      <span className="font-mono font-semibold shrink-0">
                        {tc.name}
                      </span>
                      {tc.summary && (
                        <span
                          className="truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {tc.summary}
                        </span>
                      )}
                    </div>
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 shrink-0" />
                    )}
                  </button>
                  {isOpen && (
                    <div
                      className="px-2.5 pb-2.5 pt-2 border-t space-y-2 text-xs"
                      style={{ borderColor: "var(--border-default)" }}
                    >
                      {tc.argsPreview && (
                        <div>
                          <div
                            className="text-[10px] font-mono uppercase mb-1"
                            style={{ color: "var(--text-muted)" }}
                          >
                            Arguments
                          </div>
                          <pre
                            className="p-2 rounded border font-mono text-[11px] overflow-x-auto max-h-40 whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor: "var(--bg-canvas)",
                              borderColor: "var(--border-default)",
                            }}
                          >
                            {tc.argsPreview}
                          </pre>
                        </div>
                      )}
                      {tc.outputPreview && (
                        <div>
                          <div
                            className="text-[10px] font-mono uppercase mb-1"
                            style={{ color: "var(--text-muted)" }}
                          >
                            Output
                          </div>
                          <pre
                            className="p-2 rounded border font-mono text-[11px] overflow-x-auto max-h-48 whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor: "var(--bg-canvas)",
                              borderColor: "var(--border-default)",
                            }}
                          >
                            {tc.outputPreview}
                          </pre>
                        </div>
                      )}
                      {!tc.argsPreview && !tc.outputPreview && (
                        <p style={{ color: "var(--text-muted)" }}>
                          No additional tool output recorded.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Main Content */}
        {msg.content && (
          <div className="text-sm">{renderMessageBlocks(msg.content)}</div>
        )}
      </div>
    </div>
  );
};

export const ChatTab: React.FC = () => {
  const {
    loading,
    apiError,
    agyProjects,
    agyConversations,
    activeConversationId,
    setActiveConversationId,
    activeConversationDetail,
    agyConversationLoading,
    agyError,
    selectedProjectPath,
    customizations,
    composerDraft,
    setComposerDraft,
    pendingNewChatOpen,
    setPendingNewChatOpen,
    refreshAgyData,
    loadAgyConversationDetail,
    startNewAgyConversation,
    sendAgyChatMessage,
  } = useZeroG();

  // Drawers / sheets
  const [showConvDrawer, setShowConvDrawer] = useState(false);
  const [convSearch, setConvSearch] = useState("");
  const [convFilter, setConvFilter] = useState<"all" | "project" | "running">(
    "all"
  );

  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [newWorkspacePath, setNewWorkspacePath] = useState<string>("");
  const [newModel, setNewModel] = useState<string>("");
  const [newTitle, setNewTitle] = useState<string>("");
  const [newPrompt, setNewPrompt] = useState<string>("");
  const [creatingChat, setCreatingChat] = useState(false);
  const [newChatError, setNewChatError] = useState<string | null>(null);

  const [showSwarmDrawer, setShowSwarmDrawer] = useState(false);
  const [inspectSubagent, setInspectSubagent] =
    useState<AgyConversationDetail | null>(null);
  const [loadingSubagent, setLoadingSubagent] = useState(false);

  const [viewingArtifact, setViewingArtifact] =
    useState<AgyArtifactSummary | null>(null);
  const [artifactContent, setArtifactContent] =
    useState<AgyArtifactContentResponse | null>(null);
  const [loadingArtifact, setLoadingArtifact] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);

  // Composer pickers
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionDir, setMentionDir] = useState("");
  const [mentionEntries, setMentionEntries] = useState<AgyFileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");

  const [sendingMsg, setSendingMsg] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);

  // Handle "+ New Chat Here" triggered from Projects tab
  useEffect(() => {
    if (pendingNewChatOpen) {
      setNewWorkspacePath(selectedProjectPath || agyProjects[0]?.path || "");
      setShowNewChatModal(true);
      setPendingNewChatOpen(false);
    }
  }, [pendingNewChatOpen, selectedProjectPath, agyProjects, setPendingNewChatOpen]);

  // Keep New Chat workspace synced when opened
  const openNewChatSheet = () => {
    setNewWorkspacePath(
      selectedProjectPath ||
        activeConversationDetail?.conversation.workspacePaths?.[0] ||
        agyProjects[0]?.path ||
        ""
    );
    setNewChatError(null);
    setShowNewChatModal(true);
  };

  // Auto-grow composer textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(44, el.scrollHeight))}px`;
  }, [composerDraft]);

  const activeConv =
    activeConversationDetail?.conversation ||
    agyConversations.find((c) => c.id === activeConversationId) ||
    null;

  const messages = activeConversationDetail?.messages || [];
  const artifacts = activeConversationDetail?.artifacts || [];
  const subagents = activeConversationDetail?.subagents || [];
  const swarmPlan = activeConversationDetail?.swarmPlan || null;

  const projectBadge =
    activeConv?.projectName ||
    basename(activeConv?.workspacePaths?.[0]) ||
    basename(selectedProjectPath) ||
    "Global";

  const activeProjectPathForMentions =
    activeConv?.workspacePaths?.[0] ||
    selectedProjectPath ||
    agyProjects[0]?.path ||
    "";

  // Merge preset slash commands with any discovered from /api/agy/customizations
  const slashCommandOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of SLASH_PRESETS) {
      map.set(p.cmd.trim(), p.desc);
    }
    for (const item of customizations?.slashCommands || []) {
      if (typeof item === "string") {
        const key = item.startsWith("/") ? item : `/${item}`;
        if (!map.has(key)) map.set(key, "Custom Antigravity command");
      } else if (item && typeof item === "object") {
        const obj = item as AgyCustomizationEntry;
        const raw = obj.command || obj.name || obj.id || "";
        if (raw) {
          const key = raw.startsWith("/") ? raw : `/${raw}`;
          if (!map.has(key)) {
            map.set(key, obj.description || "Custom Antigravity command");
          }
        }
      }
    }
    return Array.from(map.entries()).map(([cmd, desc]) => ({
      cmd: `${cmd} `,
      label: cmd,
      desc,
    }));
  }, [customizations]);

  const filteredConversations = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    return agyConversations.filter((c) => {
      if (convFilter === "running" && c.status !== "running") return false;
      if (convFilter === "project" && selectedProjectPath) {
        const normTarget = selectedProjectPath.replace(/\\/g, "/").toLowerCase();
        const matchesProj = c.workspacePaths.some((wp) =>
          wp.replace(/\\/g, "/").toLowerCase().includes(normTarget)
        );
        if (!matchesProj) return false;
      }
      if (q) {
        const hay = `${c.title} ${c.projectName || ""} ${c.workspacePaths.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [agyConversations, convFilter, convSearch, selectedProjectPath]);

  const loadMentionDirectory = async (dir: string) => {
    if (!activeProjectPathForMentions) return;
    setMentionLoading(true);
    try {
      const res = await api.listAgyFiles(activeProjectPathForMentions, dir);
      setMentionDir(res.dir || dir);
      setMentionEntries(res.entries || []);
    } catch {
      setMentionEntries([]);
    } finally {
      setMentionLoading(false);
    }
  };

  const toggleMentionPicker = () => {
    const next = !showMentionPicker;
    setShowMentionPicker(next);
    setShowSlashPicker(false);
    if (next && activeProjectPathForMentions) {
      setMentionFilter("");
      void loadMentionDirectory("");
    }
  };

  const toggleSlashPicker = () => {
    setShowSlashPicker((v) => !v);
    setShowMentionPicker(false);
  };

  const insertIntoDraft = (snippet: string) => {
    setComposerDraft((prev) => {
      if (!prev) return snippet;
      const needsSpace = !/\s$/.test(prev);
      return `${prev}${needsSpace ? " " : ""}${snippet}`;
    });
    setShowSlashPicker(false);
    setShowMentionPicker(false);
    textareaRef.current?.focus();
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = composerDraft.trim();
    if (!text || !activeConversationId || sendingMsg) return;
    setSendingMsg(true);
    setSendError(null);
    try {
      await sendAgyChatMessage(activeConversationId, text);
      setComposerDraft("");
      window.setTimeout(() => {
        timelineEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 150);
    } catch (err) {
      setSendError(
        err instanceof Error ? err.message : "Failed to send message to Antigravity"
      );
    } finally {
      setSendingMsg(false);
    }
  };

  const handleCreateNewChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPrompt.trim() || creatingChat) return;
    setCreatingChat(true);
    setNewChatError(null);
    try {
      await startNewAgyConversation({
        prompt: newPrompt.trim(),
        title: newTitle.trim() || null,
        model: newModel || null,
        workspacePath: newWorkspacePath || null,
      });
      setNewPrompt("");
      setNewTitle("");
      setShowNewChatModal(false);
    } catch (err) {
      setNewChatError(
        err instanceof Error ? err.message : "Failed to start Antigravity conversation"
      );
    } finally {
      setCreatingChat(false);
    }
  };

  const handleOpenArtifact = async (art: AgyArtifactSummary) => {
    if (!activeConversationId) return;
    setViewingArtifact(art);
    setArtifactContent(null);
    setArtifactError(null);
    setLoadingArtifact(true);
    try {
      const res = await api.getAgyArtifact(activeConversationId, art.relativePath);
      setArtifactContent(res);
    } catch (err) {
      setArtifactError(
        err instanceof Error ? err.message : "Failed to load artifact content"
      );
    } finally {
      setLoadingArtifact(false);
    }
  };

  const handleInspectSubagent = async (sub: AgyConversationSummary) => {
    setLoadingSubagent(true);
    try {
      const detail = await api.getAgyConversationDetail(sub.id, 100);
      setInspectSubagent(detail);
    } catch {
      // Fallback: open directly
      setActiveConversationId(sub.id);
      setShowSwarmDrawer(false);
    } finally {
      setLoadingSubagent(false);
    }
  };

  const statusPill = activeConv ? getStatusPillStyle(activeConv.status) : null;
  const filteredMentions = mentionEntries.filter((e) =>
    mentionFilter.trim()
      ? e.name.toLowerCase().includes(mentionFilter.trim().toLowerCase())
      : true
  );

  return (
    <div className="flex flex-col gap-3 pb-4">
      {/* Top Conversation Bar */}
      <section
        aria-label="Active Conversation Header"
        className="surface-card p-3 space-y-2.5"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {statusPill && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-mono font-semibold border"
                  style={{
                    backgroundColor: statusPill.bg,
                    color: statusPill.fg,
                    borderColor: statusPill.border,
                  }}
                >
                  {activeConv?.status === "running" && (
                    <span
                      className="w-1.5 h-1.5 rounded-full animate-pulse"
                      style={{ backgroundColor: statusPill.fg }}
                    />
                  )}
                  {statusPill.label}
                </span>
              )}
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-mono border max-w-[180px] truncate"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--accent-secondary)",
                }}
              >
                <Folder className="w-3 h-3 shrink-0" />
                <span className="truncate">{projectBadge}</span>
              </span>
            </div>
            <h1 className="font-display text-base font-bold break-words">
              {activeConv?.title || "Antigravity Remote Chat"}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowConvDrawer(true)}
              className="btn-secondary !min-h-[44px] !px-3 text-xs"
              aria-label="Open conversations list"
            >
              <History className="w-4 h-4 shrink-0" />
              <span>Chats ({agyConversations.length})</span>
            </button>
            <button
              type="button"
              onClick={openNewChatSheet}
              className="btn-primary !min-h-[44px] !px-3 text-xs"
            >
              <MessageSquarePlus className="w-4 h-4 shrink-0" />
              <span>+ New Chat</span>
            </button>
          </div>
        </div>

        {/* Subagents / Swarm & Artifacts Chips Row */}
        {(subagents.length > 0 || swarmPlan || artifacts.length > 0) && (
          <div
            className="flex flex-wrap items-center gap-1.5 pt-2 border-t"
            style={{ borderColor: "var(--border-default)" }}
          >
            {(subagents.length > 0 || swarmPlan) && (
              <button
                type="button"
                onClick={() => {
                  setInspectSubagent(null);
                  setShowSwarmDrawer(true);
                }}
                className="btn-secondary !min-h-[44px] !px-2.5 text-xs"
              >
                <Users
                  className="w-4 h-4 shrink-0"
                  style={{ color: "var(--accent-primary)" }}
                />
                <span>
                  Swarm / Subagents ({subagents.length})
                </span>
              </button>
            )}

            {artifacts.map((art) => (
              <button
                key={art.relativePath}
                type="button"
                onClick={() => void handleOpenArtifact(art)}
                className="btn-secondary !min-h-[44px] !px-2.5 text-xs max-w-full"
              >
                {art.kind === "image" ? (
                  <ImageIcon
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color: "var(--accent-secondary)" }}
                  />
                ) : (
                  <FileCode2
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color: "var(--accent-secondary)" }}
                  />
                )}
                <span className="truncate max-w-[150px] font-mono">
                  {art.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Error Banner */}
      {(agyError || apiError) && (
        <div
          role="alert"
          className="surface-card p-3 flex items-center justify-between gap-2 text-xs"
          style={{
            backgroundColor: "var(--status-danger-bg)",
            borderColor: "var(--status-danger)",
            color: "var(--status-danger-fg)",
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="break-words">{agyError || apiError}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              void refreshAgyData();
              if (activeConversationId) {
                void loadAgyConversationDetail(activeConversationId);
              }
            }}
            className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry
          </button>
        </div>
      )}

      {/* Message Timeline */}
      <section aria-label="Conversation Timeline" className="space-y-3 min-h-[260px]">
        {(loading && agyConversations.length === 0) ||
        (agyConversationLoading && !activeConversationDetail) ? (
          <div className="space-y-2.5">
            <div className="skeleton-shimmer h-24 w-4/5 ml-auto" />
            <div className="skeleton-shimmer h-36 w-full" />
            <div className="skeleton-shimmer h-28 w-11/12" />
          </div>
        ) : !activeConv ? (
          <div className="surface-card p-6 text-center space-y-3">
            <Sparkles
              className="w-8 h-8 mx-auto"
              style={{ color: "var(--accent-primary)" }}
            />
            <div className="space-y-1">
              <p className="text-sm font-semibold">
                No Antigravity conversation selected
              </p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Pick an existing chat from your laptop or start a fresh prompt right here.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {agyConversations.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowConvDrawer(true)}
                  className="btn-secondary text-xs"
                >
                  <History className="w-4 h-4" />
                  Browse Conversations
                </button>
              )}
              <button
                type="button"
                onClick={openNewChatSheet}
                className="btn-primary text-xs"
              >
                <MessageSquarePlus className="w-4 h-4" />
                + New Chat
              </button>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="surface-card p-6 text-center space-y-2">
            <p className="text-sm font-medium">Conversation ready</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              No transcript steps recorded yet. Send a message below to prompt Antigravity.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            <div ref={timelineEndRef} />
          </div>
        )}
      </section>

      {/* Sticky Bottom Desktop-like Antigravity Composer */}
      <section
        aria-label="Message Composer"
        className="sticky bottom-[60px] z-20 pt-1"
      >
        <div
          className="surface-card p-2.5 space-y-2"
          style={{ backgroundColor: "var(--bg-surface)" }}
        >
          {/* Slash Command Picker Popover */}
          {showSlashPicker && (
            <div
              className="rounded-[var(--radius-inner)] border p-2 space-y-1 max-h-60 overflow-y-auto"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-strong)",
              }}
            >
              <div className="flex items-center justify-between px-1 pb-1">
                <span
                  className="text-xs font-semibold"
                  style={{ color: "var(--accent-secondary)" }}
                >
                  Slash Commands
                </span>
                <button
                  type="button"
                  onClick={() => setShowSlashPicker(false)}
                  className="btn-ghost !min-h-[44px] !min-w-[44px] !p-1"
                  aria-label="Close slash commands"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {slashCommandOptions.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => insertIntoDraft(item.cmd)}
                    className="rounded-[var(--radius-inner)] border px-2.5 py-2 text-left min-h-[44px] flex flex-col justify-center"
                    style={{
                      backgroundColor: "var(--bg-surface)",
                      borderColor: "var(--border-default)",
                    }}
                  >
                    <span
                      className="font-mono text-xs font-bold"
                      style={{ color: "var(--accent-primary)" }}
                    >
                      {item.label}
                    </span>
                    <span
                      className="text-[11px] truncate"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {item.desc}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* @ File Mention Picker Popover */}
          {showMentionPicker && (
            <div
              className="rounded-[var(--radius-inner)] border p-2 space-y-2 max-h-64 overflow-y-auto"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-strong)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-xs font-semibold truncate"
                  style={{ color: "var(--accent-secondary)" }}
                >
                  Mention File ({basename(activeProjectPathForMentions) || "workspace"})
                </span>
                <button
                  type="button"
                  onClick={() => setShowMentionPicker(false)}
                  className="btn-ghost !min-h-[44px] !min-w-[44px] !p-1 shrink-0"
                  aria-label="Close file mentions"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {!activeProjectPathForMentions ? (
                <p className="text-xs px-1" style={{ color: "var(--text-muted)" }}>
                  Open a project in the Projects tab or select a conversation with a workspace.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    {mentionDir && (
                      <button
                        type="button"
                        onClick={() => {
                          const parent = mentionDir
                            .replace(/\\/g, "/")
                            .split("/")
                            .slice(0, -1)
                            .join("/");
                          void loadMentionDirectory(parent);
                        }}
                        className="btn-secondary !min-h-[44px] !px-2.5 text-xs shrink-0"
                        aria-label="Up one folder"
                      >
                        <FolderUp className="w-4 h-4" />
                      </button>
                    )}
                    <input
                      type="text"
                      value={mentionFilter}
                      onChange={(e) => setMentionFilter(e.target.value)}
                      placeholder="Filter files..."
                      className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-2.5 py-2 text-base"
                      style={{
                        backgroundColor: "var(--bg-surface)",
                        borderColor: "var(--border-default)",
                        color: "var(--text-primary)",
                      }}
                    />
                  </div>

                  {mentionLoading ? (
                    <div className="skeleton-shimmer h-16 w-full" />
                  ) : filteredMentions.length === 0 ? (
                    <p
                      className="text-xs px-1 py-2"
                      style={{ color: "var(--text-muted)" }}
                    >
                      No files in this directory.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {filteredMentions.slice(0, 40).map((entry) => (
                        <button
                          key={entry.relPath}
                          type="button"
                          onClick={() => {
                            if (entry.isDir) {
                              void loadMentionDirectory(entry.relPath);
                            } else {
                              insertIntoDraft(`@[${entry.relPath}] `);
                            }
                          }}
                          className="w-full min-h-[44px] px-2.5 py-1.5 rounded-[var(--radius-inner)] border flex items-center justify-between gap-2 text-left"
                          style={{
                            backgroundColor: "var(--bg-surface)",
                            borderColor: "var(--border-default)",
                          }}
                        >
                          <div className="flex items-center gap-2 min-w-0">
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
                            <span className="font-mono text-xs truncate">
                              {entry.name}
                            </span>
                          </div>
                          {!entry.isDir && (
                            <span
                              className="text-[10px] font-mono shrink-0"
                              style={{ color: "var(--accent-primary)" }}
                            >
                              Insert
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {sendError && (
            <p className="text-xs px-1" style={{ color: "var(--status-danger)" }}>
              {sendError}
            </p>
          )}

          <form onSubmit={(e) => void handleSendMessage(e)} className="space-y-2">
            <textarea
              ref={textareaRef}
              rows={1}
              value={composerDraft}
              onChange={(e) => setComposerDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSendMessage();
                }
              }}
              placeholder={
                activeConversationId
                  ? "Message Antigravity (use / for commands, @ for files)..."
                  : "Start a + New Chat first or pick a conversation..."
              }
              disabled={!activeConversationId}
              className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5 text-base resize-none leading-snug"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggleSlashPicker}
                  className={
                    showSlashPicker
                      ? "btn-primary !min-h-[44px] !min-w-[44px] !px-3 text-xs"
                      : "btn-secondary !min-h-[44px] !min-w-[44px] !px-3 text-xs"
                  }
                  aria-label="Insert slash command"
                  title="Slash commands"
                >
                  <Slash className="w-4 h-4 shrink-0" />
                  <span>Command</span>
                </button>
                <button
                  type="button"
                  onClick={toggleMentionPicker}
                  className={
                    showMentionPicker
                      ? "btn-primary !min-h-[44px] !min-w-[44px] !px-3 text-xs"
                      : "btn-secondary !min-h-[44px] !min-w-[44px] !px-3 text-xs"
                  }
                  aria-label="Mention project file"
                  title="Mention file (@)"
                >
                  <AtSign className="w-4 h-4 shrink-0" />
                  <span>File</span>
                </button>
              </div>

              <button
                type="submit"
                disabled={
                  sendingMsg || !activeConversationId || !composerDraft.trim()
                }
                className="btn-primary !min-h-[44px] !px-4 text-xs shrink-0"
                aria-label="Send message"
              >
                <Send className="w-4 h-4 shrink-0" />
                <span>{sendingMsg ? "Sending…" : "Send"}</span>
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* Conversations Drawer */}
      {showConvDrawer && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.72)" }}
          role="dialog"
          aria-modal="true"
          aria-label="Conversations List"
        >
          <div className="surface-card w-full max-w-lg max-h-[86vh] flex flex-col overflow-hidden">
            <div
              className="px-4 py-3 border-b flex items-center justify-between gap-2"
              style={{ borderColor: "var(--border-default)" }}
            >
              <div className="flex items-center gap-2">
                <History
                  className="w-5 h-5"
                  style={{ color: "var(--accent-primary)" }}
                />
                <h2 className="font-display text-base font-bold">
                  Antigravity Conversations
                </h2>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void refreshAgyData()}
                  className="btn-ghost !min-h-[44px] !min-w-[44px] !p-2"
                  aria-label="Refresh conversations"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowConvDrawer(false)}
                  className="btn-ghost !min-h-[44px] !min-w-[44px] !p-2"
                  aria-label="Close conversations drawer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-3 space-y-2.5 border-b" style={{ borderColor: "var(--border-default)" }}>
              <input
                type="text"
                value={convSearch}
                onChange={(e) => setConvSearch(e.target.value)}
                placeholder="Search chats by title or project..."
                className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-base"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setConvFilter("all")}
                  className={
                    convFilter === "all"
                      ? "btn-primary !min-h-[44px] !px-3 text-xs"
                      : "btn-secondary !min-h-[44px] !px-3 text-xs"
                  }
                >
                  All ({agyConversations.length})
                </button>
                <button
                  type="button"
                  disabled={!selectedProjectPath}
                  onClick={() => setConvFilter("project")}
                  className={
                    convFilter === "project"
                      ? "btn-primary !min-h-[44px] !px-3 text-xs"
                      : "btn-secondary !min-h-[44px] !px-3 text-xs"
                  }
                >
                  {selectedProjectPath
                    ? basename(selectedProjectPath)
                    : "Project (none open)"}
                </button>
                <button
                  type="button"
                  onClick={() => setConvFilter("running")}
                  className={
                    convFilter === "running"
                      ? "btn-primary !min-h-[44px] !px-3 text-xs"
                      : "btn-secondary !min-h-[44px] !px-3 text-xs"
                  }
                >
                  Running (
                  {agyConversations.filter((c) => c.status === "running").length})
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {filteredConversations.length === 0 ? (
                <p
                  className="text-xs text-center py-6"
                  style={{ color: "var(--text-muted)" }}
                >
                  No conversations match this filter.
                </p>
              ) : (
                filteredConversations.map((c) => {
                  const selected = c.id === activeConversationId;
                  const pill = getStatusPillStyle(c.status);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setActiveConversationId(c.id);
                        setShowConvDrawer(false);
                      }}
                      className="surface-subtle w-full p-3 text-left space-y-1.5 min-h-[44px]"
                      style={{
                        borderColor: selected
                          ? "var(--accent-primary)"
                          : "var(--border-default)",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-sm font-semibold truncate">
                          {c.title || "Untitled conversation"}
                        </span>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-mono uppercase shrink-0 border"
                          style={{
                            backgroundColor: pill.bg,
                            color: pill.fg,
                            borderColor: pill.border,
                          }}
                        >
                          {pill.label}
                        </span>
                      </div>
                      <div
                        className="flex flex-wrap items-center gap-2 text-[11px] font-mono"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <span>
                          {c.projectName || basename(c.workspacePaths?.[0]) || "Global"}
                        </span>
                        <span>· {c.stepCount} steps</span>
                        {c.subagentCount > 0 && (
                          <span style={{ color: "var(--accent-secondary)" }}>
                            · {c.subagentCount} subagents
                          </span>
                        )}
                        {c.lastModifiedAt > 0 && (
                          <span>· {formatRelativeTime(c.lastModifiedAt)}</span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* + New Chat Modal */}
      {showNewChatModal && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.72)" }}
          role="dialog"
          aria-modal="true"
          aria-label="New Antigravity Conversation"
        >
          <form
            onSubmit={(e) => void handleCreateNewChat(e)}
            className="surface-card w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
          >
            <div
              className="px-4 py-3 border-b flex items-center justify-between gap-2"
              style={{ borderColor: "var(--border-default)" }}
            >
              <div className="flex items-center gap-2">
                <Sparkles
                  className="w-5 h-5"
                  style={{ color: "var(--accent-primary)" }}
                />
                <h2 className="font-display text-base font-bold">
                  New Antigravity Chat
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowNewChatModal(false)}
                className="btn-ghost !min-h-[44px] !min-w-[44px] !p-2"
                aria-label="Close new chat dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <label className="block space-y-1">
                <span
                  className="text-xs font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  Project Workspace
                </span>
                <select
                  value={newWorkspacePath}
                  onChange={(e) => setNewWorkspacePath(e.target.value)}
                  className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5 text-base"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-default)",
                    color: "var(--text-primary)",
                  }}
                >
                  <option value="">Default / Global Workspace</option>
                  {agyProjects.map((p) => (
                    <option key={p.id} value={p.path}>
                      {p.name} ({p.path})
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span
                  className="text-xs font-semibold flex items-center gap-1.5"
                  style={{ color: "var(--text-muted)" }}
                >
                  <Cpu className="w-3.5 h-3.5" />
                  Model
                </span>
                <select
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5 text-base"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-default)",
                    color: "var(--text-primary)",
                  }}
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m.label} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span
                  className="text-xs font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  Title (optional)
                </span>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Fix auth token refresh"
                  className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5 text-base"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-default)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>

              <label className="block space-y-1">
                <span
                  className="text-xs font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  Prompt
                </span>
                <textarea
                  rows={4}
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  placeholder="What would you like Antigravity to build or inspect?"
                  required
                  className="w-full rounded-[var(--radius-inner)] border p-3 text-base"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-default)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>

              {newChatError && (
                <div
                  role="alert"
                  className="rounded-[var(--radius-inner)] border p-2.5 text-xs"
                  style={{
                    backgroundColor: "var(--status-danger-bg)",
                    borderColor: "var(--status-danger)",
                    color: "var(--status-danger-fg)",
                  }}
                >
                  {newChatError}
                </div>
              )}
            </div>

            <div
              className="px-4 py-3 border-t flex justify-end gap-2"
              style={{ borderColor: "var(--border-default)" }}
            >
              <button
                type="button"
                onClick={() => setShowNewChatModal(false)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creatingChat || !newPrompt.trim()}
                className="btn-primary"
              >
                <Send className="w-4 h-4" />
                {creatingChat ? "Starting…" : "Start Chat"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Subagents / Swarm Drawer */}
      {showSwarmDrawer && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.72)" }}
          role="dialog"
          aria-modal="true"
          aria-label="Subagents and Swarm Inspector"
        >
          <div className="surface-card w-full max-w-xl max-h-[88vh] flex flex-col overflow-hidden">
            <div
              className="px-4 py-3 border-b flex items-center justify-between gap-2"
              style={{ borderColor: "var(--border-default)" }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Users
                  className="w-5 h-5 shrink-0"
                  style={{ color: "var(--accent-primary)" }}
                />
                <h2 className="font-display text-base font-bold truncate">
                  {inspectSubagent
                    ? inspectSubagent.conversation.agentName ||
                      inspectSubagent.conversation.title
                    : "Swarm & Subagents"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowSwarmDrawer(false)}
                className="btn-ghost !min-h-[44px] !min-w-[44px] !p-2"
                aria-label="Close swarm drawer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {loadingSubagent ? (
                <div className="space-y-2">
                  <div className="skeleton-shimmer h-20 w-full" />
                  <div className="skeleton-shimmer h-32 w-full" />
                </div>
              ) : inspectSubagent ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setInspectSubagent(null)}
                      className="btn-secondary !min-h-[44px] text-xs"
                    >
                      &lt; Back to Swarm
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveConversationId(inspectSubagent.conversation.id);
                        setShowSwarmDrawer(false);
                      }}
                      className="btn-primary !min-h-[44px] text-xs"
                    >
                      Open in Main Chat
                    </button>
                  </div>
                  {inspectSubagent.messages.length === 0 ? (
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                      No transcript messages recorded for this subagent yet.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {inspectSubagent.messages.map((m) => (
                        <MessageBubble key={m.id} msg={m} />
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {swarmPlan && (
                    <div className="surface-subtle p-3 space-y-1.5">
                      <div
                        className="text-xs font-semibold"
                        style={{ color: "var(--accent-secondary)" }}
                      >
                        Swarm Plan
                      </div>
                      <pre className="font-mono text-[11px] whitespace-pre-wrap break-words overflow-x-auto max-h-48">
                        {JSON.stringify(swarmPlan, null, 2)}
                      </pre>
                    </div>
                  )}

                  {subagents.length === 0 ? (
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                      No subagents spawned for this conversation.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {subagents.map((sub) => {
                        const pill = getStatusPillStyle(sub.status);
                        return (
                          <button
                            key={sub.id}
                            type="button"
                            onClick={() => void handleInspectSubagent(sub)}
                            className="surface-subtle w-full p-3 text-left space-y-1 min-h-[44px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-display text-sm font-bold truncate">
                                {sub.agentName || sub.title}
                              </span>
                              <span
                                className="rounded-full px-2 py-0.5 text-[10px] font-mono uppercase border shrink-0"
                                style={{
                                  backgroundColor: pill.bg,
                                  color: pill.fg,
                                  borderColor: pill.border,
                                }}
                              >
                                {pill.label}
                              </span>
                            </div>
                            <div
                              className="text-xs truncate"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {sub.title} · {sub.stepCount} steps
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Artifact Viewer Sheet */}
      {viewingArtifact && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.72)" }}
          role="dialog"
          aria-modal="true"
          aria-label="Artifact Viewer"
        >
          <div className="surface-card w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden">
            <div
              className="px-4 py-3 border-b flex items-center justify-between gap-2"
              style={{ borderColor: "var(--border-default)" }}
            >
              <div className="min-w-0">
                <h2 className="font-display text-base font-bold truncate">
                  {viewingArtifact.name}
                </h2>
                <p
                  className="text-xs font-mono truncate"
                  style={{ color: "var(--text-muted)" }}
                >
                  {viewingArtifact.relativePath} · {viewingArtifact.kind}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setViewingArtifact(null)}
                className="btn-ghost !min-h-[44px] !min-w-[44px] !p-2 shrink-0"
                aria-label="Close artifact viewer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loadingArtifact ? (
                <div className="skeleton-shimmer h-48 w-full" />
              ) : artifactError ? (
                <div
                  role="alert"
                  className="rounded-[var(--radius-inner)] border p-3 text-xs"
                  style={{
                    backgroundColor: "var(--status-danger-bg)",
                    borderColor: "var(--status-danger)",
                    color: "var(--status-danger-fg)",
                  }}
                >
                  {artifactError}
                </div>
              ) : artifactContent?.dataUri ? (
                <img
                  src={artifactContent.dataUri}
                  alt={artifactContent.name}
                  className="max-w-full rounded-[var(--radius-inner)] border mx-auto"
                  style={{ borderColor: "var(--border-default)" }}
                />
              ) : (
                <pre
                  className="surface-subtle p-3 text-xs font-mono whitespace-pre-wrap break-words overflow-x-auto leading-relaxed"
                >
                  {artifactContent?.content ?? "Empty artifact."}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
