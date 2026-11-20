import React, { useState } from "react";
import { GitBranch, Play, Sparkles } from "lucide-react";
import { useZeroG } from "../lib/store";
import type { ProviderId } from "../types/contracts";
import { ProjectIcon } from "./ProjectIcon";
import { ProviderBadge } from "./ProviderBadge";

const PROVIDERS: Array<{ id: ProviderId; subtitle: string }> = [
  { id: "antigravity", subtitle: "Priority #1 · Native 0G + SDK" },
  { id: "claude_code", subtitle: "Anthropic CLI stream-json" },
  { id: "codex_cli", subtitle: "OpenAI Codex exec --json" },
  { id: "grok_build", subtitle: "xAI Grok Build adapter" },
];

export const NewWorkerTab: React.FC = () => {
  const { projects, selectedProjectId, spawnWorker, setActiveTab } = useZeroG();

  const [projectId, setProjectId] = useState<string>(
    selectedProjectId || projects[0]?.id || "video-production"
  );
  const [provider, setProvider] = useState<ProviderId>("antigravity");
  const [useWorktree, setUseWorktree] = useState<boolean>(true);
  const [maxTokensBudget, setMaxTokensBudget] = useState<number>(120000);
  const [title, setTitle] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveProjectId =
    projects.some((p) => p.id === projectId)
      ? projectId
      : projects[0]?.id || projectId;

  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await spawnWorker({
        projectId: effectiveProjectId,
        provider,
        prompt: prompt.trim(),
        title: title.trim() || null,
        useWorktree,
        maxTokensBudget,
        model: model.trim() || null,
      });
      setPrompt("");
      setTitle("");
      setActiveTab("projects");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to spawn worker session"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSpawn(e)} className="space-y-4">
      <div className="surface-card p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" style={{ color: "var(--accent-primary)" }} />
          <div>
            <h2 className="font-display text-base font-bold">
              Spawn Mode B Phone Worker
            </h2>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Run a headless agent on your backpack laptop inside an isolated git worktree.
            </p>
          </div>
        </div>

        {/* 1. Project Picker */}
        <div className="space-y-2">
          <label
            htmlFor="worker-project-select"
            className="block text-xs font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            1. Target Project
          </label>
          {projects.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {projects.map((p) => {
                const active = effectiveProjectId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProjectId(p.id)}
                    className="surface-subtle p-2.5 flex items-center gap-2.5 text-left"
                    style={{
                      borderColor: active
                        ? "var(--accent-primary)"
                        : "var(--border-default)",
                    }}
                  >
                    <ProjectIcon
                      icon={p.icon}
                      accentToken={p.accentToken}
                      size="sm"
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">{p.name}</div>
                      <div
                        className="text-[11px] font-mono truncate"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {p.path}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <input
              id="worker-project-select"
              type="text"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          )}
        </div>

        {/* 2. Provider Picker */}
        <div className="space-y-2">
          <span
            className="block text-xs font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            2. Agent Provider
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {PROVIDERS.map((p) => {
              const active = provider === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setProvider(p.id)}
                  className="surface-subtle p-2.5 flex items-center justify-between gap-2 text-left"
                  style={{
                    borderColor: active
                      ? "var(--accent-primary)"
                      : "var(--border-default)",
                  }}
                >
                  <ProviderBadge provider={p.id} />
                  <span
                    className="text-[11px] truncate"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {p.subtitle}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. Worktree + Budget */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label
            className="surface-subtle p-3 flex items-center justify-between gap-3 cursor-pointer min-h-[54px]"
          >
            <div className="flex items-center gap-2 min-w-0">
              <GitBranch
                className="w-4 h-4 shrink-0"
                style={{ color: "var(--accent-secondary)" }}
              />
              <div>
                <div className="text-xs font-semibold">Isolated Git Worktree</div>
                <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Safe branch under .0g-worktrees
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              className="h-5 w-5 shrink-0"
            />
          </label>

          <div className="surface-subtle p-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold">Token Budget</span>
              <span
                className="font-mono font-bold tabular-nums"
                style={{ color: "var(--accent-primary)" }}
              >
                {maxTokensBudget.toLocaleString()}
              </span>
            </div>
            <input
              type="range"
              min={20000}
              max={500000}
              step={10000}
              value={maxTokensBudget}
              onChange={(e) => setMaxTokensBudget(Number(e.target.value))}
              className="w-full"
              aria-label="Token budget"
            />
          </div>
        </div>

        {/* Optional Title & Model */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Session title (optional)"
            className="rounded-[var(--radius-inner)] border px-3 py-2.5"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          />
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Model override (optional)"
            className="rounded-[var(--radius-inner)] border px-3 py-2.5 font-mono"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          />
        </div>

        {/* 4. Prompt */}
        <label className="block space-y-1.5">
          <span
            className="block text-xs font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            3. Task Prompt
          </span>
          <textarea
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the task for the headless worker..."
            className="w-full rounded-[var(--radius-inner)] border p-3"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
            required
          />
        </label>

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

        <button
          type="submit"
          disabled={submitting || !prompt.trim()}
          className="btn-primary w-full"
        >
          <Play className="w-4 h-4" />
          {submitting ? "Spawning Worker..." : "Launch Worker Session"}
        </button>
      </div>
    </form>
  );
};
