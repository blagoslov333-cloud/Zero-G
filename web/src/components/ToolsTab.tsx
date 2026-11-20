import React, { useState } from "react";
import {
  CalendarClock,
  FlaskConical,
  Play,
  Plus,
  Save,
  Smartphone,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";
import { executeMobileToolLocally } from "../lib/mobileToolRunner";
import { useZeroG } from "../lib/store";
import type { MobileToolRuntime, MobileToolSpec } from "../types/contracts";

const DEFAULT_PARAMS_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      message: { type: "string", description: "Message or input payload" },
    },
    required: [],
  },
  null,
  2
);

const DEFAULT_PHONE_JS = `// Runs safely on your phone when a laptop agent calls this MCP tool.
// Available: args, ctx.notify(title, body), ctx.askInput(prompt, choices),
//            ctx.clipboard(), ctx.location(), ctx.speak(text)
await ctx.notify("Custom Phone Tool", args.message || "Hello from 0G!");
return { acknowledged: true, at: ctx.now(), input: args };`;

export const ToolsTab: React.FC = () => {
  const {
    automations,
    runAutomation,
    macros,
    runMacro,
    mobileTools,
    saveMobileTool,
    deleteMobileTool,
    pushNotifyCard,
    openPromptModal,
  } = useZeroG();

  // Tool Studio state
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [toolName, setToolName] = useState("phone_quick_ping");
  const [toolDesc, setToolDesc] = useState(
    "Send an urgent ping card & spoken alert to my phone."
  );
  const [runtime, setRuntime] = useState<MobileToolRuntime>("phone_js");
  const [paramsText, setParamsText] = useState(DEFAULT_PARAMS_SCHEMA);
  const [codeBody, setCodeBody] = useState(DEFAULT_PHONE_JS);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [testArgsText, setTestArgsText] = useState('{"message": "Build finished!"}');
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [savingTool, setSavingTool] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const loadToolIntoStudio = (t: MobileToolSpec) => {
    setEditingId(t.id);
    setToolName(t.name);
    setToolDesc(t.description);
    setRuntime(t.runtime);
    setParamsText(JSON.stringify(t.parametersSchema || {}, null, 2));
    setCodeBody(t.code || "");
    setRequiresApproval(t.requiresApproval);
    setTestOutput(null);
    setStudioError(null);
    setSaveNotice(null);
  };

  const resetStudio = () => {
    setEditingId(undefined);
    setToolName("");
    setToolDesc("");
    setRuntime("phone_js");
    setParamsText(DEFAULT_PARAMS_SCHEMA);
    setCodeBody(DEFAULT_PHONE_JS);
    setRequiresApproval(false);
    setTestOutput(null);
    setStudioError(null);
    setSaveNotice(null);
  };

  const handleTestOnPhone = async (
    targetName = toolName,
    targetRuntime = runtime,
    targetCode = codeBody
  ) => {
    setStudioError(null);
    setTestOutput(null);
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = testArgsText.trim()
        ? (JSON.parse(testArgsText) as Record<string, unknown>)
        : {};
    } catch {
      setStudioError("Invalid JSON in Test Arguments.");
      return;
    }

    if (targetRuntime === "host_command") {
      setTestOutput(
        "host_command runs on the Windows laptop daemon (checked by RulesEngine). Save to MCP and call from an agent or Macro."
      );
      return;
    }

    const res = await executeMobileToolLocally(
      {
        ticketId: `local_test_${Date.now()}`,
        toolName: targetName,
        arguments: parsedArgs,
        runtime: targetRuntime,
        code: targetCode,
      },
      { pushNotifyCard, openPromptModal }
    );
    setTestOutput(JSON.stringify(res, null, 2));
  };

  const handleSaveTool = async (e: React.FormEvent) => {
    e.preventDefault();
    setStudioError(null);
    setSaveNotice(null);

    const cleanName = toolName.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,48}$/.test(cleanName)) {
      setStudioError(
        "Tool name must match ^[a-z][a-z0-9_]{1,48}$ (lowercase letters, digits, underscores)."
      );
      return;
    }

    let parsedSchema: Record<string, unknown>;
    try {
      parsedSchema = JSON.parse(paramsText) as Record<string, unknown>;
    } catch {
      setStudioError("Invalid JSON in Parameters Schema.");
      return;
    }

    setSavingTool(true);
    try {
      await saveMobileTool({
        id: editingId,
        name: cleanName,
        description: toolDesc.trim(),
        runtime,
        parametersSchema: parsedSchema,
        code: codeBody,
        requiresApproval,
        enabled: true,
      });
      setSaveNotice(`Saved "${cleanName}" — live in MCP tools/list immediately!`);
    } catch (err) {
      setStudioError(
        err instanceof Error ? err.message : "Failed to save mobile tool"
      );
    } finally {
      setSavingTool(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* 1. Scheduled Automations (jetski_sidecar crons) */}
      <section aria-label="Scheduled Automations" className="surface-card p-3.5 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarClock
            className="w-4 h-4"
            style={{ color: "var(--accent-secondary)" }}
          />
          <h2 className="font-display text-sm font-bold">
            Scheduled Automations ({automations.length})
          </h2>
        </div>

        {automations.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            No jetski_sidecar cron automations found in ~/.gemini/jetski/sidecars.
          </p>
        ) : (
          <div className="space-y-2">
            {automations.map((auto) => (
              <div
                key={auto.slug}
                className="surface-subtle p-3 flex items-start justify-between gap-2"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">{auto.name}</span>
                    <span
                      className="font-mono text-[11px] px-2 py-0.5 rounded border"
                      style={{
                        borderColor: "var(--border-default)",
                        color: "var(--accent-secondary)",
                      }}
                    >
                      {auto.schedule}
                    </span>
                  </div>
                  <p
                    className="text-xs break-words"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {auto.prompt}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void runAutomation(auto.slug)}
                  className="btn-secondary !px-3 text-xs shrink-0"
                >
                  <Play className="w-3.5 h-3.5" />
                  Run
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. One-Tap Laptop Macros */}
      <section aria-label="One-Tap Laptop Macros" className="surface-card p-3.5 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4" style={{ color: "var(--status-warning)" }} />
          <h2 className="font-display text-sm font-bold">One-Tap Laptop Macros</h2>
        </div>

        {macros.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            No macros registered yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {macros.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => void runMacro(m.id)}
                className="surface-subtle p-3 text-left flex items-center justify-between gap-2 min-h-[52px]"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">{m.name}</div>
                  <div
                    className="text-[11px] font-mono truncate"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {m.command}
                  </div>
                </div>
                <Play
                  className="w-4 h-4 shrink-0"
                  style={{ color: "var(--accent-primary)" }}
                />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 3. Mobile Tool Authoring Studio */}
      <section
        aria-label="Mobile Tool Authoring Studio"
        className="surface-card p-3.5 space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wrench
              className="w-4 h-4"
              style={{ color: "var(--accent-primary)" }}
            />
            <div>
              <h2 className="font-display text-sm font-bold">
                Mobile Tool Authoring Studio
              </h2>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Author custom MCP tools on your phone — exposed live via MCP{" "}
                <code>tools/list</code>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={resetStudio}
            className="btn-ghost text-xs shrink-0"
          >
            <Plus className="w-4 h-4" />
            New
          </button>
        </div>

        <form onSubmit={(e) => void handleSaveTool(e)} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="space-y-1">
              <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Tool Name (snake_case)
              </span>
              <input
                type="text"
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                placeholder="phone_custom_tool"
                className="w-full rounded-[var(--radius-inner)] border px-3 py-2 font-mono text-sm"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
                required
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Execution Runtime
              </span>
              <select
                value={runtime}
                onChange={(e) => setRuntime(e.target.value as MobileToolRuntime)}
                className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-sm"
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="phone_js">phone_js (Executes on Phone)</option>
                <option value="host_command">
                  host_command (Executes on Laptop via Rules)
                </option>
              </select>
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              MCP Tool Description
            </span>
            <input
              type="text"
              value={toolDesc}
              onChange={(e) => setToolDesc(e.target.value)}
              placeholder="What this tool does for the agent..."
              className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-sm"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
              required
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              JSON Parameters Schema
            </span>
            <textarea
              rows={4}
              value={paramsText}
              onChange={(e) => setParamsText(e.target.value)}
              className="w-full rounded-[var(--radius-inner)] border p-2.5 font-mono text-xs"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              {runtime === "phone_js"
                ? "Phone JS Body (async: args, ctx)"
                : "Host Command Template (e.g. pwsh -Command \"{{input}}\")"}
            </span>
            <textarea
              rows={5}
              value={codeBody}
              onChange={(e) => setCodeBody(e.target.value)}
              className="w-full rounded-[var(--radius-inner)] border p-2.5 font-mono text-xs"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-center">
            <label className="flex items-center gap-2 text-xs min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                checked={requiresApproval}
                onChange={(e) => setRequiresApproval(e.target.checked)}
                className="h-4 w-4"
              />
              <span>Require 25s phone approval before execution</span>
            </label>
            <input
              type="text"
              value={testArgsText}
              onChange={(e) => setTestArgsText(e.target.value)}
              placeholder='Test JSON args e.g. {"message":"hi"}'
              aria-label="Test arguments JSON"
              className="rounded-[var(--radius-inner)] border px-3 py-2 font-mono text-xs"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          {studioError && (
            <div
              role="alert"
              className="rounded-[var(--radius-inner)] border p-2.5 text-xs"
              style={{
                backgroundColor: "var(--status-danger-bg)",
                borderColor: "var(--status-danger)",
                color: "var(--status-danger-fg)",
              }}
            >
              {studioError}
            </div>
          )}

          {saveNotice && (
            <div
              className="rounded-[var(--radius-inner)] border p-2.5 text-xs"
              style={{
                backgroundColor: "var(--status-success-bg)",
                borderColor: "var(--status-success)",
                color: "var(--status-success-fg)",
              }}
            >
              {saveNotice}
            </div>
          )}

          {testOutput && (
            <pre className="surface-subtle p-2.5 font-mono text-xs overflow-x-auto">
              {testOutput}
            </pre>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void handleTestOnPhone()}
              className="btn-secondary text-xs"
            >
              <FlaskConical className="w-4 h-4" />
              Test on Phone
            </button>
            <button
              type="submit"
              disabled={savingTool}
              className="btn-primary text-xs"
            >
              <Save className="w-4 h-4" />
              {savingTool ? "Saving…" : "Save to MCP"}
            </button>
          </div>
        </form>
      </section>

      {/* 4. Registered Mobile & Custom MCP Tools */}
      <section aria-label="Registered Phone Tools" className="surface-card p-3.5 space-y-2.5">
        <div className="flex items-center gap-2">
          <Smartphone
            className="w-4 h-4"
            style={{ color: "var(--accent-secondary)" }}
          />
          <h2 className="font-display text-sm font-bold">
            Live MCP Phone Tools ({mobileTools.length})
          </h2>
        </div>

        <div className="space-y-2">
          {mobileTools.map((t) => (
            <div
              key={t.id}
              className="surface-subtle p-3 flex items-start justify-between gap-2 text-xs"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono font-bold">{t.name}</span>
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-mono border"
                    style={{
                      borderColor: "var(--border-default)",
                      color: "var(--accent-secondary)",
                    }}
                  >
                    {t.runtime}
                  </span>
                </div>
                <p style={{ color: "var(--text-muted)" }}>{t.description}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => loadToolIntoStudio(t)}
                  className="btn-secondary !px-2.5 text-xs"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void handleTestOnPhone(t.name, t.runtime, t.code)
                  }
                  className="btn-secondary !px-2.5 text-xs"
                >
                  Test
                </button>
                {t.runtime !== "phone_builtin" && (
                  <button
                    type="button"
                    onClick={() => void deleteMobileTool(t.id)}
                    className="btn-ghost !p-2"
                    aria-label={`Delete tool ${t.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
