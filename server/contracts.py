"""Stage-0 frozen Pydantic contracts shared across daemon, adapters, MCP, hooks, and PWA."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ProviderId = Literal["antigravity", "claude_code", "codex_cli", "grok_build"]
SessionSource = Literal["desktop_hook", "phone_worker"]
SessionStatus = Literal["running", "waiting_approval", "idle", "completed", "cancelled", "error"]
PowerGear = Literal["ultra_sip", "auto_turbo", "balanced", "max_turbo", "low_battery_guard"]
RiskTier = Literal[0, 1, 2, 3]
ApprovalStatus = Literal["pending", "approved", "edited_approved", "denied", "escalated", "auto_allowed", "auto_denied"]
MobileToolRuntime = Literal["phone_js", "phone_builtin", "host_command"]
TunnelBackend = Literal["cloudflare", "tailscale", "local_only"]
ThemePreset = Literal["obsidian", "outdoor", "wireframe"]


class HookEventPayload(BaseModel):
    """Normalized hook input sent from bin/hook.cmd or external CLI hooks."""

    provider: ProviderId = "antigravity"
    hookEventName: str
    conversationId: str = "default"
    workspacePaths: list[str] = Field(default_factory=list)
    transcriptPath: str | None = None
    artifactDirectoryPath: str | None = None
    modelName: str | None = None
    lastUserInput: str | None = None
    cwd: str | None = None
    stepIdx: int | None = None
    toolCall: dict[str, Any] | None = None
    error: str | None = None
    terminationReason: str | None = None
    continuationActive: bool = False
    raw: dict[str, Any] = Field(default_factory=dict)


class HookDecisionResponse(BaseModel):
    """Normalized hook output translated back to Antigravity / Claude / Codex / Grok format."""

    decision: Literal["allow", "deny", "ask", "force_ask", "continue", "ok"] = "ok"
    reason: str | None = None
    overwrite: dict[str, Any] | None = None
    permissionOverrides: list[str] = Field(default_factory=list)
    injectSteps: list[dict[str, Any]] = Field(default_factory=list)
    terminationBehavior: Literal["", "terminate", "force_continue"] = ""


class ProjectSummary(BaseModel):
    id: str
    name: str
    path: str
    icon: str = "folder"
    accentToken: str = "--accent-primary"
    providerHint: ProviderId = "antigravity"
    activeSessions: int = 0
    gitBranch: str | None = None
    isSeededDemo: bool = False


class SessionSummary(BaseModel):
    id: str
    title: str
    projectId: str
    projectName: str
    provider: ProviderId
    source: SessionSource
    status: SessionStatus
    cwd: str | None = None
    worktreePath: str | None = None
    worktreeBranch: str | None = None
    stepIdx: int = 0
    gitHeadSha: str | None = None
    transcriptPath: str | None = None
    artifactDirectoryPath: str | None = None
    promptTokens: int = 0
    thoughtsTokens: int = 0
    totalTokens: int = 0
    createdAt: float
    updatedAt: float


class TimelineStep(BaseModel):
    id: str
    sessionId: str
    stepIdx: int
    role: Literal["user", "assistant", "thought", "tool", "system", "error"]
    content: str
    toolName: str | None = None
    toolArgs: dict[str, Any] | None = None
    redacted: bool = False
    ts: float


class ApprovalItem(BaseModel):
    id: str
    sessionId: str
    provider: ProviderId
    toolName: str
    toolCallId: str | None = None
    rawArgs: dict[str, Any] = Field(default_factory=dict)
    commandPreview: str = ""
    astSummary: list[str] = Field(default_factory=list)
    riskTier: RiskTier = 1
    riskReasons: list[str] = Field(default_factory=list)
    status: ApprovalStatus = "pending"
    holdSeconds: int = 25
    createdAt: float
    expiresAt: float
    resolvedAt: float | None = None
    resolvedBy: str | None = None
    overwriteArgs: dict[str, Any] | None = None


class ApprovalDecisionRequest(BaseModel):
    action: Literal["approve", "edit_approve", "deny", "allow_30m"]
    overwriteArgs: dict[str, Any] | None = None
    reason: str | None = None
    webauthnAssertion: dict[str, Any] | None = None


class RuleEntry(BaseModel):
    id: str
    name: str
    provider: ProviderId | Literal["*"] = "*"
    toolPattern: str = "run_command"
    commandRegex: str
    action: Literal["allow", "deny", "ask"] = "ask"
    riskTier: RiskTier = 1
    enabled: bool = True
    expiresAt: float | None = None
    scopeCwd: str | None = None


class WorktreeTaskRequest(BaseModel):
    projectId: str
    provider: ProviderId = "antigravity"
    prompt: str
    title: str | None = None
    useWorktree: bool = True
    maxTokensBudget: int = 120000
    model: str | None = None


class SteeringMessageRequest(BaseModel):
    message: str
    clientMsgId: str | None = None
    expectedStepIdx: int | None = None
    expectedGitHeadSha: str | None = None


class MobileToolSpec(BaseModel):
    id: str
    name: str
    description: str
    runtime: MobileToolRuntime = "phone_js"
    parametersSchema: dict[str, Any] = Field(
        default_factory=lambda: {
            "type": "object",
            "properties": {"input": {"type": "string", "description": "Input parameter"}},
            "required": [],
        }
    )
    code: str = ""
    requiresApproval: bool = False
    enabled: bool = True
    createdAt: float
    updatedAt: float


class MobileToolCreateRequest(BaseModel):
    name: str
    description: str
    runtime: MobileToolRuntime = "phone_js"
    parametersSchema: dict[str, Any] = Field(default_factory=dict)
    code: str = ""
    requiresApproval: bool = False


class MobileToolInvocationRequest(BaseModel):
    toolName: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    sessionId: str | None = None
    timeoutSec: float = 18.0


class MobileToolResultRequest(BaseModel):
    ticketId: str
    ok: bool = True
    result: Any = None
    error: str | None = None


class HostGlanceSnapshot(BaseModel):
    hostname: str
    osVersion: str
    cpuPercent: float
    ramUsedMb: int
    ramTotalMb: int
    diskFreeGb: float
    diskTotalGb: float
    batteryPercent: int | None = None
    acPluggedIn: bool | None = None
    batteryRemainingMin: int | None = None
    gpuName: str | None = None
    gpuLoadPercent: float | None = None
    vramUsedMb: int | None = None
    vramTotalMb: int | None = None
    listeningPorts: list[dict[str, Any]] = Field(default_factory=list)
    activeAgents: list[dict[str, Any]] = Field(default_factory=list)
    powerGear: PowerGear = "ultra_sip"
    autoGovernorEnabled: bool = True
    keepAwakeActive: bool = False
    displayOffRequested: bool = False
    lowBatteryThreshold: int = 15
    hostLocked: bool = False
    ts: float


class PowerGearUpdateRequest(BaseModel):
    gear: PowerGear | None = None
    autoGovernorEnabled: bool | None = None
    displayOff: bool | None = None
    lowBatteryThreshold: int | None = None
    autoHibernateAtThreshold: bool | None = None


class AutomationItem(BaseModel):
    slug: str
    name: str
    schedule: str
    prompt: str
    source: Literal["jetski_sidecar", "0g_macro"] = "jetski_sidecar"
    enabled: bool = True
    lastRunAt: float | None = None


class MacroShortcut(BaseModel):
    id: str
    name: str
    icon: str = "zap"
    command: str
    cwd: str | None = None
    provider: ProviderId | Literal["shell"] = "shell"
    requiresPasskey: bool = False


class StreamEnvelope(BaseModel):
    seq: int
    ts: float
    eventType: str
    sessionId: str | None = None
    provider: ProviderId | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
