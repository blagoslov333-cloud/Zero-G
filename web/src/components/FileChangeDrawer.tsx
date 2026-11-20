import React, { useEffect, useState } from "react";
import {
  FileDiff,
  GitBranch,
  GitMerge,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import type { GitStatusResponse, SessionSummary } from "../types/contracts";

export const FileChangeDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  session: SessionSummary | null;
  repoPath: string;
}> = ({ open, onClose, session, repoPath }) => {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const targetPath = session?.worktreePath || session?.cwd || repoPath;

  const loadGit = async () => {
    if (!targetPath) return;
    setLoading(true);
    setError(null);
    try {
      const st = await api.getGitStatus(targetPath);
      setStatus(st);
      const firstFile = st.files?.[0]?.path || null;
      setSelectedFile(firstFile);
      const df = await api.getGitDiff(targetPath, firstFile || undefined);
      setDiffText(df.diff || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to inspect git status");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setNotice(null);
      void loadGit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPath]);

  if (!open) return null;

  const handleSelectFile = async (filePath: string) => {
    setSelectedFile(filePath);
    try {
      const df = await api.getGitDiff(targetPath, filePath);
      setDiffText(df.diff || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load diff");
    }
  };

  const handleRevert = async (filePath: string) => {
    setBusyAction(true);
    setError(null);
    try {
      await api.revertGitFile(targetPath, filePath);
      setNotice(`Reverted ${filePath}`);
      await loadGit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revert file");
    } finally {
      setBusyAction(false);
    }
  };

  const handleMergeWorktree = async () => {
    if (!session?.worktreePath || !session?.worktreeBranch) return;
    setBusyAction(true);
    setError(null);
    try {
      await api.mergeWorktree(
        repoPath,
        session.worktreePath,
        session.worktreeBranch
      );
      setNotice(`Merged worktree ${session.worktreeBranch}`);
      await loadGit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Worktree merge failed");
    } finally {
      setBusyAction(false);
    }
  };

  const handleDiscardWorktree = async () => {
    if (!session?.worktreePath || !session?.worktreeBranch) return;
    setBusyAction(true);
    setError(null);
    try {
      await api.discardWorktree(
        repoPath,
        session.worktreePath,
        session.worktreeBranch
      );
      setNotice(`Discarded worktree ${session.worktreeBranch}`);
      await loadGit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Worktree discard failed");
    } finally {
      setBusyAction(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.72)" }}
      role="dialog"
      aria-modal="true"
      aria-label="File Changes & Undo Drawer"
    >
      <div className="surface-card w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden">
        <div
          className="flex items-center justify-between gap-2 px-4 py-3 border-b"
          style={{ borderColor: "var(--border-default)" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <FileDiff className="w-5 h-5 shrink-0" style={{ color: "var(--accent-secondary)" }} />
            <div className="min-w-0">
              <h2 className="font-display text-base font-bold truncate">
                File Changes &amp; Undo
              </h2>
              <p className="text-xs font-mono truncate" style={{ color: "var(--text-muted)" }}>
                {status?.branch ? `${status.branch} · ` : ""}
                {targetPath}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadGit()}
              disabled={loading}
              className="btn-ghost !p-2"
              aria-label="Refresh git status"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost !p-2"
              aria-label="Close drawer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {error && (
            <div
              role="alert"
              className="rounded-[var(--radius-inner)] border p-3 text-xs"
              style={{
                backgroundColor: "var(--status-danger-bg)",
                borderColor: "var(--status-danger)",
                color: "var(--status-danger-fg)",
              }}
            >
              {error}
            </div>
          )}

          {notice && (
            <div
              className="rounded-[var(--radius-inner)] border p-3 text-xs"
              style={{
                backgroundColor: "var(--status-success-bg)",
                borderColor: "var(--status-success)",
                color: "var(--status-success-fg)",
              }}
            >
              {notice}
            </div>
          )}

          {session?.worktreePath && session?.worktreeBranch && (
            <div className="surface-subtle p-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-mono">
                <GitBranch className="w-4 h-4" style={{ color: "var(--accent-primary)" }} />
                <span>Worktree: {session.worktreeBranch}</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => void handleMergeWorktree()}
                  className="btn-primary !px-3 text-xs"
                >
                  <GitMerge className="w-4 h-4" />
                  Merge Worktree
                </button>
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => void handleDiscardWorktree()}
                  className="btn-danger !px-3 text-xs"
                >
                  <Trash2 className="w-4 h-4" />
                  Discard
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              <div className="skeleton-shimmer h-10 w-full" />
              <div className="skeleton-shimmer h-36 w-full" />
            </div>
          ) : !status || status.files.length === 0 ? (
            <div className="surface-subtle p-6 text-center space-y-1">
              <p className="text-sm font-medium">Working tree clean</p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No uncommitted edits detected in this workspace.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                {status.files.map((f) => (
                  <div
                    key={f.path}
                    className="surface-subtle px-3 py-2 flex items-center justify-between gap-2"
                    style={{
                      borderColor:
                        selectedFile === f.path
                          ? "var(--accent-secondary)"
                          : "var(--border-default)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => void handleSelectFile(f.path)}
                      className="flex-1 min-w-0 text-left flex items-center gap-2 min-h-[36px]"
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
                      <span className="font-mono text-xs truncate">{f.path}</span>
                    </button>
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={() => void handleRevert(f.path)}
                      className="btn-secondary !px-2.5 text-xs shrink-0"
                      aria-label={`Revert ${f.path}`}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Revert
                    </button>
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                <div className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                  Diff Preview {selectedFile ? `— ${selectedFile}` : ""}
                </div>
                <pre
                  className="surface-subtle p-3 text-xs font-mono overflow-x-auto max-h-64 leading-relaxed"
                >
                  {diffText ? (
                    diffText.split("\n").map((line, i) => {
                      const isAdd = line.startsWith("+") && !line.startsWith("+++");
                      const isDel = line.startsWith("-") && !line.startsWith("---");
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
                    })
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>
                      Select a changed file to inspect its unified diff.
                    </span>
                  )}
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
