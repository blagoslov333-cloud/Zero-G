import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Clock,
  Folder,
  Play,
  Terminal,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import { useZeroG } from "../lib/store";

const PRESET_COMMANDS = [
  "git status",
  "git log -5 --oneline",
  "pytest",
  "npm run build",
];

interface TerminalEntry {
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

function stripAnsi(input: string): string {
  // Remove standard ANSI CSI / OSC escape sequences cleanly
  return input
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

export const TerminalTab: React.FC = () => {
  const { agyProjects, selectedProjectPath, terminalCwd, setTerminalCwd } =
    useZeroG();

  const [commandInput, setCommandInput] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<TerminalEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const effectiveCwd =
    terminalCwd || selectedProjectPath || agyProjects[0]?.path || "";

  useEffect(() => {
    if (!terminalCwd && (selectedProjectPath || agyProjects[0]?.path)) {
      setTerminalCwd(selectedProjectPath || agyProjects[0]?.path || null);
    }
  }, [terminalCwd, selectedProjectPath, agyProjects, setTerminalCwd]);

  const runCommand = async (rawCommand: string) => {
    const cmd = rawCommand.trim();
    if (!cmd || running) return;
    setRunning(true);
    const id = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      const res = await api.execAgyTerminal(cmd, effectiveCwd || null);
      setHistory((prev) => [
        ...prev,
        {
          id,
          command: cmd,
          cwd: res.cwd || effectiveCwd || ".",
          returncode: res.returncode,
          stdout: stripAnsi(res.stdout || ""),
          stderr: stripAnsi(res.stderr || ""),
          durationMs: res.durationMs ?? 0,
          timedOut: Boolean(res.timedOut),
        },
      ]);
      setCommandInput("");
    } catch (err) {
      setHistory((prev) => [
        ...prev,
        {
          id,
          command: cmd,
          cwd: effectiveCwd || ".",
          returncode: -1,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          error: err instanceof Error ? err.message : "Command execution failed",
        },
      ]);
    } finally {
      setRunning(false);
      window.setTimeout(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 60);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runCommand(commandInput);
  };

  return (
    <div className="space-y-3">
      {/* Project Folder & Preset Controls */}
      <section aria-label="Terminal Controls" className="surface-card p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal
              className="w-5 h-5 shrink-0"
              style={{ color: "var(--accent-primary)" }}
            />
            <h1 className="font-display text-base font-bold truncate">
              Laptop Terminal
            </h1>
          </div>
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => setHistory([])}
              className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
            >
              <Trash2 className="w-4 h-4" />
              <span>Clear</span>
            </button>
          )}
        </div>

        <label className="block space-y-1">
          <span
            className="text-xs font-semibold flex items-center gap-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            <Folder className="w-3.5 h-3.5" />
            Working Directory
          </span>
          <select
            value={effectiveCwd}
            onChange={(e) => setTerminalCwd(e.target.value || null)}
            className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5 text-base font-mono"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          >
            {agyProjects.length === 0 && (
              <option value="">Default Host Directory</option>
            )}
            {agyProjects.map((proj) => (
              <option key={proj.id} value={proj.path}>
                {proj.name} — {proj.path}
              </option>
            ))}
          </select>
        </label>

        {/* Preset Shortcut Chips */}
        <div className="flex flex-wrap gap-1.5">
          {PRESET_COMMANDS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={running}
              onClick={() => void runCommand(preset)}
              className="btn-secondary !min-h-[44px] !px-3 text-xs font-mono"
            >
              {preset}
            </button>
          ))}
        </div>
      </section>

      {/* Scrollable Output History Log */}
      <section
        aria-label="Command Output Log"
        className="surface-card p-3 space-y-2.5 min-h-[280px] max-h-[52vh] overflow-y-auto"
        style={{ backgroundColor: "var(--bg-canvas)" }}
      >
        {history.length === 0 ? (
          <div
            className="py-10 text-center text-xs space-y-1"
            style={{ color: "var(--text-muted)" }}
          >
            <p className="font-medium" style={{ color: "var(--text-primary)" }}>
              Ready to run commands on your laptop
            </p>
            <p>
              Tap a preset chip above or enter any shell command below.
            </p>
          </div>
        ) : (
          history.map((entry) => {
            const ok = entry.returncode === 0 && !entry.error && !entry.timedOut;
            return (
              <article
                key={entry.id}
                className="rounded-[var(--radius-inner)] border p-2.5 space-y-1.5 font-mono text-xs"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: ok
                    ? "var(--border-default)"
                    : "var(--status-danger)",
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-bold break-all">
                    <span style={{ color: "var(--accent-primary)" }}>$ </span>
                    <span>{entry.command}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] tabular-nums shrink-0">
                    {entry.timedOut && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border"
                        style={{
                          backgroundColor: "var(--status-warning-bg)",
                          borderColor: "var(--status-warning)",
                          color: "var(--status-warning-fg)",
                        }}
                      >
                        <Clock className="w-3 h-3" />
                        Timed out
                      </span>
                    )}
                    <span
                      className="px-1.5 py-0.5 rounded border"
                      style={{
                        backgroundColor: ok
                          ? "var(--status-success-bg)"
                          : "var(--status-danger-bg)",
                        borderColor: ok
                          ? "var(--status-success)"
                          : "var(--status-danger)",
                        color: ok
                          ? "var(--status-success-fg)"
                          : "var(--status-danger-fg)",
                      }}
                    >
                      exit {entry.returncode}
                    </span>
                    <span style={{ color: "var(--text-muted)" }}>
                      {entry.durationMs}ms
                    </span>
                  </div>
                </div>

                <div
                  className="text-[11px] truncate"
                  style={{ color: "var(--text-muted)" }}
                >
                  {entry.cwd}
                </div>

                {entry.error && (
                  <div
                    className="flex items-start gap-1.5 text-xs break-words"
                    style={{ color: "var(--status-danger-fg)" }}
                  >
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{entry.error}</span>
                  </div>
                )}

                {entry.stdout && (
                  <pre className="whitespace-pre-wrap break-words overflow-x-auto leading-relaxed max-h-72 overflow-y-auto">
                    {entry.stdout}
                  </pre>
                )}

                {entry.stderr && (
                  <pre
                    className="whitespace-pre-wrap break-words overflow-x-auto leading-relaxed max-h-60 overflow-y-auto pt-1 border-t"
                    style={{
                      color: "var(--status-danger-fg)",
                      borderColor: "var(--border-default)",
                    }}
                  >
                    {entry.stderr}
                  </pre>
                )}

                {!entry.stdout && !entry.stderr && !entry.error && (
                  <div
                    className="text-[11px] italic"
                    style={{ color: "var(--text-muted)" }}
                  >
                    (No output)
                  </div>
                )}
              </article>
            );
          })
        )}
        <div ref={logEndRef} />
      </section>

      {/* Command Input Bar */}
      <form
        onSubmit={handleSubmit}
        className="surface-card p-2.5 flex items-center gap-2"
      >
        <input
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          placeholder="Run command on laptop..."
          disabled={running}
          aria-label="Terminal command"
          className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2.5 text-base font-mono"
          style={{
            backgroundColor: "var(--bg-subtle)",
            borderColor: "var(--border-default)",
            color: "var(--text-primary)",
          }}
        />
        <button
          type="submit"
          disabled={running || !commandInput.trim()}
          className="btn-primary !min-h-[44px] !px-4 text-xs shrink-0"
        >
          <Play className="w-4 h-4 shrink-0" />
          <span>{running ? "Running…" : "Run"}</span>
        </button>
      </form>
    </div>
  );
};
