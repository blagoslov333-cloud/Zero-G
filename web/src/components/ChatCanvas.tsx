import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FileCode2,
  FolderGit2,
  GitBranch,
  Globe,
  HelpCircle,
  Layers,
  Lock,
  MessageSquareReply,
  Play,
  RefreshCw,
  Shield,
  ShieldBan,
  Sparkles,
  Unlock,
  Users,
  WifiOff,
  Wrench,
} from "lucide-react";
import { useZeroG } from "../lib/store";
import type {
  AgyArtifactSummary,
  AgyMessage,
  AgyPlanReview,
  AgyQuestionItem,
  ApprovalItem,
} from "../types/contracts";
import { MessageComposer } from "./MessageComposer";
import { VoiceCallBar } from "./VoiceCallBar";

function folderBasename(p?: string | null): string {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
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

function renderMessageMarkdownBlocks(text: string): React.ReactNode {
  if (!text) return null;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const inner = part.slice(3, -3);
      const nl = inner.indexOf("\n");
      const lang = nl > -1 ? inner.slice(0, nl).trim() : "";
      const code = nl > -1 ? inner.slice(nl + 1) : inner;
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
              className="px-3 py-1 text-[10px] font-mono uppercase border-b"
              style={{
                color: "var(--text-muted)",
                borderColor: "var(--border-default)",
              }}
            >
              {lang}
            </div>
          )}
          <pre className="p-3 text-xs font-mono overflow-x-auto leading-relaxed">
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

/* ============================================================================
 * Inline Implementation Plan Review Card
 * ============================================================================ */
const InlinePlanReviewCard: React.FC<{
  plan: AgyPlanReview;
  onViewPlan: () => void;
  onSendReply: (text: string) => Promise<void>;
}> = ({ plan, onViewPlan, onSendReply }) => {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [busy, setBusy] = useState(false);
  const [submittedNote, setSubmittedNote] = useState<string | null>(null);

  const handleProceed = async () => {
    setBusy(true);
    try {
      await onSendReply("Proceed with the plan.");
      setSubmittedNote("Approved — Proceeding with implementation plan.");
    } finally {
      setBusy(false);
    }
  };

  const handleSendFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedbackText.trim() || busy) return;
    setBusy(true);
    try {
      await onSendReply(`Plan feedback: ${feedbackText.trim()}`);
      setSubmittedNote("Feedback sent to Antigravity.");
      setFeedbackText("");
      setShowFeedback(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-[var(--radius-inner)] border p-3 space-y-2.5"
      style={{
        backgroundColor: "var(--bg-subtle)",
        borderColor: "var(--accent-primary)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <div
            className="text-[11px] font-mono uppercase font-semibold"
            style={{ color: "var(--accent-primary)" }}
          >
            Implementation Plan Ready
          </div>
          <div className="font-display text-sm font-bold break-words">
            {plan.title || "Implementation Plan"}
          </div>
        </div>
      </div>

      {plan.summary && (
        <p
          className="text-xs whitespace-pre-wrap break-words leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {plan.summary}
        </p>
      )}

      {submittedNote ? (
        <div
          className="text-xs font-medium"
          style={{ color: "var(--status-success-fg)" }}
        >
          {submittedNote}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onViewPlan}
              className="btn-secondary !min-h-[44px] !px-3 text-xs"
            >
              <FileCode2 className="w-4 h-4 shrink-0" />
              <span>View Plan</span>
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => void handleProceed()}
              className="btn-primary !min-h-[44px] !px-3.5 text-xs"
            >
              <Play className="w-4 h-4 shrink-0" />
              <span>Proceed</span>
            </button>

            <button
              type="button"
              onClick={() => setShowFeedback((v) => !v)}
              className="btn-secondary !min-h-[44px] !px-3 text-xs"
            >
              <MessageSquareReply className="w-4 h-4 shrink-0" />
              <span>Send Feedback</span>
            </button>
          </div>

          {showFeedback && (
            <form
              onSubmit={(e) => void handleSendFeedback(e)}
              className="flex items-center gap-2 pt-1"
            >
              <input
                type="text"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Suggest adjustments to the plan…"
                className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2 text-base"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
              <button
                type="submit"
                disabled={busy || !feedbackText.trim()}
                className="btn-primary !min-h-[44px] !px-3.5 text-xs shrink-0"
              >
                Send
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
};

/* ============================================================================
 * Inline Clickable Multiple-Choice Question Card
 * ============================================================================ */
const InlineQuestionsCard: React.FC<{
  questions: AgyQuestionItem[];
  onSubmitAnswers: (formatted: string) => Promise<void>;
}> = ({ questions, onSubmitAnswers }) => {
  const [selectedByQ, setSelectedByQ] = useState<Record<number, string[]>>({});
  const [customByQ, setCustomByQ] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const toggleOption = (qIdx: number, opt: string, isMulti: boolean) => {
    setSelectedByQ((prev) => {
      const cur = prev[qIdx] || [];
      if (isMulti) {
        const next = cur.includes(opt)
          ? cur.filter((x) => x !== opt)
          : [...cur, opt];
        return { ...prev, [qIdx]: next };
      }
      return { ...prev, [qIdx]: cur.includes(opt) ? [] : [opt] };
    });
  };

  const handleSubmit = async () => {
    const lines: string[] = [];
    questions.forEach((q, idx) => {
      const picks = selectedByQ[idx] || [];
      const free = (customByQ[idx] || "").trim();
      const combined = [...picks, ...(free ? [free] : [])];
      if (combined.length > 0) {
        lines.push(`- ${q.question}: ${combined.join(", ")}`);
      }
    });
    if (lines.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await onSubmitAnswers(lines.join("\n"));
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  const hasAnySelection = questions.some(
    (_, idx) =>
      (selectedByQ[idx]?.length || 0) > 0 ||
      Boolean((customByQ[idx] || "").trim())
  );

  return (
    <div
      className="rounded-[var(--radius-inner)] border p-3 space-y-3"
      style={{
        backgroundColor: "var(--bg-subtle)",
        borderColor: "var(--accent-secondary)",
      }}
    >
      <div
        className="flex items-center gap-1.5 text-xs font-semibold"
        style={{ color: "var(--accent-secondary)" }}
      >
        <HelpCircle className="w-4 h-4 shrink-0" />
        <span>Clarification Requested</span>
      </div>

      {questions.map((q, qIdx) => {
        const isMulti = Boolean(q.is_multi_select || q.isMultiSelect);
        const picks = selectedByQ[qIdx] || [];
        return (
          <div key={qIdx} className="space-y-2">
            <div className="text-xs font-semibold leading-snug">
              {q.question}
              {isMulti && (
                <span
                  className="ml-1.5 font-normal"
                  style={{ color: "var(--text-muted)" }}
                >
                  (Select all that apply)
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(q.options || []).map((opt) => {
                const chosen = picks.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={submitted}
                    onClick={() => toggleOption(qIdx, opt, isMulti)}
                    className={
                      chosen
                        ? "btn-primary !min-h-[44px] !px-3 text-xs text-left"
                        : "btn-secondary !min-h-[44px] !px-3 text-xs text-left"
                    }
                  >
                    {chosen && <Check className="w-3.5 h-3.5 shrink-0" />}
                    <span>{opt}</span>
                  </button>
                );
              })}
            </div>

            {!submitted && (
              <input
                type="text"
                value={customByQ[qIdx] || ""}
                onChange={(e) =>
                  setCustomByQ((prev) => ({ ...prev, [qIdx]: e.target.value }))
                }
                placeholder="Or type a custom answer…"
                className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-base"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
            )}
          </div>
        );
      })}

      {submitted ? (
        <div
          className="text-xs font-medium"
          style={{ color: "var(--status-success-fg)" }}
        >
          Answers submitted.
        </div>
      ) : (
        <button
          type="button"
          disabled={!hasAnySelection || submitting}
          onClick={() => void handleSubmit()}
          className="btn-primary !min-h-[44px] !px-4 text-xs"
        >
          {submitting ? "Submitting…" : "Submit Answers"}
        </button>
      )}
    </div>
  );
};

/* ============================================================================
 * Turn Message Item
 * ============================================================================ */
const TurnCard: React.FC<{
  msg: AgyMessage;
  inferredPlanArtifact?: AgyArtifactSummary | null;
  onViewPlan: (artifactPath?: string | null) => void;
  onSendReply: (text: string) => Promise<void>;
}> = ({ msg, inferredPlanArtifact, onViewPlan, onSendReply }) => {
  const [showThinking, setShowThinking] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>(
    {}
  );
  const isUser = msg.role === "user";

  const effectivePlan: AgyPlanReview | null =
    msg.planReview ||
    (inferredPlanArtifact
      ? {
          title: inferredPlanArtifact.name,
          summary: "Review the generated plan artifact and proceed or send feedback.",
          artifactPath: inferredPlanArtifact.relativePath,
          canProceed: true,
        }
      : null);

  return (
    <article
      className={`flex flex-col gap-1.5 ${
        isUser ? "items-end" : "items-start"
      }`}
    >
      <div
        className={`w-full ${
          isUser ? "sm:max-w-[84%] ml-auto" : "sm:max-w-[94%]"
        } rounded-[var(--radius-outer)] border p-3.5 space-y-2.5`}
        style={{
          backgroundColor: isUser ? "var(--bg-elevated)" : "var(--bg-surface)",
          borderColor: isUser
            ? "var(--accent-primary)"
            : "var(--border-default)",
        }}
      >
        {/* Header */}
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
                className="font-mono px-1.5 py-0.5 rounded border text-[10px] truncate max-w-[170px]"
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
            {msg.createdAt ? ` · ${formatRelTime(msg.createdAt)}` : ""}
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
              className="w-full min-h-[44px] px-3 py-1.5 flex items-center justify-between gap-2 text-xs font-medium text-left"
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
                className="px-3 pb-3 pt-1.5 text-xs whitespace-pre-wrap break-words border-t leading-relaxed max-h-64 overflow-y-auto"
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

        {/* Compact Expandable Tool Call Pills */}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {msg.toolCalls.map((tc, i) => {
              const open = Boolean(expandedTools[i]);
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
                    onClick={() =>
                      setExpandedTools((prev) => ({
                        ...prev,
                        [i]: !prev[i],
                      }))
                    }
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
                    {open ? (
                      <ChevronDown className="w-4 h-4 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 shrink-0" />
                    )}
                  </button>

                  {open && (
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
                            className="p-2 rounded border font-mono text-[11px] overflow-x-auto max-h-44 whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor: "var(--bg-canvas)",
                              borderColor: "var(--border-default)",
                            }}
                          >
                            {tc.outputPreview}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Turn Text */}
        {msg.content && (
          <div className="text-sm">{renderMessageMarkdownBlocks(msg.content)}</div>
        )}

        {/* Inline Implementation Plan Review Card */}
        {!isUser && effectivePlan && (
          <InlinePlanReviewCard
            plan={effectivePlan}
            onViewPlan={() => onViewPlan(effectivePlan.artifactPath)}
            onSendReply={onSendReply}
          />
        )}

        {/* Inline Clickable Multiple-Choice Question Card */}
        {!isUser &&
          msg.pendingQuestions &&
          msg.pendingQuestions.length > 0 && (
            <InlineQuestionsCard
              questions={msg.pendingQuestions}
              onSubmitAnswers={onSendReply}
            />
          )}
      </div>
    </article>
  );
};

/* ============================================================================
 * Inline Permission Confirmation Card (25s Countdown inside Chat Stream)
 * ============================================================================ */
const InlinePermissionCard: React.FC<{
  approvals: ApprovalItem[];
  onDecide: (
    id: string,
    action: "approve" | "allow_30m" | "deny"
  ) => Promise<void>;
}> = ({ approvals, onDecide }) => {
  const [nowSec, setNowSec] = useState<number>(() => Date.now() / 1000);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (approvals.length === 0) return;
    setNowSec(Date.now() / 1000);
    const t = window.setInterval(() => {
      setNowSec(Date.now() / 1000);
    }, 250);
    return () => window.clearInterval(t);
  }, [approvals.length]);

  const handleAction = async (
    id: string,
    action: "approve" | "allow_30m" | "deny"
  ) => {
    setBusyId(id);
    try {
      await onDecide(id, action);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2.5">
      {approvals.map((item) => {
        const total = Math.max(1, item.holdSeconds || 25);
        const remaining = Math.max(0, item.expiresAt - nowSec);
        const pct = Math.min(100, Math.max(0, (remaining / total) * 100));
        const isBusy = busyId === item.id;
        const preview =
          item.commandPreview ||
          (typeof item.rawArgs?.command === "string"
            ? item.rawArgs.command
            : JSON.stringify(item.rawArgs || {}));

        return (
          <div
            key={item.id}
            role="alert"
            className="surface-card p-3.5 space-y-2.5"
            style={{
              borderColor: "var(--status-warning)",
              backgroundColor: "var(--bg-surface)",
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Shield
                  className="w-4 h-4 shrink-0"
                  style={{ color: "var(--status-warning)" }}
                />
                <span className="text-xs font-semibold truncate">
                  Permission required:{" "}
                  <code
                    className="font-mono"
                    style={{ color: "var(--accent-secondary)" }}
                  >
                    {item.toolName}
                  </code>
                </span>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase shrink-0"
                  style={{
                    backgroundColor:
                      item.riskTier >= 2
                        ? "var(--status-danger-bg)"
                        : "var(--status-warning-bg)",
                    color:
                      item.riskTier >= 2
                        ? "var(--status-danger-fg)"
                        : "var(--status-warning-fg)",
                  }}
                >
                  Tier {item.riskTier}
                </span>
              </div>

              <span
                className="inline-flex items-center gap-1 font-mono text-xs font-bold tabular-nums shrink-0"
                style={{
                  color:
                    remaining <= 6
                      ? "var(--status-danger)"
                      : "var(--status-warning)",
                }}
              >
                <Clock className="w-3.5 h-3.5" />
                {remaining.toFixed(0)}s
              </span>
            </div>

            {/* 25s Countdown Progress Bar */}
            <div
              className="w-full h-1.5 rounded-full overflow-hidden"
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

            <div
              className="rounded-[var(--radius-inner)] border px-3 py-2 font-mono text-xs break-all max-h-24 overflow-y-auto"
              style={{
                backgroundColor: "var(--bg-subtle)",
                borderColor: "var(--border-default)",
                color: "var(--text-primary)",
              }}
            >
              {preview}
            </div>

            {item.riskReasons.length > 0 && (
              <p
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                {item.riskReasons.join(" · ")}
              </p>
            )}

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleAction(item.id, "approve")}
                className="btn-primary !min-h-[44px] !px-2 text-xs"
              >
                <Check className="w-4 h-4 shrink-0" />
                <span>Allow</span>
              </button>

              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleAction(item.id, "allow_30m")}
                className="btn-secondary !min-h-[44px] !px-2 text-xs"
              >
                <Shield className="w-4 h-4 shrink-0" />
                <span>Allow 30m</span>
              </button>

              <button
                type="button"
                disabled={isBusy}
                onClick={() => void handleAction(item.id, "deny")}
                className="btn-danger !min-h-[44px] !px-2 text-xs"
              >
                <ShieldBan className="w-4 h-4 shrink-0" />
                <span>Deny</span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* ============================================================================
 * Main ChatCanvas
 * ============================================================================ */
export const ChatCanvas: React.FC = () => {
  const {
    wsStatus,
    loading,
    apiError,
    agyError,
    hostGlance,
    unlockHost,
    refreshAll,
    refreshAgyData,
    interfaceLayout,
    agyProjects,
    selectedProject,
    setSelectedProjectPath,
    worktreeMode,
    setWorktreeMode,
    worktreeBranch,
    setWorktreeBranch,
    agyConversations,
    activeConversationId,
    activeConversationDetail,
    agyConversationLoading,
    isNewChatDraft,
    loadAgyConversationDetail,
    sendAgyChatMessage,
    setComposerDraft,
    approvals,
    decideApproval,
    openRightAuxTab,
    devPorts,
  } = useZeroG();

  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const isLocked = Boolean(hostGlance?.hostLocked);
  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.status === "pending"),
    [approvals]
  );

  const activeConv =
    (!isNewChatDraft &&
      (activeConversationDetail?.conversation ||
        agyConversations.find((c) => c.id === activeConversationId))) ||
    null;

  const messages = activeConversationDetail?.messages || [];
  const artifacts = activeConversationDetail?.artifacts || [];
  const subagents = activeConversationDetail?.subagents || [];

  // Detect plan artifact if the latest assistant turn didn't carry explicit planReview metadata
  const detectedPlanArtifact = useMemo<AgyArtifactSummary | null>(() => {
    return (
      artifacts.find((a) => /plan/i.test(a.name) && a.kind === "markdown") ||
      null
    );
  }, [artifacts]);

  const scrollToBottom = () => {
    window.setTimeout(() => {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 100);
  };

  useEffect(() => {
    if (pendingApprovals.length > 0) {
      scrollToBottom();
    }
  }, [pendingApprovals.length]);

  const handleUnlock = async () => {
    setUnlocking(true);
    try {
      await unlockHost();
    } finally {
      setUnlocking(false);
    }
  };

  const handleSendQuickReply = async (text: string) => {
    if (!activeConversationId) return;
    await sendAgyChatMessage(activeConversationId, text);
    scrollToBottom();
  };

  const isGitProject = Boolean(
    selectedProject?.gitBranch ||
      (selectedProject && selectedProject.dirtyCount >= 0)
  );

  return (
    <main
      aria-label="Antigravity Conversation Canvas"
      className="flex-1 flex flex-col min-w-0 h-full overflow-hidden"
    >
      {/* Top Inline Strip ONLY when Host Locked or Offline/Error */}
      {isLocked && (
        <div
          role="alert"
          className="shrink-0 border-b px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
          style={{
            backgroundColor: "var(--status-danger-bg)",
            borderColor: "var(--status-danger)",
            color: "var(--status-danger-fg)",
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Lock className="w-4 h-4 shrink-0" />
            <span className="break-words">
              <strong>PANIC LOCK ACTIVE</strong> — Host hooks are blocking all
              writes and child commands.
            </span>
          </div>
          <button
            type="button"
            disabled={unlocking}
            onClick={() => void handleUnlock()}
            className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
          >
            <Unlock className="w-3.5 h-3.5" />
            <span>{unlocking ? "Unlocking…" : "Unlock"}</span>
          </button>
        </div>
      )}

      {!isLocked && (apiError || agyError || wsStatus === "offline") && (
        <div
          role="alert"
          className="shrink-0 border-b px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
          style={{
            backgroundColor:
              wsStatus === "offline"
                ? "var(--status-warning-bg)"
                : "var(--status-danger-bg)",
            borderColor:
              wsStatus === "offline"
                ? "var(--status-warning)"
                : "var(--status-danger)",
            color:
              wsStatus === "offline"
                ? "var(--status-warning-fg)"
                : "var(--status-danger-fg)",
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            {wsStatus === "offline" ? (
              <WifiOff className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span className="break-words">
              {apiError ||
                agyError ||
                "Connection offline — steering replies will queue safely in Outbox."}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              void refreshAll();
              void refreshAgyData();
              if (activeConversationId) {
                void loadAgyConversationDetail(activeConversationId);
              }
            }}
            className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Scrollable Center Stream */}
      <div className="flex-1 overflow-y-auto px-2.5 sm:px-5 py-4">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {/* Loading Skeleton */}
          {(loading && agyConversations.length === 0 && !isNewChatDraft) ||
          (agyConversationLoading && !activeConversationDetail && !isNewChatDraft) ? (
            <div className="space-y-3 py-4">
              <div className="skeleton-shimmer h-20 w-3/4 ml-auto" />
              <div className="skeleton-shimmer h-36 w-full" />
              <div className="skeleton-shimmer h-24 w-5/6" />
            </div>
          ) : isNewChatDraft || !activeConv ? (
            /* ================================================================
               Empty / New Conversation Native Antigravity State
               ================================================================ */
            <div className="py-6 sm:py-12 flex flex-col items-center text-center space-y-5">
              <div
                className="w-12 h-12 rounded-2xl border inline-flex items-center justify-center"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  borderColor: "var(--border-default)",
                  color: "var(--accent-primary)",
                }}
              >
                <Sparkles className="w-6 h-6" />
              </div>

              <div className="space-y-1.5 max-w-md">
                <h1 className="font-display text-xl sm:text-2xl font-bold">
                  What would you like to build?
                </h1>
                <p className="text-xs sm:text-sm" style={{ color: "var(--text-muted)" }}>
                  Prompt Antigravity on{" "}
                  <strong>{hostGlance?.hostname || "LAPSTATION"}</strong> or tap
                  Voice Mode below to talk live.
                </p>
              </div>

              {/* Project Selector Pill + Dropdown */}
              <div className="relative w-full max-w-md flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowProjectPicker((v) => !v)}
                  className="agy-pill-btn !px-3.5 max-w-full"
                >
                  {selectedProject &&
                  (selectedProject.folders?.length || 0) > 1 ? (
                    <Layers
                      className="w-4 h-4 shrink-0"
                      style={{ color: "var(--accent-secondary)" }}
                    />
                  ) : (
                    <FolderGit2
                      className="w-4 h-4 shrink-0"
                      style={{ color: "var(--accent-primary)" }}
                    />
                  )}
                  <span className="font-semibold truncate max-w-[200px]">
                    {selectedProject?.name || "Select Workspace"}
                  </span>
                  {selectedProject?.gitBranch && (
                    <span
                      className="inline-flex items-center gap-0.5 font-mono text-[11px] shrink-0"
                      style={{ color: "var(--accent-secondary)" }}
                    >
                      <GitBranch className="w-3 h-3" />
                      {selectedProject.gitBranch}
                    </span>
                  )}
                  <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-70" />
                </button>

                {showProjectPicker && agyProjects.length > 0 && (
                  <div
                    className="surface-card w-full p-2 space-y-1 text-left max-h-60 overflow-y-auto z-20"
                    style={{ borderColor: "var(--border-strong)" }}
                  >
                    {agyProjects.map((proj) => {
                      const chosen = selectedProject?.id === proj.id;
                      return (
                        <button
                          key={proj.id}
                          type="button"
                          onClick={() => {
                            setSelectedProjectPath(proj.path);
                            setShowProjectPicker(false);
                          }}
                          className="w-full min-h-[44px] px-3 py-2 rounded-[var(--radius-inner)] flex items-center justify-between gap-2 text-xs"
                          style={{
                            backgroundColor: chosen
                              ? "var(--bg-elevated)"
                              : "transparent",
                          }}
                        >
                          <div className="min-w-0">
                            <div className="font-semibold truncate">
                              {proj.name}
                            </div>
                            <div
                              className="text-[10px] font-mono truncate"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {proj.folders && proj.folders.length > 1
                                ? `${proj.folders.length} folders`
                                : proj.path}
                            </div>
                          </div>
                          {chosen && (
                            <Check
                              className="w-4 h-4 shrink-0"
                              style={{ color: "var(--accent-primary)" }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Local Mode vs New Worktree Mode (Software Engineering + Git Project) */}
              {interfaceLayout === "software_engineering" &&
                selectedProject &&
                isGitProject && (
                  <div className="w-full max-w-md space-y-2">
                    <div
                      className="inline-grid grid-cols-2 p-1 rounded-full border"
                      style={{
                        backgroundColor: "var(--bg-surface)",
                        borderColor: "var(--border-default)",
                      }}
                      role="group"
                      aria-label="Git Workspace Mode"
                    >
                      <button
                        type="button"
                        onClick={() => setWorktreeMode("local")}
                        className="min-h-[44px] px-4 rounded-full text-xs font-semibold cursor-pointer"
                        style={{
                          backgroundColor:
                            worktreeMode === "local"
                              ? "var(--accent-primary)"
                              : "transparent",
                          color:
                            worktreeMode === "local"
                              ? "var(--accent-primary-fg)"
                              : "var(--text-muted)",
                        }}
                      >
                        Local mode
                      </button>
                      <button
                        type="button"
                        onClick={() => setWorktreeMode("worktree")}
                        className="min-h-[44px] px-4 rounded-full text-xs font-semibold cursor-pointer"
                        style={{
                          backgroundColor:
                            worktreeMode === "worktree"
                              ? "var(--accent-primary)"
                              : "transparent",
                          color:
                            worktreeMode === "worktree"
                              ? "var(--accent-primary-fg)"
                              : "var(--text-muted)",
                        }}
                      >
                        New worktree mode
                      </button>
                    </div>

                    {worktreeMode === "worktree" && (
                      <div className="px-2">
                        <input
                          type="text"
                          value={worktreeBranch}
                          onChange={(e) => setWorktreeBranch(e.target.value)}
                          placeholder="Optional branch name (e.g. feat/mobile-refactor)"
                          aria-label="Worktree branch name"
                          className="w-full rounded-[var(--radius-inner)] border px-3 py-2 text-base font-mono"
                          style={{
                            backgroundColor: "var(--bg-surface)",
                            borderColor: "var(--border-default)",
                            color: "var(--text-primary)",
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}

              {/* Quick Starter Pills */}
              <div className="flex flex-wrap justify-center gap-2 max-w-lg pt-1">
                {[
                  { label: "Plan a feature", text: "/plan " },
                  { label: "Launch Swarm", text: "/teamwork " },
                  { label: "Design interview", text: "/grill-me " },
                  {
                    label: "Review git status & tests",
                    text: "Check current git changes and run tests.",
                  },
                ].map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    onClick={() => setComposerDraft(chip.text)}
                    className="agy-pill-btn !px-3"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* ================================================================
               Active Conversation Message Stream
               ================================================================ */
            <>
              {/* Quick Context Bar for Aux Pane Shortcuts */}
              {(subagents.length > 0 ||
                artifacts.length > 0 ||
                (interfaceLayout === "software_engineering" &&
                  devPorts.length > 0)) && (
                <div className="flex flex-wrap items-center gap-1.5 pb-1">
                  {activeConv.workspacePaths[0] && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-mono border"
                      style={{
                        backgroundColor: "var(--bg-surface)",
                        borderColor: "var(--border-default)",
                        color: "var(--text-muted)",
                      }}
                    >
                      <FolderGit2 className="w-3 h-3 shrink-0" />
                      {folderBasename(activeConv.workspacePaths[0])}
                    </span>
                  )}

                  {subagents.length > 0 && (
                    <button
                      type="button"
                      onClick={() => openRightAuxTab("subagents")}
                      className="agy-pill-btn !px-3"
                    >
                      <Users
                        className="w-3.5 h-3.5"
                        style={{ color: "var(--accent-primary)" }}
                      />
                      <span>Subagents ({subagents.length})</span>
                    </button>
                  )}

                  {artifacts.slice(0, 3).map((art) => (
                    <button
                      key={art.relativePath}
                      type="button"
                      onClick={() =>
                        openRightAuxTab("artifacts", {
                          artifactPath: art.relativePath,
                        })
                      }
                      className="agy-pill-btn !px-3"
                    >
                      <FileCode2
                        className="w-3.5 h-3.5"
                        style={{ color: "var(--accent-secondary)" }}
                      />
                      <span className="font-mono truncate max-w-[140px]">
                        {art.name}
                      </span>
                    </button>
                  ))}

                  {interfaceLayout === "software_engineering" &&
                    devPorts.slice(0, 2).map((p) => (
                      <button
                        key={p.port}
                        type="button"
                        onClick={() =>
                          openRightAuxTab("preview", { previewPort: p.port })
                        }
                        className="agy-pill-btn !px-3"
                      >
                        <Globe
                          className="w-3.5 h-3.5"
                          style={{ color: "var(--status-success)" }}
                        />
                        <span className="font-mono">:{p.port}</span>
                      </button>
                    ))}
                </div>
              )}

              {messages.length === 0 ? (
                <div className="surface-card p-6 text-center space-y-1.5">
                  <p className="text-sm font-semibold">{activeConv.title}</p>
                  <p
                    className="text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Waiting for transcript steps… Send a message below to prompt Antigravity.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((msg, idx) => {
                    const isLastAssistant =
                      msg.role === "assistant" && idx === messages.length - 1;
                    return (
                      <TurnCard
                        key={msg.id}
                        msg={msg}
                        inferredPlanArtifact={
                          isLastAssistant && !msg.planReview
                            ? detectedPlanArtifact
                            : null
                        }
                        onViewPlan={(artPath) =>
                          openRightAuxTab("artifacts", {
                            artifactPath:
                              artPath ||
                              detectedPlanArtifact?.relativePath ||
                              null,
                          })
                        }
                        onSendReply={handleSendQuickReply}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Inline Permission Confirmation Card at bottom of stream */}
          {pendingApprovals.length > 0 && (
            <InlinePermissionCard
              approvals={pendingApprovals}
              onDecide={(id, action) => decideApproval(id, { action })}
            />
          )}

          <div ref={streamEndRef} />
        </div>
      </div>

      {/* Voice Call Bar (renders directly above MessageComposer when active) */}
      <VoiceCallBar />

      {/* Native Antigravity Bottom Composer */}
      <MessageComposer onAfterSend={scrollToBottom} />
    </main>
  );
};
