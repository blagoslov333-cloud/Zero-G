import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Edit3,
  Plus,
  Shield,
  ShieldBan,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useZeroG } from "../lib/store";
import type { ApprovalItem, ProviderId, RiskTier } from "../types/contracts";
import { ProviderBadge } from "./ProviderBadge";

function getTierStyle(tier: RiskTier): {
  label: string;
  bg: string;
  fg: string;
  border: string;
} {
  switch (tier) {
    case 0:
      return {
        label: "Tier 0 · Safe",
        bg: "var(--status-success-bg)",
        fg: "var(--status-success-fg)",
        border: "var(--status-success)",
      };
    case 1:
      return {
        label: "Tier 1 · Workspace",
        bg: "var(--status-info-bg)",
        fg: "var(--status-info-fg)",
        border: "var(--status-info)",
      };
    case 2:
      return {
        label: "Tier 2 · Network / Side-Effect",
        bg: "var(--status-warning-bg)",
        fg: "var(--status-warning-fg)",
        border: "var(--status-warning)",
      };
    case 3:
    default:
      return {
        label: "Tier 3 · Critical Guard",
        bg: "var(--status-danger-bg)",
        fg: "var(--status-danger-fg)",
        border: "var(--status-danger)",
      };
  }
}

export const InboxTab: React.FC = () => {
  const {
    loading,
    approvals,
    decideApproval,
    rules,
    saveRule,
    deleteRule,
    agentGateMode,
    setAgentGateMode,
  } = useZeroG();

  const [nowSec, setNowSec] = useState<number>(() => Date.now() / 1000);
  const [editingApproval, setEditingApproval] = useState<ApprovalItem | null>(
    null
  );
  const [overwriteJson, setOverwriteJson] = useState<string>("");
  const [editError, setEditError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Smart rule creator state
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [ruleProvider, setRuleProvider] = useState<ProviderId | "*">("*");
  const [ruleTool, setRuleTool] = useState("run_command");
  const [ruleRegex, setRuleRegex] = useState("");
  const [ruleAction, setRuleAction] = useState<"allow" | "deny" | "ask">("allow");
  const [ruleError, setRuleError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSec(Date.now() / 1000);
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  const pendingOrEscalated = approvals.filter(
    (a) => a.status === "pending" || a.status === "escalated"
  );
  const resolvedHistory = approvals
    .filter((a) => a.status !== "pending" && a.status !== "escalated")
    .slice(0, 10);

  const openEditor = (item: ApprovalItem) => {
    setEditingApproval(item);
    setOverwriteJson(JSON.stringify(item.rawArgs || {}, null, 2));
    setEditError(null);
  };

  const handleDecision = async (
    item: ApprovalItem,
    action: "approve" | "edit_approve" | "deny" | "allow_30m",
    overwriteArgs?: Record<string, unknown>
  ) => {
    setBusyId(item.id);
    try {
      await decideApproval(item.id, {
        action,
        overwriteArgs: overwriteArgs || null,
      });
      if (editingApproval?.id === item.id) {
        setEditingApproval(null);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveOverwrite = async () => {
    if (!editingApproval) return;
    try {
      const parsed = JSON.parse(overwriteJson) as Record<string, unknown>;
      await handleDecision(editingApproval, "edit_approve", parsed);
    } catch {
      setEditError("Invalid JSON in overwrite arguments.");
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleName.trim() || !ruleRegex.trim()) return;
    setRuleError(null);
    try {
      await saveRule({
        name: ruleName.trim(),
        provider: ruleProvider,
        toolPattern: ruleTool.trim() || "*",
        commandRegex: ruleRegex.trim(),
        action: ruleAction,
        riskTier: ruleAction === "deny" ? 3 : 1,
        enabled: true,
      });
      setRuleName("");
      setRuleRegex("");
      setShowRuleForm(false);
    } catch (err) {
      setRuleError(err instanceof Error ? err.message : "Failed to save rule");
    }
  };

  return (
    <div className="space-y-5">
      {/* Agent Approval Mode (Independent from Laptop Hardware Power) */}
      <section aria-label="Agent Gate Mode" className="surface-card p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-sm font-bold">
              Agent Approval Gate
            </h2>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Controls whether agents ask your phone or auto-run workspace steps.
              Laptop power (Ultra-Sip / Max Turbo) never overrides this.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void setAgentGateMode("ask_on_phone")}
            className={
              agentGateMode === "ask_on_phone"
                ? "btn-primary !flex-col !items-start !h-auto py-2.5 text-left"
                : "btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
            }
          >
            <span className="text-xs font-bold">Ask on Phone</span>
            <span className="text-[11px] opacity-80">
              Push Allow / Deny to app
            </span>
          </button>
          <button
            type="button"
            onClick={() => void setAgentGateMode("agent_turbo")}
            className={
              agentGateMode === "agent_turbo"
                ? "btn-primary !flex-col !items-start !h-auto py-2.5 text-left"
                : "btn-secondary !flex-col !items-start !h-auto py-2.5 text-left"
            }
          >
            <span className="text-xs font-bold">Agent Turbo</span>
            <span className="text-[11px] opacity-80">
              Auto-allow Tier 0–2 · Block Tier 3
            </span>
          </button>
        </div>
      </section>

      {/* Pending 25s-Hold Approvals */}
      <section aria-label="Pending Tool Approvals" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2
            className="font-display text-sm font-bold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            Approvals Inbox ({pendingOrEscalated.length})
          </h2>
        </div>

        {loading && approvals.length === 0 ? (
          <div className="space-y-2.5">
            <div className="skeleton-shimmer h-36 w-full" />
          </div>
        ) : pendingOrEscalated.length === 0 ? (
          <div className="surface-card p-6 text-center space-y-2">
            <ShieldCheck
              className="w-8 h-8 mx-auto"
              style={{ color: "var(--status-success)" }}
            />
            <p className="text-sm font-medium">Inbox Clear</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              When an agent triggers a Mode A PreToolUse hook, you have 25s to
              approve, edit args, or deny from your phone before it escalates to
              your laptop UI.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {pendingOrEscalated.map((item) => {
              const totalHold = item.holdSeconds || 25;
              const remaining = Math.max(0, item.expiresAt - nowSec);
              const isEscalated =
                item.status === "escalated" ||
                (item.status === "pending" && remaining <= 0);
              const pct = Math.min(100, Math.max(0, (remaining / totalHold) * 100));
              const tier = getTierStyle(item.riskTier);
              const isBusy = busyId === item.id;

              return (
                <article
                  key={item.id}
                  className="surface-card p-3.5 space-y-3"
                  style={{
                    borderColor: isEscalated
                      ? "var(--status-warning)"
                      : item.riskTier >= 3
                        ? "var(--status-danger)"
                        : "var(--border-default)",
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <ProviderBadge provider={item.provider} />
                      <span
                        className="rounded-full px-2.5 py-1 text-xs font-medium border"
                        style={{
                          backgroundColor: tier.bg,
                          color: tier.fg,
                          borderColor: tier.border,
                        }}
                      >
                        {tier.label}
                      </span>
                    </div>

                    {isEscalated ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold border"
                        style={{
                          backgroundColor: "var(--status-warning-bg)",
                          color: "var(--status-warning-fg)",
                          borderColor: "var(--status-warning)",
                        }}
                      >
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Escalated to Antigravity Native UI
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 font-mono text-xs font-bold tabular-nums"
                        style={{
                          color:
                            remaining <= 6
                              ? "var(--status-danger)"
                              : "var(--status-warning)",
                        }}
                      >
                        <Clock className="w-3.5 h-3.5" />
                        {remaining.toFixed(1)}s
                      </span>
                    )}
                  </div>

                  {/* Live 25s Countdown Progress Bar */}
                  {!isEscalated && (
                    <div
                      className="h-1.5 w-full rounded-full overflow-hidden"
                      style={{ backgroundColor: "var(--bg-subtle)" }}
                    >
                      <div
                        className="h-full"
                        style={{
                          width: `${pct}%`,
                          backgroundColor:
                            remaining <= 6
                              ? "var(--status-danger)"
                              : "var(--status-warning)",
                        }}
                      />
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <div className="text-xs font-mono font-semibold">
                      Tool: {item.toolName}
                    </div>
                    <pre
                      className="surface-subtle p-2.5 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed"
                    >
                      {item.commandPreview ||
                        JSON.stringify(item.rawArgs, null, 2)}
                    </pre>
                  </div>

                  {(item.astSummary?.length > 0 ||
                    item.riskReasons?.length > 0) && (
                    <div className="flex flex-wrap gap-1.5">
                      {item.astSummary?.map((flag, i) => (
                        <span
                          key={`ast-${i}`}
                          className="rounded px-2 py-0.5 text-[11px] font-mono border"
                          style={{
                            backgroundColor: "var(--bg-subtle)",
                            borderColor: "var(--border-default)",
                            color: "var(--accent-secondary)",
                          }}
                        >
                          AST: {flag}
                        </span>
                      ))}
                      {item.riskReasons?.map((reason, i) => (
                        <span
                          key={`rsn-${i}`}
                          className="rounded px-2 py-0.5 text-[11px] font-mono border"
                          style={{
                            backgroundColor: "var(--status-warning-bg)",
                            borderColor: "var(--status-warning)",
                            color: "var(--status-warning-fg)",
                          }}
                        >
                          {reason}
                        </span>
                      ))}
                    </div>
                  )}

                  {!isEscalated && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleDecision(item, "approve")}
                        className="btn-primary text-xs"
                      >
                        <Check className="w-4 h-4" />
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => openEditor(item)}
                        className="btn-secondary text-xs"
                      >
                        <Edit3 className="w-4 h-4" />
                        Edit &amp; Approve
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleDecision(item, "allow_30m")}
                        className="btn-secondary text-xs"
                      >
                        <Shield className="w-4 h-4" />
                        Allow 30m
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleDecision(item, "deny")}
                        className="btn-danger text-xs"
                      >
                        <ShieldBan className="w-4 h-4" />
                        Deny
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Edit & Approve Overwrite Drawer */}
      {editingApproval && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.72)" }}
          role="dialog"
          aria-modal="true"
          aria-label="Edit and Approve Tool Arguments"
        >
          <div className="surface-card w-full max-w-lg p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-base font-bold">
                  Edit &amp; Approve (Overwrite Args)
                </h3>
                <p className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
                  {editingApproval.toolName} · Re-evaluated by AST Rules Engine
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingApproval(null)}
                className="btn-ghost !p-2"
                aria-label="Close overwrite editor"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              rows={8}
              value={overwriteJson}
              onChange={(e) => setOverwriteJson(e.target.value)}
              className="w-full rounded-[var(--radius-inner)] border p-3 font-mono text-xs"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
            />

            {editError && (
              <p className="text-xs" style={{ color: "var(--status-danger)" }}>
                {editError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingApproval(null)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveOverwrite()}
                className="btn-primary"
              >
                <Check className="w-4 h-4" />
                Apply Overwrite &amp; Approve
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recent Resolved History */}
      {resolvedHistory.length > 0 && (
        <section aria-label="Recent Decisions" className="space-y-2">
          <h3
            className="font-display text-xs font-bold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            Recent Decisions
          </h3>
          <div className="space-y-1.5">
            {resolvedHistory.map((item) => (
              <div
                key={item.id}
                className="surface-card px-3 py-2 flex items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-mono font-semibold truncate">
                    {item.toolName}: {item.commandPreview}
                  </div>
                </div>
                <span
                  className="font-mono uppercase text-[11px] shrink-0"
                  style={{
                    color:
                      item.status === "denied" || item.status === "auto_denied"
                        ? "var(--status-danger)"
                        : "var(--status-success)",
                  }}
                >
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Smart Rules Manager */}
      <section aria-label="Smart Rules Manager" className="surface-card p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-sm font-bold">Smart AST Rules</h3>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Auto-allow safe commands, 30-minute temporary grants, and Tier-3 self-protection.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowRuleForm((v) => !v)}
            className="btn-secondary text-xs shrink-0"
          >
            <Plus className="w-4 h-4" />
            Add Rule
          </button>
        </div>

        {showRuleForm && (
          <form
            onSubmit={(e) => void handleCreateRule(e)}
            className="surface-subtle p-3 space-y-2.5"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                placeholder="Rule name (e.g. Allow pytest)"
                className="rounded-[var(--radius-inner)] border px-3 py-2 text-sm"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
                required
              />
              <select
                value={ruleProvider}
                onChange={(e) =>
                  setRuleProvider(e.target.value as ProviderId | "*")
                }
                className="rounded-[var(--radius-inner)] border px-3 py-2 text-sm"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="*">All Providers</option>
                <option value="antigravity">Antigravity</option>
                <option value="claude_code">Claude Code</option>
                <option value="codex_cli">Codex CLI</option>
                <option value="grok_build">Grok Build</option>
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                value={ruleTool}
                onChange={(e) => setRuleTool(e.target.value)}
                placeholder="Tool pattern (run_command)"
                className="rounded-[var(--radius-inner)] border px-3 py-2 font-mono text-xs"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
              <input
                type="text"
                value={ruleRegex}
                onChange={(e) => setRuleRegex(e.target.value)}
                placeholder="Command regex (e.g. ^pytest)"
                className="rounded-[var(--radius-inner)] border px-3 py-2 font-mono text-xs sm:col-span-2"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
                required
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <select
                value={ruleAction}
                onChange={(e) =>
                  setRuleAction(e.target.value as "allow" | "deny" | "ask")
                }
                className="rounded-[var(--radius-inner)] border px-3 py-2 text-sm"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="allow">Auto-Allow</option>
                <option value="ask">Ask (25s Hold)</option>
                <option value="deny">Hard Deny</option>
              </select>
              <button type="submit" className="btn-primary text-xs">
                Save Rule
              </button>
            </div>
            {ruleError && (
              <p className="text-xs" style={{ color: "var(--status-danger)" }}>
                {ruleError}
              </p>
            )}
          </form>
        )}

        <div className="space-y-1.5">
          {rules.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              No custom rules loaded yet.
            </p>
          ) : (
            rules.map((r) => (
              <div
                key={r.id}
                className="surface-subtle px-3 py-2 flex items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">{r.name}</span>
                    <span
                      className="font-mono uppercase text-[10px] px-1.5 py-0.5 rounded border"
                      style={{
                        borderColor:
                          r.action === "deny"
                            ? "var(--status-danger)"
                            : r.action === "allow"
                              ? "var(--status-success)"
                              : "var(--status-warning)",
                        color:
                          r.action === "deny"
                            ? "var(--status-danger)"
                            : r.action === "allow"
                              ? "var(--status-success)"
                              : "var(--status-warning)",
                      }}
                    >
                      {r.action}
                    </span>
                    <span className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                      T{r.riskTier} · {r.provider}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
                    {r.toolPattern} ~ /{r.commandRegex}/
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void deleteRule(r.id)}
                  className="btn-ghost !p-2 shrink-0"
                  aria-label={`Delete rule ${r.name}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
};
