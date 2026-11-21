import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FileDiff,
  Folder,
  GitBranch,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Terminal,
} from "lucide-react";
import { api } from "../lib/api";
import { useZeroG } from "../lib/store";
import type {
  AgyConversationSummary,
  AgyFileEntry,
  AgyFileReadResponse,
  AgyProject,
  GitStatusResponse,
} from "../types/contracts";

type WorkspaceSubTab = "files" | "changes" | "chats";

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelTime(tsSec?: number | null): string {
  if (!tsSec) return "";
  const ms = tsSec > 1e12 ? tsSec : tsSec * 1000;
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export const ProjectsWorkspaceTab: React.FC = () => {
  const {
    loading,
    agyProjects,
    agyConversations,
    agyError,
    refreshAgyData,
    selectedProjectPath,
    setSelectedProjectPath,
    setActiveConversationId,
    setActiveTab,
    setComposerDraft,
    setPendingNewChatOpen,
    setTerminalCwd,
  } = useZeroG();

  const [subTab, setSubTab] = useState<WorkspaceSubTab>("files");

  // Files state
  const [currentDir, setCurrentDir] = useState<string>("");
  const [fileEntries, setFileEntries] = useState<AgyFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<AgyFileReadResponse | null>(null);
  const [readingFile, setReadingFile] = useState(false);

  // Changes (Git) state
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitNotice, setGitNotice] = useState<string | null>(null);
  const [expandedDiffFile, setExpandedDiffFile] = useState<string | null>(null);
  const [diffsByFile, setDiffsByFile] = useState<Record<string, string>>({});
  const [revertingFile, setRevertingFile] = useState<string | null>(null);

  // Project chats state
  const [projectChats, setProjectChats] = useState<AgyConversationSummary[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);

  const activeProject: AgyProject | null = useMemo(() => {
    if (!selectedProjectPath) return null;
    return (
      agyProjects.find((p) => p.path === selectedProjectPath) || {
        id: selectedProjectPath,
        name:
          selectedProjectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
          selectedProjectPath,
        path: selectedProjectPath,
        dirtyCount: 0,
        conversationCount: 0,
        lastModifiedAt: 0,
      }
    );
  }, [agyProjects, selectedProjectPath]);

  const loadDirectory = useCallback(async (projectPath: string, dir: string) => {
    setFilesLoading(true);
    setFilesError(null);
    setOpenFile(null);
    try {
      const res = await api.listAgyFiles(projectPath, dir);
      setCurrentDir(res.dir || dir);
      setFileEntries(res.entries || []);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : "Failed to list files");
      setFileEntries([]);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const loadFileContent = async (projectPath: string, relPath: string) => {
    setReadingFile(true);
    setFilesError(null);
    try {
      const res = await api.readAgyFile(projectPath, relPath);
      setOpenFile(res);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : "Failed to read file");
    } finally {
      setReadingFile(false);
    }
  };

  const loadGitChanges = useCallback(async (projectPath: string) => {
    setGitLoading(true);
    setGitError(null);
    try {
      const st = await api.getGitStatus(projectPath);
      setGitStatus(st);
    } catch (err) {
      setGitError(err instanceof Error ? err.message : "Failed to inspect git changes");
      setGitStatus(null);
    } finally {
      setGitLoading(false);
    }
  }, []);

  const loadProjectChats = useCallback(
    async (projectPath: string) => {
      setChatsLoading(true);
      try {
        const list = await api.getAgyConversations({
          projectPath,
          includeSubagents: false,
          limit: 60,
        });
        setProjectChats(list);
      } catch {
        const norm = projectPath.replace(/\\/g, "/").toLowerCase();
        setProjectChats(
          agyConversations.filter((c) =>
            c.workspacePaths.some((wp) =>
              wp.replace(/\\/g, "/").toLowerCase().includes(norm)
            )
          )
        );
      } finally {
        setChatsLoading(false);
      }
    },
    [agyConversations]
  );

  // Load workspace sub-tab data when entering a project or switching sub-tab
  useEffect(() => {
    if (!activeProject) return;
    if (subTab === "files") {
      void loadDirectory(activeProject.path, "");
    } else if (subTab === "changes") {
      setGitNotice(null);
      setExpandedDiffFile(null);
      setDiffsByFile({});
      void loadGitChanges(activeProject.path);
    } else if (subTab === "chats") {
      void loadProjectChats(activeProject.path);
    }
  }, [activeProject, subTab, loadDirectory, loadGitChanges, loadProjectChats]);

  const handleOpenProject = (proj: AgyProject) => {
    setSubTab("files");
    setCurrentDir("");
    setOpenFile(null);
    setSelectedProjectPath(proj.path);
  };

  const handleToggleDiff = async (filePath: string) => {
    if (!activeProject) return;
    if (expandedDiffFile === filePath) {
      setExpandedDiffFile(null);
      return;
    }
    setExpandedDiffFile(filePath);
    if (!diffsByFile[filePath]) {
      try {
        const res = await api.getGitDiff(activeProject.path, filePath);
        setDiffsByFile((prev) => ({
          ...prev,
          [filePath]: res.diff || "(No diff preview available for untracked/binary file)",
        }));
      } catch (err) {
        setDiffsByFile((prev) => ({
          ...prev,
          [filePath]:
            err instanceof Error ? err.message : "Failed to load file diff",
        }));
      }
    }
  };

  const handleRevertFile = async (filePath: string) => {
    if (!activeProject) return;
    setRevertingFile(filePath);
    setGitError(null);
    setGitNotice(null);
    try {
      await api.revertGitFile(activeProject.path, filePath);
      setGitNotice(`Reverted ${filePath}`);
      setExpandedDiffFile(null);
      await loadGitChanges(activeProject.path);
      void refreshAgyData();
    } catch (err) {
      setGitError(err instanceof Error ? err.message : "Failed to revert file");
    } finally {
      setRevertingFile(null);
    }
  };

  const handleAskAgentAboutFile = (filePath: string) => {
    const mention = `@[${filePath}] `;
    setComposerDraft((prev) => {
      if (!prev.trim()) return mention;
      const needsSpace = !/\s$/.test(prev);
      return `${prev}${needsSpace ? " " : ""}${mention}`;
    });
    setActiveTab("chat");
  };

  // =========================================================================
  // LIST VIEW (No project drilled into)
  // =========================================================================
  if (!activeProject) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-base font-bold">
              Antigravity Projects
            </h1>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Tap any workspace to browse files, review Git changes, or open project chats.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshAgyData()}
            className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
            aria-label="Refresh projects"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Refresh</span>
          </button>
        </div>

        {agyError && (
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
              <span className="break-words">{agyError}</span>
            </div>
            <button
              type="button"
              onClick={() => void refreshAgyData()}
              className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {loading && agyProjects.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="skeleton-shimmer h-28 w-full" />
            <div className="skeleton-shimmer h-28 w-full" />
          </div>
        ) : agyProjects.length === 0 ? (
          <div className="surface-card p-6 text-center space-y-2">
            <Folder
              className="w-8 h-8 mx-auto"
              style={{ color: "var(--text-muted)" }}
            />
            <p className="text-sm font-medium">No local Antigravity workspaces found</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Open a folder in Antigravity on your laptop or start a conversation to discover workspaces here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {agyProjects.map((proj) => (
              <button
                key={proj.id}
                type="button"
                onClick={() => handleOpenProject(proj)}
                className="surface-card project-slot-terminal p-3.5 text-left space-y-2 w-full min-w-0 min-h-[44px]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Folder
                      className="w-5 h-5 shrink-0"
                      style={{ color: "var(--accent-primary)" }}
                    />
                    <span className="font-display text-sm font-bold truncate">
                      {proj.name}
                    </span>
                  </div>
                  <ChevronRight
                    className="w-4 h-4 shrink-0"
                    style={{ color: "var(--text-muted)" }}
                  />
                </div>

                <p
                  className="text-xs font-mono truncate"
                  style={{ color: "var(--text-muted)" }}
                >
                  {proj.path}
                </p>

                <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono tabular-nums">
                  {proj.gitBranch && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 border"
                      style={{
                        backgroundColor: "var(--bg-subtle)",
                        borderColor: "var(--border-default)",
                        color: "var(--accent-secondary)",
                      }}
                    >
                      <GitBranch className="w-3 h-3 shrink-0" />
                      {proj.gitBranch}
                    </span>
                  )}
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 border"
                    style={{
                      backgroundColor:
                        proj.dirtyCount > 0
                          ? "var(--status-warning-bg)"
                          : "var(--bg-subtle)",
                      borderColor:
                        proj.dirtyCount > 0
                          ? "var(--status-warning)"
                          : "var(--border-default)",
                      color:
                        proj.dirtyCount > 0
                          ? "var(--status-warning-fg)"
                          : "var(--text-muted)",
                    }}
                  >
                    {proj.dirtyCount > 0
                      ? `${proj.dirtyCount} dirty`
                      : "Clean"}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 border"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      borderColor: "var(--border-default)",
                      color: "var(--text-muted)",
                    }}
                  >
                    <MessageSquare className="w-3 h-3 shrink-0" />
                    {proj.conversationCount} chats
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // =========================================================================
  // PROJECT WORKSPACE VIEW
  // =========================================================================
  const breadcrumbs = currentDir
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);

  return (
    <div className="space-y-3">
      {/* Workspace Header */}
      <section aria-label="Project Workspace Header" className="surface-card p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setSelectedProjectPath(null)}
            className="btn-secondary !min-h-[44px] !px-3 text-xs"
          >
            <ChevronLeft className="w-4 h-4 shrink-0" />
            <span>All Projects</span>
          </button>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setPendingNewChatOpen(true);
                setActiveTab("chat");
              }}
              className="btn-primary !min-h-[44px] !px-3 text-xs"
            >
              <MessageSquarePlus className="w-4 h-4 shrink-0" />
              <span>+ New Chat Here</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setTerminalCwd(activeProject.path);
                setActiveTab("terminal");
              }}
              className="btn-secondary !min-h-[44px] !px-3 text-xs"
            >
              <Terminal className="w-4 h-4 shrink-0" />
              <span>Open in Terminal</span>
            </button>
          </div>
        </div>

        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-base font-bold truncate">
              {activeProject.name}
            </h1>
            {activeProject.gitBranch && (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-mono border"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--accent-secondary)",
                }}
              >
                <GitBranch className="w-3 h-3" />
                {activeProject.gitBranch}
              </span>
            )}
          </div>
          <p
            className="text-xs font-mono truncate"
            style={{ color: "var(--text-muted)" }}
          >
            {activeProject.path}
          </p>
        </div>

        {/* 3 Workspace Sub-tabs */}
        <div
          className="grid grid-cols-3 gap-1.5 pt-2 border-t"
          style={{ borderColor: "var(--border-default)" }}
          role="tablist"
          aria-label="Workspace Views"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === "files"}
            onClick={() => setSubTab("files")}
            className={
              subTab === "files"
                ? "btn-primary !min-h-[44px] !px-2 text-xs"
                : "btn-secondary !min-h-[44px] !px-2 text-xs"
            }
          >
            <FileCode2 className="w-4 h-4 shrink-0" />
            <span>Files</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === "changes"}
            onClick={() => setSubTab("changes")}
            className={
              subTab === "changes"
                ? "btn-primary !min-h-[44px] !px-2 text-xs"
                : "btn-secondary !min-h-[44px] !px-2 text-xs"
            }
          >
            <FileDiff className="w-4 h-4 shrink-0" />
            <span>
              Changes
              {gitStatus && gitStatus.files.length > 0
                ? ` (${gitStatus.files.length})`
                : activeProject.dirtyCount > 0
                  ? ` (${activeProject.dirtyCount})`
                  : ""}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === "chats"}
            onClick={() => setSubTab("chats")}
            className={
              subTab === "chats"
                ? "btn-primary !min-h-[44px] !px-2 text-xs"
                : "btn-secondary !min-h-[44px] !px-2 text-xs"
            }
          >
            <MessageSquare className="w-4 h-4 shrink-0" />
            <span>Chats</span>
          </button>
        </div>
      </section>

      {/* SUB-TAB 1: FILES */}
      {subTab === "files" && (
        <section aria-label="Project Files" className="surface-card p-3 space-y-3">
          {/* Breadcrumbs */}
          <div className="flex flex-wrap items-center gap-1 text-xs font-mono">
            <button
              type="button"
              onClick={() => void loadDirectory(activeProject.path, "")}
              className="btn-ghost !min-h-[44px] !px-2 text-xs font-mono"
              style={{ color: "var(--accent-primary)" }}
            >
              {activeProject.name}
            </button>
            {breadcrumbs.map((seg, i) => {
              const target = breadcrumbs.slice(0, i + 1).join("/");
              return (
                <React.Fragment key={target}>
                  <span style={{ color: "var(--text-muted)" }}>/</span>
                  <button
                    type="button"
                    onClick={() => void loadDirectory(activeProject.path, target)}
                    className="btn-ghost !min-h-[44px] !px-2 text-xs font-mono"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {seg}
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          {filesError && (
            <div
              role="alert"
              className="rounded-[var(--radius-inner)] border p-2.5 text-xs"
              style={{
                backgroundColor: "var(--status-danger-bg)",
                borderColor: "var(--status-danger)",
                color: "var(--status-danger-fg)",
              }}
            >
              {filesError}
            </div>
          )}

          {readingFile ? (
            <div className="skeleton-shimmer h-56 w-full" />
          ) : openFile ? (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-sm font-bold truncate">
                    {openFile.path}
                  </div>
                  <div
                    className="text-[11px] font-mono"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {openFile.lineCount} lines
                    {openFile.truncated ? " · Truncated preview" : ""}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setOpenFile(null)}
                    className="btn-secondary !min-h-[44px] !px-3 text-xs"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Back to Folder
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAskAgentAboutFile(openFile.path)}
                    className="btn-primary !min-h-[44px] !px-3 text-xs"
                  >
                    <Sparkles className="w-4 h-4 shrink-0" />
                    <span>Ask Agent about @{openFile.name}</span>
                  </button>
                </div>
              </div>

              <div
                className="rounded-[var(--radius-inner)] border overflow-x-auto max-h-[60vh]"
                style={{
                  backgroundColor: "var(--bg-canvas)",
                  borderColor: "var(--border-default)",
                }}
              >
                <table className="w-full border-collapse font-mono text-xs leading-relaxed">
                  <tbody>
                    {openFile.content.split("\n").map((line, idx) => (
                      <tr key={idx}>
                        <td
                          className="select-none px-2.5 py-0.5 text-right align-top tabular-nums border-r w-10"
                          style={{
                            color: "var(--text-muted)",
                            borderColor: "var(--border-default)",
                          }}
                        >
                          {idx + 1}
                        </td>
                        <td className="px-3 py-0.5 whitespace-pre">
                          {line || " "}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : filesLoading ? (
            <div className="space-y-2">
              <div className="skeleton-shimmer h-11 w-full" />
              <div className="skeleton-shimmer h-11 w-full" />
              <div className="skeleton-shimmer h-11 w-full" />
            </div>
          ) : fileEntries.length === 0 ? (
            <p className="text-xs py-6 text-center" style={{ color: "var(--text-muted)" }}>
              Directory is empty.
            </p>
          ) : (
            <div className="space-y-1.5">
              {fileEntries.map((entry) => (
                <button
                  key={entry.relPath}
                  type="button"
                  onClick={() => {
                    if (entry.isDir) {
                      void loadDirectory(activeProject.path, entry.relPath);
                    } else {
                      void loadFileContent(activeProject.path, entry.relPath);
                    }
                  }}
                  className="surface-subtle w-full min-h-[44px] px-3 py-2 flex items-center justify-between gap-2 text-left"
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
                  <span
                    className="font-mono text-[11px] tabular-nums shrink-0"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {entry.isDir ? "DIR" : formatBytes(entry.sizeBytes)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* SUB-TAB 2: GIT CHANGES */}
      {subTab === "changes" && (
        <section aria-label="Git Changes" className="surface-card p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
              {gitStatus?.branch ? `Branch: ${gitStatus.branch}` : "Git Status"}
              {gitStatus?.headSha ? ` · ${gitStatus.headSha.slice(0, 7)}` : ""}
            </div>
            <button
              type="button"
              onClick={() => void loadGitChanges(activeProject.path)}
              disabled={gitLoading}
              className="btn-secondary !min-h-[44px] !px-3 text-xs"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${gitLoading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>

          {gitError && (
            <div
              role="alert"
              className="rounded-[var(--radius-inner)] border p-2.5 text-xs"
              style={{
                backgroundColor: "var(--status-danger-bg)",
                borderColor: "var(--status-danger)",
                color: "var(--status-danger-fg)",
              }}
            >
              {gitError}
            </div>
          )}

          {gitNotice && (
            <div
              className="rounded-[var(--radius-inner)] border p-2.5 text-xs"
              style={{
                backgroundColor: "var(--status-success-bg)",
                borderColor: "var(--status-success)",
                color: "var(--status-success-fg)",
              }}
            >
              {gitNotice}
            </div>
          )}

          {gitLoading ? (
            <div className="space-y-2">
              <div className="skeleton-shimmer h-12 w-full" />
              <div className="skeleton-shimmer h-12 w-full" />
            </div>
          ) : !gitStatus || gitStatus.files.length === 0 ? (
            <div className="surface-subtle p-6 text-center space-y-1">
              <p className="text-sm font-medium">Working tree clean</p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No modified or untracked files in this repository.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {gitStatus.files.map((f) => {
                const expanded = expandedDiffFile === f.path;
                const diff = diffsByFile[f.path];
                return (
                  <div
                    key={f.path}
                    className="surface-subtle overflow-hidden"
                    style={{
                      borderColor: expanded
                        ? "var(--accent-secondary)"
                        : "var(--border-default)",
                    }}
                  >
                    <div className="p-2 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => void handleToggleDiff(f.path)}
                        className="flex-1 min-w-0 min-h-[44px] px-1 flex items-center gap-2 text-left"
                      >
                        <span
                          className="font-mono text-xs px-1.5 py-0.5 rounded border shrink-0"
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
                        disabled={revertingFile === f.path}
                        onClick={() => void handleRevertFile(f.path)}
                        className="btn-secondary !min-h-[44px] !px-2.5 text-xs shrink-0"
                        aria-label={`Revert ${f.path}`}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>
                          {revertingFile === f.path ? "Reverting…" : "Revert"}
                        </span>
                      </button>
                    </div>

                    {expanded && (
                      <pre
                        className="border-t p-2.5 text-xs font-mono overflow-x-auto max-h-72 leading-relaxed"
                        style={{
                          backgroundColor: "var(--bg-canvas)",
                          borderColor: "var(--border-default)",
                        }}
                      >
                        {(diff || "Loading diff...").split("\n").map((line, i) => {
                          const isAdd =
                            line.startsWith("+") && !line.startsWith("+++");
                          const isDel =
                            line.startsWith("-") && !line.startsWith("---");
                          return (
                            <div
                              key={i}
                              style={{
                                backgroundColor: isAdd
                                  ? "var(--diff-add-bg)"
                                  : isDel
                                    ? "var(--diff-del-bg)"
                                    : "transparent",
                                color: isAdd
                                  ? "var(--diff-add-fg)"
                                  : isDel
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
        </section>
      )}

      {/* SUB-TAB 3: PROJECT CHATS */}
      {subTab === "chats" && (
        <section aria-label="Project Conversations" className="surface-card p-3 space-y-2.5">
          {chatsLoading ? (
            <div className="space-y-2">
              <div className="skeleton-shimmer h-16 w-full" />
              <div className="skeleton-shimmer h-16 w-full" />
            </div>
          ) : projectChats.length === 0 ? (
            <div className="surface-subtle p-6 text-center space-y-3">
              <p className="text-sm font-medium">No chats for this project yet</p>
              <button
                type="button"
                onClick={() => {
                  setPendingNewChatOpen(true);
                  setActiveTab("chat");
                }}
                className="btn-primary text-xs"
              >
                <MessageSquarePlus className="w-4 h-4" />
                + New Chat Here
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {projectChats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setActiveConversationId(c.id);
                    setActiveTab("chat");
                  }}
                  className="surface-subtle w-full min-h-[44px] p-3 text-left space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-bold truncate">
                      {c.title || "Untitled conversation"}
                    </span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-mono uppercase border shrink-0"
                      style={{
                        borderColor:
                          c.status === "running"
                            ? "var(--status-success)"
                            : "var(--border-default)",
                        color:
                          c.status === "running"
                            ? "var(--status-success-fg)"
                            : "var(--text-muted)",
                        backgroundColor:
                          c.status === "running"
                            ? "var(--status-success-bg)"
                            : "var(--bg-surface)",
                      }}
                    >
                      {c.status}
                    </span>
                  </div>
                  <div
                    className="text-xs font-mono flex items-center gap-2"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <span>{c.stepCount} steps</span>
                    {c.lastModifiedAt > 0 && (
                      <span>· {formatRelTime(c.lastModifiedAt)}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
