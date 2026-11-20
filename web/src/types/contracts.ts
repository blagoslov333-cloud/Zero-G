/**
 * TypeScript mirrors of server/contracts.py and 0G daemon REST / WebSocket payloads.
 */

export type ProviderId = "antigravity" | "claude_code" | "codex_cli" | "grok_build";
export type SessionSource = "desktop_hook" | "phone_worker";
export type SessionStatus =
  | "running"
  | "waiting_approval"
  | "idle"
  | "completed"
  | "cancelled"
  | "error";
export type PowerGear =
  | "ultra_sip"
  | "auto_turbo"
  | "balanced"
  | "max_turbo"
  | "low_battery_guard";
export type RiskTier = 0 | 1 | 2 | 3;
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "edited_approved"
  | "denied"
  | "escalated"
  | "auto_allowed"
  | "auto_denied";
export type MobileToolRuntime = "phone_js" | "phone_builtin" | "host_command";
export type TunnelBackend = "cloudflare" | "tailscale" | "local_only";
export type ThemePreset = "obsidian" | "outdoor" | "wireframe";
export type ActiveTab = "projects" | "inbox" | "new" | "tools" | "host";

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  icon: string;
  accentToken: string;
  providerHint: ProviderId;
  activeSessions: number;
  gitBranch?: string | null;
  isSeededDemo?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  provider: ProviderId;
  source: SessionSource;
  status: SessionStatus;
  cwd?: string | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  stepIdx: number;
  gitHeadSha?: string | null;
  transcriptPath?: string | null;
  artifactDirectoryPath?: string | null;
  promptTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  createdAt: number;
  updatedAt: number;
}

export interface TimelineStep {
  id: string;
  sessionId: string;
  stepIdx: number;
  role: "user" | "assistant" | "thought" | "tool" | "system" | "error";
  content: string;
  toolName?: string | null;
  toolArgs?: Record<string, unknown> | null;
  redacted: boolean;
  ts: number;
}

export interface ArtifactItem {
  name: string;
  path: string;
  kind?: string;
  sizeBytes?: number;
  preview?: string;
  updatedAt?: number;
}

export interface ApprovalItem {
  id: string;
  sessionId: string;
  provider: ProviderId;
  toolName: string;
  toolCallId?: string | null;
  rawArgs: Record<string, unknown>;
  commandPreview: string;
  astSummary: string[];
  riskTier: RiskTier;
  riskReasons: string[];
  status: ApprovalStatus;
  holdSeconds: number;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number | null;
  resolvedBy?: string | null;
  overwriteArgs?: Record<string, unknown> | null;
}

export interface ApprovalDecisionRequest {
  action: "approve" | "edit_approve" | "deny" | "allow_30m";
  overwriteArgs?: Record<string, unknown> | null;
  reason?: string | null;
  webauthnAssertion?: Record<string, unknown> | null;
}

export interface RuleEntry {
  id: string;
  name: string;
  provider: ProviderId | "*";
  toolPattern: string;
  commandRegex: string;
  action: "allow" | "deny" | "ask";
  riskTier: RiskTier;
  enabled: boolean;
  expiresAt?: number | null;
  scopeCwd?: string | null;
}

export interface WorktreeTaskRequest {
  projectId: string;
  provider: ProviderId;
  prompt: string;
  title?: string | null;
  useWorktree: boolean;
  maxTokensBudget: number;
  model?: string | null;
}

export interface SteeringMessageRequest {
  message: string;
  clientMsgId?: string | null;
  expectedStepIdx?: number | null;
  expectedGitHeadSha?: string | null;
}

export interface OutboxItem {
  clientMsgId: string;
  sessionId: string;
  message: string;
  expectedStepIdx: number | null;
  expectedGitHeadSha: string | null;
  createdAt: number;
  status: "offline-queued" | "syncing" | "failed";
  errorReason?: string;
}

export interface MobileToolSpec {
  id: string;
  name: string;
  description: string;
  runtime: MobileToolRuntime;
  parametersSchema: Record<string, unknown>;
  code: string;
  requiresApproval: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MobileToolCreateRequest {
  name: string;
  description: string;
  runtime: MobileToolRuntime;
  parametersSchema: Record<string, unknown>;
  code: string;
  requiresApproval: boolean;
}

export interface MobileToolRequestFrame {
  ticketId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  runtime?: MobileToolRuntime;
  code?: string;
  sessionId?: string | null;
}

export interface MobileToolResultRequest {
  ticketId: string;
  ok: boolean;
  result?: unknown;
  error?: string | null;
}

export interface HostGlanceSnapshot {
  hostname: string;
  osVersion: string;
  cpuPercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  diskFreeGb: number;
  diskTotalGb: number;
  batteryPercent?: number | null;
  acPluggedIn?: boolean | null;
  batteryRemainingMin?: number | null;
  gpuName?: string | null;
  gpuLoadPercent?: number | null;
  vramUsedMb?: number | null;
  vramTotalMb?: number | null;
  listeningPorts: Array<Record<string, unknown>>;
  activeAgents: Array<Record<string, unknown>>;
  powerGear: PowerGear;
  autoGovernorEnabled: boolean;
  keepAwakeActive: boolean;
  displayOffRequested: boolean;
  lowBatteryThreshold: number;
  hostLocked: boolean;
  ts: number;
}

export interface PowerGearUpdateRequest {
  gear?: PowerGear | null;
  autoGovernorEnabled?: boolean | null;
  displayOff?: boolean | null;
  lowBatteryThreshold?: number | null;
  autoHibernateAtThreshold?: boolean | null;
}

export interface AutomationItem {
  slug: string;
  name: string;
  schedule: string;
  prompt: string;
  source: "jetski_sidecar" | "0g_macro";
  enabled: boolean;
  lastRunAt?: number | null;
}

export interface MacroShortcut {
  id: string;
  name: string;
  icon: string;
  command: string;
  cwd?: string | null;
  provider: ProviderId | "shell";
  requiresPasskey: boolean;
}

export interface StreamEnvelope {
  seq: number;
  ts: number;
  eventType: string;
  sessionId?: string | null;
  provider?: ProviderId | null;
  payload: Record<string, unknown>;
}

export interface TunnelStatus {
  backend: TunnelBackend;
  status: "stopped" | "starting" | "running" | "missing_binary" | "error";
  publicUrl?: string | null;
  localUrl?: string;
  cloudflaredInstalled?: boolean;
  tailscaleInstalled?: boolean;
  installHint?: string | null;
  error?: string | null;
  qrSvg?: string | null;
}

export interface PairingCodeResponse {
  code: string;
  expiresAt: number;
  pairUrl?: string;
  qrSvg?: string;
}

export interface GitStatusFile {
  path: string;
  status: string;
  staged?: boolean;
}

export interface GitStatusResponse {
  repoPath: string;
  branch?: string | null;
  headSha?: string | null;
  clean?: boolean;
  files: GitStatusFile[];
  raw?: string;
}

export interface PtySessionInfo {
  id: string;
  shell?: string;
  cwd?: string;
  alive?: boolean;
  buffer?: string;
}

export interface HookConfigSnippet {
  provider: ProviderId;
  displayName?: string;
  configPath: string;
  snippet: Record<string, unknown> | string;
}

export interface ActiveMobilePrompt {
  ticketId: string;
  toolName: string;
  mode: "input" | "photo";
  prompt: string;
  choices?: string[];
  placeholder?: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface NotifyCardItem {
  id: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "danger";
  ts: number;
}
