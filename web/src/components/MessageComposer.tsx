import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  AtSign,
  AudioLines,
  Check,
  ChevronDown,
  Cpu,
  FileCode2,
  Folder,
  FolderUp,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  Plus,
  Shield,
  Slash,
  Square,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { useZeroG } from "../lib/store";
import { getBrowserSpeechRecognitionCtor } from "../lib/voiceClient";
import type {
  AgyCustomizationEntry,
  AgyFileEntry,
  PermissionPreset,
} from "../types/contracts";

const SLASH_PRESETS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/plan", desc: "Create a step-by-step implementation plan" },
  { cmd: "/grill-me", desc: "Interactive design & trade-off interview" },
  { cmd: "/boost", desc: "Maximum depth & thoroughness mode" },
  { cmd: "/teamwork", desc: "Multi-agent swarm collaboration" },
  { cmd: "/goal", desc: "Autonomous goal loop until complete" },
  { cmd: "/browser", desc: "Browser inspection & visual verification" },
  { cmd: "/compact", desc: "Summarize context to free window" },
  { cmd: "/schedule", desc: "Configure recurring or timed automation" },
  { cmd: "/learn", desc: "Persist lesson or workflow setup" },
];

const MODEL_OPTIONS: Array<{ label: string; short: string; value: string }> = [
  { label: "Orchestrator", short: "Orchestrator", value: "" },
  {
    label: "Gemini 4 Carbon",
    short: "Carbon",
    value: "Gemini 4 Carbon (High)",
  },
  { label: "Gemini 4 Argon", short: "Argon", value: "Gemini 4 Argon (High)" },
  {
    label: "Gemini 4 Hydrogen",
    short: "Hydrogen",
    value: "Gemini 4 Hydrogen (High)",
  },
  {
    label: "Gemini 3.8 Flash",
    short: "3.8 Flash",
    value: "Gemini 3.8 Flash (High)",
  },
  { label: "Pro", short: "Pro", value: "Pro" },
  { label: "Flash", short: "Flash", value: "Flash" },
];

const PRESET_OPTIONS: Array<{
  id: PermissionPreset;
  label: string;
  short: string;
}> = [
  { id: "request_review", label: "Request Review", short: "Review" },
  { id: "default", label: "Default", short: "Default" },
  { id: "auto", label: "Auto", short: "Auto" },
  { id: "turbo", label: "Turbo", short: "Turbo" },
];

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const MessageComposer: React.FC<{
  onAfterSend?: () => void;
}> = ({ onAfterSend }) => {
  const {
    composerDraft,
    setComposerDraft,
    selectedModel,
    setSelectedModel,
    permissionPreset,
    setPermissionPreset,
    interfaceLayout,
    worktreeMode,
    worktreeBranch,
    setWorktreeBranch,
    uploadedAttachments,
    uploadingAttachment,
    uploadAttachment,
    removeUploadedAttachment,
    clearUploadedAttachments,
    selectedProject,
    selectedProjectPath,
    agyProjects,
    agyConversations,
    activeConversationId,
    activeConversationDetail,
    isNewChatDraft,
    customizations,
    startNewAgyConversation,
    sendAgyChatMessage,
    sessions,
    cancelWorker,
    voiceSnapshot,
    startVoiceCall,
  } = useZeroG();

  const [openMenu, setOpenMenu] = useState<
    "slash" | "mention" | "model" | "preset" | null
  >(null);
  const [mentionTab, setMentionTab] = useState<"files" | "chats">("files");
  const [mentionDir, setMentionDir] = useState("");
  const [mentionEntries, setMentionEntries] = useState<AgyFileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionSearch, setMentionSearch] = useState("");

  const [sending, setSending] = useState(false);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [dictating, setDictating] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dictationRecRef = useRef<{ stop: () => void } | null>(null);

  const activeConv =
    (!isNewChatDraft &&
      (activeConversationDetail?.conversation ||
        agyConversations.find((c) => c.id === activeConversationId))) ||
    null;

  const isAgentRunning = activeConv?.status === "running";

  const activeWorkspaceForMentions =
    activeConv?.workspacePaths?.[0] ||
    selectedProject?.path ||
    selectedProjectPath ||
    agyProjects[0]?.path ||
    "";

  const effectivePreset: PermissionPreset =
    selectedProject?.permissionPreset &&
    selectedProject.permissionPreset !== "inherit"
      ? selectedProject.permissionPreset
      : permissionPreset;

  // Auto-grow textarea height cleanly
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(180, Math.max(46, el.scrollHeight))}px`;
  }, [composerDraft]);

  // Cleanup dictation on unmount
  useEffect(() => {
    return () => {
      dictationRecRef.current?.stop();
    };
  }, []);

  const slashOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of SLASH_PRESETS) {
      map.set(p.cmd, p.desc);
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
    return Array.from(map.entries()).map(([cmd, desc]) => ({ cmd, desc }));
  }, [customizations]);

  const loadMentionDir = async (dir: string) => {
    if (!activeWorkspaceForMentions) return;
    setMentionLoading(true);
    try {
      const res = await api.listAgyFiles(activeWorkspaceForMentions, dir);
      setMentionDir(res.dir || dir);
      setMentionEntries(res.entries || []);
    } catch {
      setMentionEntries([]);
    } finally {
      setMentionLoading(false);
    }
  };

  const openMentionPopover = () => {
    setOpenMenu("mention");
    setMentionSearch("");
    if (activeWorkspaceForMentions) {
      void loadMentionDir("");
    }
  };

  const handleDraftChange = (val: string) => {
    setComposerDraft(val);
    if (val === "/" || /\s\/$/.test(val)) {
      setOpenMenu("slash");
    } else if (val === "@" || /\s@$/.test(val)) {
      openMentionPopover();
    } else if (openMenu === "slash" && !val.includes("/")) {
      setOpenMenu(null);
    }
  };

  const insertToken = (snippet: string, replaceTrailingTrigger?: "/" | "@") => {
    setComposerDraft((prev) => {
      let base = prev;
      if (replaceTrailingTrigger && base.endsWith(replaceTrailingTrigger)) {
        base = base.slice(0, -1);
      }
      if (!base) return `${snippet} `;
      const needsSpace = !/\s$/.test(base);
      return `${base}${needsSpace ? " " : ""}${snippet} `;
    });
    setOpenMenu(null);
    textareaRef.current?.focus();
  };

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    setComposerNotice(null);
    for (const file of files) {
      try {
        await uploadAttachment(file);
      } catch (err) {
        setComposerNotice(
          err instanceof Error ? err.message : `Failed to upload ${file.name}`
        );
      }
    }
  };

  const toggleDictation = () => {
    if (dictating) {
      dictationRecRef.current?.stop();
      dictationRecRef.current = null;
      setDictating(false);
      return;
    }

    const RecCtor = getBrowserSpeechRecognitionCtor();
    if (!RecCtor) {
      setComposerNotice("Browser dictation is unavailable on this device.");
      return;
    }

    try {
      const rec = new RecCtor();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = "en-US";
      rec.onresult = (ev) => {
        let added = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) {
            added += `${ev.results[i][0]?.transcript || ""} `;
          }
        }
        if (added.trim()) {
          setComposerDraft((prev) => {
            const clean = added.trim();
            if (!prev.trim()) return clean;
            return `${prev.trimEnd()} ${clean}`;
          });
        }
      };
      rec.onerror = () => {
        setDictating(false);
      };
      rec.onend = () => {
        setDictating(false);
      };
      dictationRecRef.current = rec;
      setDictating(true);
      rec.start();
    } catch {
      setDictating(false);
    }
  };

  const handleStopRunningAgent = async () => {
    setComposerNotice(null);
    const matchingSess = sessions.find(
      (s) =>
        s.id === activeConversationId ||
        (s.status === "running" && s.provider === "antigravity")
    );
    try {
      if (matchingSess) {
        await cancelWorker(matchingSess.id);
      }
      if (activeConversationId) {
        await sendAgyChatMessage(
          activeConversationId,
          "Stop current task and wait for instructions."
        );
      }
    } catch (err) {
      setComposerNotice(
        err instanceof Error ? err.message : "Failed to send stop signal"
      );
    }
  };

  const handleSend = async () => {
    const rawText = composerDraft.trim();
    if ((!rawText && uploadedAttachments.length === 0) || sending) return;

    const attachmentMentions = uploadedAttachments
      .map((a) => a.mentionToken)
      .filter((tok) => !rawText.includes(tok));

    const finalPrompt =
      attachmentMentions.length > 0
        ? `${attachmentMentions.join(" ")}${rawText ? `\n${rawText}` : "Inspect attached files."}`
        : rawText;

    setSending(true);
    setComposerNotice(null);
    setOpenMenu(null);

    try {
      if (isNewChatDraft || !activeConversationId) {
        const folders =
          selectedProject?.folders && selectedProject.folders.length > 0
            ? selectedProject.folders
            : selectedProject?.path
              ? [selectedProject.path]
              : selectedProjectPath
                ? [selectedProjectPath]
                : null;

        await startNewAgyConversation({
          prompt: finalPrompt,
          model: selectedModel || null,
          workspacePath:
            selectedProject?.path ||
            selectedProjectPath ||
            agyProjects[0]?.path ||
            null,
          folders,
          worktreeMode:
            interfaceLayout === "software_engineering" ? worktreeMode : "local",
          branchName:
            interfaceLayout === "software_engineering" &&
            worktreeMode === "worktree" &&
            worktreeBranch.trim()
              ? worktreeBranch.trim()
              : null,
          permissionPreset: effectivePreset,
        });
        setWorktreeBranch("");
      } else {
        await sendAgyChatMessage(activeConversationId, finalPrompt);
      }
      setComposerDraft("");
      clearUploadedAttachments();
      onAfterSend?.();
    } catch (err) {
      setComposerNotice(
        err instanceof Error ? err.message : "Failed to send message"
      );
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (typeof window !== "undefined" && window.innerWidth >= 768) {
        e.preventDefault();
        void handleSend();
      }
    } else if (e.key === "Escape" && openMenu) {
      setOpenMenu(null);
    }
  };

  const selectedModelMeta =
    MODEL_OPTIONS.find((m) => m.value === selectedModel) || MODEL_OPTIONS[0];
  const selectedPresetMeta =
    PRESET_OPTIONS.find((p) => p.id === effectivePreset) || PRESET_OPTIONS[1];

  const hasSendableContent =
    composerDraft.trim().length > 0 || uploadedAttachments.length > 0;

  const filteredMentionFiles = mentionEntries.filter((e) =>
    mentionSearch.trim()
      ? e.name.toLowerCase().includes(mentionSearch.trim().toLowerCase())
      : true
  );
  const filteredMentionChats = agyConversations.filter((c) =>
    mentionSearch.trim()
      ? c.title.toLowerCase().includes(mentionSearch.trim().toLowerCase())
      : true
  );

  return (
    <section
      aria-label="Antigravity Message Composer"
      className="mx-auto w-full max-w-3xl px-2 sm:px-4 pb-2.5 pt-1 shrink-0"
    >
      {/* Popover Menus Above Composer */}
      {openMenu === "slash" && (
        <div
          className="surface-card mb-2 p-2 space-y-1 max-h-64 overflow-y-auto"
          style={{ borderColor: "var(--border-strong)" }}
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span
              className="text-xs font-semibold inline-flex items-center gap-1"
              style={{ color: "var(--accent-secondary)" }}
            >
              <Slash className="w-3.5 h-3.5" />
              Slash Commands
            </span>
            <button
              type="button"
              onClick={() => setOpenMenu(null)}
              className="agy-icon-btn"
              aria-label="Close slash commands"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {slashOptions.map((item) => (
              <button
                key={item.cmd}
                type="button"
                onClick={() => insertToken(item.cmd, "/")}
                className="surface-subtle min-h-[44px] px-3 py-2 text-left flex flex-col justify-center"
              >
                <span
                  className="font-mono text-xs font-bold"
                  style={{ color: "var(--accent-primary)" }}
                >
                  {item.cmd}
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

      {openMenu === "mention" && (
        <div
          className="surface-card mb-2 p-2.5 space-y-2 max-h-72 overflow-y-auto"
          style={{ borderColor: "var(--border-strong)" }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMentionTab("files")}
                className={
                  mentionTab === "files"
                    ? "btn-primary !min-h-[44px] !px-3 text-xs"
                    : "btn-secondary !min-h-[44px] !px-3 text-xs"
                }
              >
                <FileCode2 className="w-3.5 h-3.5" />
                Files
              </button>
              <button
                type="button"
                onClick={() => setMentionTab("chats")}
                className={
                  mentionTab === "chats"
                    ? "btn-primary !min-h-[44px] !px-3 text-xs"
                    : "btn-secondary !min-h-[44px] !px-3 text-xs"
                }
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Recent Chats
              </button>
            </div>
            <button
              type="button"
              onClick={() => setOpenMenu(null)}
              className="agy-icon-btn"
              aria-label="Close mentions"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <input
            type="search"
            value={mentionSearch}
            onChange={(e) => setMentionSearch(e.target.value)}
            placeholder={
              mentionTab === "files"
                ? "Filter workspace files…"
                : "Filter conversations…"
            }
            className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-base font-mono"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          />

          {mentionTab === "files" ? (
            <div className="space-y-1">
              {mentionDir && (
                <button
                  type="button"
                  onClick={() => {
                    const parent = mentionDir
                      .replace(/\\/g, "/")
                      .split("/")
                      .slice(0, -1)
                      .join("/");
                    void loadMentionDir(parent);
                  }}
                  className="surface-subtle w-full min-h-[44px] px-3 py-1.5 flex items-center gap-2 text-xs font-mono"
                >
                  <FolderUp className="w-4 h-4" />
                  <span>.. ({mentionDir})</span>
                </button>
              )}
              {mentionLoading ? (
                <div className="skeleton-shimmer h-11 w-full" />
              ) : filteredMentionFiles.length === 0 ? (
                <p
                  className="text-xs px-2 py-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  No files found in workspace.
                </p>
              ) : (
                filteredMentionFiles.slice(0, 25).map((entry) => (
                  <button
                    key={entry.relPath}
                    type="button"
                    onClick={() => {
                      if (entry.isDir) {
                        void loadMentionDir(entry.relPath);
                      } else {
                        insertToken(`@[${entry.relPath}]`, "@");
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
                      {entry.isDir ? "DIR" : formatBytesShort(entry.sizeBytes)}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredMentionChats.slice(0, 15).map((conv) => (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() =>
                    insertToken(`@[conversation:${conv.id}]`, "@")
                  }
                  className="surface-subtle w-full min-h-[44px] px-3 py-1.5 flex items-center justify-between gap-2 text-left text-xs"
                >
                  <span className="truncate font-medium">{conv.title}</span>
                  <span
                    className="font-mono text-[10px] shrink-0"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {conv.stepCount} steps
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {openMenu === "model" && (
        <div
          className="surface-card mb-2 p-2 space-y-1 max-h-64 overflow-y-auto"
          style={{ borderColor: "var(--border-strong)" }}
        >
          {MODEL_OPTIONS.map((m) => {
            const active = selectedModel === m.value;
            return (
              <button
                key={m.label}
                type="button"
                onClick={() => {
                  setSelectedModel(m.value);
                  setOpenMenu(null);
                }}
                className="w-full min-h-[44px] px-3 py-2 rounded-[var(--radius-inner)] flex items-center justify-between gap-2 text-xs font-medium text-left"
                style={{
                  backgroundColor: active ? "var(--bg-elevated)" : "transparent",
                  color: active ? "var(--accent-primary)" : "var(--text-primary)",
                }}
              >
                <span>{m.label}</span>
                {active && <Check className="w-4 h-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      {openMenu === "preset" && (
        <div
          className="surface-card mb-2 p-2 space-y-1"
          style={{ borderColor: "var(--border-strong)" }}
        >
          {PRESET_OPTIONS.map((p) => {
            const active = effectivePreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  void setPermissionPreset(p.id);
                  setOpenMenu(null);
                }}
                className="w-full min-h-[44px] px-3 py-2 rounded-[var(--radius-inner)] flex items-center justify-between gap-2 text-xs font-medium text-left"
                style={{
                  backgroundColor: active ? "var(--bg-elevated)" : "transparent",
                  color: active ? "var(--accent-primary)" : "var(--text-primary)",
                }}
              >
                <span>{p.label}</span>
                {active && <Check className="w-4 h-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      {/* Main Native Antigravity Composer Card */}
      <div
        className="surface-card p-2.5 space-y-2"
        style={{ backgroundColor: "var(--bg-surface)" }}
      >
        {/* Uploaded File Chips Bar */}
        {(uploadedAttachments.length > 0 || uploadingAttachment) && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 pt-0.5">
            {uploadedAttachments.map((att) => (
              <div
                key={att.relPath}
                className="inline-flex items-center gap-1 rounded-full border pl-3 pr-0.5 text-xs font-mono max-w-full"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                <Paperclip
                  className="w-3 h-3 shrink-0"
                  style={{ color: "var(--accent-secondary)" }}
                />
                <span className="truncate max-w-[150px]">{att.fileName}</span>
                <span
                  className="text-[10px] shrink-0"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatBytesShort(att.sizeBytes)}
                </span>
                <button
                  type="button"
                  onClick={() => removeUploadedAttachment(att.relPath)}
                  className="agy-icon-btn rounded-full"
                  aria-label={`Remove ${att.fileName}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {uploadingAttachment && (
              <span
                className="text-xs font-mono animate-pulse px-2"
                style={{ color: "var(--accent-secondary)" }}
              >
                Uploading…
              </span>
            )}
          </div>
        )}

        {/* Auto-growing Prompt Textarea */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={composerDraft}
          onChange={(e) => handleDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isNewChatDraft || !activeConversationId
              ? "Ask Antigravity anything… (/ for commands, @ for files)"
              : "Reply or steer Antigravity… (/ for commands, @ for files)"
          }
          aria-label="Prompt message"
          className="w-full resize-none border-0 bg-transparent px-2 py-1.5 text-base leading-relaxed rounded-[var(--radius-inner)]"
          style={{ color: "var(--text-primary)" }}
        />

        {composerNotice && (
          <div
            role="status"
            className="px-2 text-xs"
            style={{ color: "var(--status-warning-fg)" }}
          >
            {composerNotice}
          </div>
        )}

        {/* Bottom Controls Bar */}
        <div className="flex items-center justify-between gap-1.5 pt-0.5">
          {/* Left Controls: + Upload, / Slash, @ Mention, Model Pill, Permission Pill */}
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.md,.txt,.json,.py,.ts,.tsx,.js,.jsx,.css,.html,.csv,.yaml,.yml,.log"
              onChange={(e) => void handleFileInputChange(e)}
              className="sr-only"
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAttachment}
              className="agy-icon-btn shrink-0"
              aria-label="Attach file or photo"
              title="Attach file or photo"
            >
              <Plus className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={() =>
                setOpenMenu((prev) => (prev === "slash" ? null : "slash"))
              }
              className="agy-icon-btn hidden sm:inline-flex shrink-0"
              aria-label="Slash commands"
              title="Slash commands (/)"
            >
              <Slash className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => {
                if (openMenu === "mention") setOpenMenu(null);
                else openMentionPopover();
              }}
              className="agy-icon-btn hidden sm:inline-flex shrink-0"
              aria-label="Mention file or conversation"
              title="Mention file or conversation (@)"
            >
              <AtSign className="w-4 h-4" />
            </button>

            {/* Model Picker Pill */}
            <button
              type="button"
              onClick={() =>
                setOpenMenu((prev) => (prev === "model" ? null : "model"))
              }
              className="agy-pill-btn !px-2.5 shrink-0"
              aria-label={`Model: ${selectedModelMeta.label}`}
              title={`Model: ${selectedModelMeta.label}`}
            >
              <Cpu
                className="w-3.5 h-3.5 shrink-0"
                style={{ color: "var(--accent-secondary)" }}
              />
              <span className="truncate max-w-[82px] sm:max-w-[130px]">
                {selectedModelMeta.short}
              </span>
              <ChevronDown className="w-3 h-3 shrink-0 opacity-70" />
            </button>

            {/* Permission Preset Pill */}
            <button
              type="button"
              onClick={() =>
                setOpenMenu((prev) => (prev === "preset" ? null : "preset"))
              }
              className="agy-pill-btn !px-2.5 shrink-0"
              aria-label={`Permission preset: ${selectedPresetMeta.label}`}
              title={`Permission preset: ${selectedPresetMeta.label}`}
            >
              <Shield
                className="w-3.5 h-3.5 shrink-0"
                style={{ color: "var(--accent-primary)" }}
              />
              <span className="truncate max-w-[68px] sm:max-w-[110px]">
                {selectedPresetMeta.short}
              </span>
              <ChevronDown className="w-3 h-3 shrink-0 opacity-70" />
            </button>
          </div>

          {/* Right Controls: Dictation Mic + Primary Action Button */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={toggleDictation}
              className="agy-icon-btn"
              aria-label={dictating ? "Stop dictation" : "Dictate into prompt"}
              title={dictating ? "Stop dictation" : "Dictate message"}
              style={
                dictating
                  ? {
                      backgroundColor: "var(--status-danger-bg)",
                      color: "var(--status-danger)",
                    }
                  : undefined
              }
            >
              {dictating ? (
                <MicOff className="w-5 h-5 animate-pulse" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
            </button>

            {isAgentRunning && hasSendableContent && (
              <button
                type="button"
                onClick={() => void handleStopRunningAgent()}
                className="agy-icon-btn"
                aria-label="Stop running agent"
                title="Stop running agent"
                style={{ color: "var(--status-danger)" }}
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            )}

            {isAgentRunning && !hasSendableContent ? (
              <button
                type="button"
                onClick={() => void handleStopRunningAgent()}
                className="w-11 h-11 min-h-[44px] min-w-[44px] rounded-full inline-flex items-center justify-center shrink-0 cursor-pointer"
                style={{
                  backgroundColor: "var(--status-danger)",
                  color: "var(--status-danger-contrast)",
                }}
                aria-label="Stop running agent"
                title="Stop agent"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            ) : !hasSendableContent ? (
              <button
                type="button"
                onClick={() => void startVoiceCall()}
                disabled={voiceSnapshot.active}
                className="w-11 h-11 min-h-[44px] min-w-[44px] rounded-full inline-flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent-primary)",
                  color: "var(--accent-primary-fg)",
                }}
                aria-label="Start Voice Mode"
                title="Start Antigravity Voice Mode"
              >
                <AudioLines className="w-5 h-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending}
                className="w-11 h-11 min-h-[44px] min-w-[44px] rounded-full inline-flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent-primary)",
                  color: "var(--accent-primary-fg)",
                }}
                aria-label="Send message"
                title="Send"
              >
                <ArrowUp className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
