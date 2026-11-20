import type {
  ApprovalDecisionRequest,
  ApprovalItem,
  ArtifactItem,
  AutomationItem,
  GitStatusResponse,
  HookConfigSnippet,
  HostGlanceSnapshot,
  MacroShortcut,
  MobileToolCreateRequest,
  MobileToolResultRequest,
  MobileToolSpec,
  OutboxItem,
  PairingCodeResponse,
  PowerGearUpdateRequest,
  ProjectSummary,
  PtySessionInfo,
  RuleEntry,
  SessionSummary,
  SteeringMessageRequest,
  TimelineStep,
  TunnelBackend,
  TunnelStatus,
  WorktreeTaskRequest,
} from "../types/contracts";

const TOKEN_STORAGE_KEY = "0g_auth_token";

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

export function isLocalhostOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

export function consumeUrlPairingParams(): {
  directToken: string | null;
  pendingPairCode: string | null;
} {
  if (typeof window === "undefined") {
    return { directToken: null, pendingPairCode: null };
  }
  const url = new URL(window.location.href);
  const urlPair = url.searchParams.get("pair");
  const urlToken = url.searchParams.get("token");
  let changed = false;
  let directToken: string | null = null;
  let pendingPairCode: string | null = null;

  if (urlPair || urlToken) {
    if (
      !urlPair &&
      urlToken &&
      (urlToken.startsWith("0g_mob_") || urlToken.startsWith("0g_local_"))
    ) {
      localStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
      directToken = urlToken;
    } else {
      pendingPairCode = urlPair || urlToken;
    }
    if (urlPair) {
      url.searchParams.delete("pair");
      changed = true;
    }
    if (urlToken) {
      url.searchParams.delete("token");
      changed = true;
    }
    if (changed) {
      window.history.replaceState({}, "", url.toString());
    }
  }

  return {
    directToken: directToken || localStorage.getItem(TOKEN_STORAGE_KEY),
    pendingPairCode,
  };
}

export function bootstrapTokenFromUrl(): string | null {
  return consumeUrlPairingParams().directToken;
}

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setAuthToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as { detail?: string; error?: string };
      detail = errBody.detail || errBody.error || detail;
    } catch {
      const txt = await res.text().catch(() => "");
      if (txt) detail = txt.slice(0, 240);
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export const api = {
  getHealth: () =>
    request<{ ok: boolean; hostLocked?: boolean; seq?: number }>("/api/health"),

  getStatus: () =>
    request<{
      ok: boolean;
      hostLocked: boolean;
      lastSeq: number;
      pendingApprovals: number;
      mobileToolsCount: number;
    }>("/api/status"),

  createPairingCode: () =>
    request<PairingCodeResponse>("/api/pairing/code", { method: "POST" }),

  claimPairingCode: (code: string, deviceName = "0G Mobile PWA") =>
    request<{ token?: string; sessionToken?: string; ok: boolean }>(
      "/api/pairing/claim",
      {
        method: "POST",
        body: JSON.stringify({ code: code.trim(), deviceName }),
      }
    ),

  getPairingQr: () =>
    request<{ url?: string; qrSvg?: string; code?: string }>("/api/pairing/qr"),

  getProjects: async (): Promise<ProjectSummary[]> => {
    const data = await request<ProjectSummary[] | { projects: ProjectSummary[] }>(
      "/api/projects"
    );
    return Array.isArray(data) ? data : data.projects || [];
  },

  getSessions: async (): Promise<SessionSummary[]> => {
    const data = await request<SessionSummary[] | { sessions: SessionSummary[] }>(
      "/api/sessions"
    );
    return Array.isArray(data) ? data : data.sessions || [];
  },

  getTimeline: async (
    sessionId: string
  ): Promise<{ steps: TimelineStep[]; artifacts?: ArtifactItem[] }> => {
    const data = await request<
      TimelineStep[] | { steps: TimelineStep[]; artifacts?: ArtifactItem[] }
    >(`/api/sessions/${encodeURIComponent(sessionId)}/timeline`);
    if (Array.isArray(data)) {
      return { steps: data, artifacts: [] };
    }
    return { steps: data.steps || [], artifacts: data.artifacts || [] };
  },

  spawnSession: (body: WorktreeTaskRequest) =>
    request<SessionSummary>("/api/sessions/spawn", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  steerSession: (sessionId: string, body: SteeringMessageRequest) =>
    request<{ ok: boolean; queued?: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/steer`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),

  cancelSession: (sessionId: string) =>
    request<{ ok: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { method: "POST" }
    ),

  flushOutboxItem: (item: OutboxItem) =>
    request<{ ok: boolean; duplicate?: boolean; conflict?: boolean; reason?: string }>(
      "/api/outbox",
      {
        method: "POST",
        body: JSON.stringify({
          sessionId: item.sessionId,
          message: item.message,
          clientMsgId: item.clientMsgId,
          expectedStepIdx: item.expectedStepIdx,
          expectedGitHeadSha: item.expectedGitHeadSha,
        }),
      }
    ),

  getApprovals: async (): Promise<ApprovalItem[]> => {
    const data = await request<ApprovalItem[] | { approvals: ApprovalItem[] }>(
      "/api/approvals"
    );
    return Array.isArray(data) ? data : data.approvals || [];
  },

  decideApproval: (id: string, body: ApprovalDecisionRequest) =>
    request<ApprovalItem>(`/api/approvals/${encodeURIComponent(id)}/decide`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getRules: async (): Promise<RuleEntry[]> => {
    const data = await request<RuleEntry[] | { rules: RuleEntry[] }>("/api/rules");
    return Array.isArray(data) ? data : data.rules || [];
  },

  upsertRule: (rule: Partial<RuleEntry>) =>
    request<RuleEntry>("/api/rules", {
      method: "POST",
      body: JSON.stringify(rule),
    }),

  deleteRule: (id: string) =>
    request<{ ok: boolean }>(`/api/rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  panicHost: (lockWorkstation = false) =>
    request<{ ok: boolean; hostLocked: boolean }>("/api/panic", {
      method: "POST",
      body: JSON.stringify({ lockWorkstation }),
    }),

  unlockHost: (assertion?: Record<string, unknown>) =>
    request<{ ok: boolean; hostLocked: boolean }>("/api/panic/unlock", {
      method: "POST",
      body: JSON.stringify({ webauthnAssertion: assertion || null }),
    }),

  getMobileTools: async (): Promise<MobileToolSpec[]> => {
    const data = await request<MobileToolSpec[] | { tools: MobileToolSpec[] }>(
      "/api/mobile-tools"
    );
    return Array.isArray(data) ? data : data.tools || [];
  },

  saveMobileTool: (tool: MobileToolCreateRequest & { id?: string; enabled?: boolean }) =>
    request<MobileToolSpec>("/api/mobile-tools", {
      method: "POST",
      body: JSON.stringify(tool),
    }),

  deleteMobileTool: (id: string) =>
    request<{ ok: boolean }>(`/api/mobile-tools/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  submitMobileToolResult: (result: MobileToolResultRequest) =>
    request<{ ok: boolean }>("/api/mobile-tools/result", {
      method: "POST",
      body: JSON.stringify(result),
    }),

  getHostGlance: () => request<HostGlanceSnapshot>("/api/host/glance"),

  updatePowerGear: (req: PowerGearUpdateRequest) =>
    request<HostGlanceSnapshot>("/api/host/power-gear", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  getAutomations: async (): Promise<AutomationItem[]> => {
    const data = await request<
      AutomationItem[] | { automations: AutomationItem[] }
    >("/api/automations");
    return Array.isArray(data) ? data : data.automations || [];
  },

  runAutomation: (slug: string) =>
    request<{ ok: boolean; sessionId?: string }>(
      `/api/automations/${encodeURIComponent(slug)}/run`,
      { method: "POST" }
    ),

  getMacros: async (): Promise<MacroShortcut[]> => {
    const data = await request<MacroShortcut[] | { macros: MacroShortcut[] }>(
      "/api/macros"
    );
    return Array.isArray(data) ? data : data.macros || [];
  },

  runMacro: (id: string) =>
    request<{ ok: boolean; output?: string; sessionId?: string }>(
      `/api/macros/${encodeURIComponent(id)}/run`,
      { method: "POST" }
    ),

  getGitStatus: (repoPath: string) =>
    request<GitStatusResponse>(
      `/api/git/status?path=${encodeURIComponent(repoPath)}`
    ),

  getGitDiff: (repoPath: string, filePath?: string) =>
    request<{ diff: string; filePath?: string }>(
      `/api/git/diff?path=${encodeURIComponent(repoPath)}${
        filePath ? `&file=${encodeURIComponent(filePath)}` : ""
      }`
    ),

  revertGitFile: (repoPath: string, filePath: string) =>
    request<{ ok: boolean }>("/api/git/revert", {
      method: "POST",
      body: JSON.stringify({ repoPath, filePath }),
    }),

  mergeWorktree: (repoPath: string, worktreePath: string, branchName: string) =>
    request<{ ok: boolean }>("/api/git/worktree/merge", {
      method: "POST",
      body: JSON.stringify({ repoPath, worktreePath, branchName }),
    }),

  discardWorktree: (
    repoPath: string,
    worktreePath: string,
    branchName: string
  ) =>
    request<{ ok: boolean }>("/api/git/worktree/discard", {
      method: "POST",
      body: JSON.stringify({ repoPath, worktreePath, branchName }),
    }),

  getTunnelStatus: () => request<TunnelStatus>("/api/tunnel/status"),

  startTunnel: (backend: TunnelBackend) =>
    request<TunnelStatus>("/api/tunnel/start", {
      method: "POST",
      body: JSON.stringify({ backend }),
    }),

  stopTunnel: () =>
    request<TunnelStatus>("/api/tunnel/stop", { method: "POST" }),

  getHookConfigs: async (): Promise<HookConfigSnippet[]> => {
    const data = await request<
      HookConfigSnippet[] | Record<string, unknown>
    >("/api/adapters/hook-configs");
    if (Array.isArray(data)) return data;
    if ("configs" in data && Array.isArray(data.configs)) {
      return data.configs as HookConfigSnippet[];
    }
    return Object.entries(data).map(([provider, val]) => {
      const v = (val || {}) as Record<string, unknown>;
      return {
        provider: provider as HookConfigSnippet["provider"],
        displayName: String(v.displayName || provider),
        configPath: String(v.configPath || ""),
        snippet: (v.snippet as Record<string, unknown>) || v,
      };
    });
  },

  getVapidPublicKey: () =>
    request<{ publicKey: string }>("/api/push/vapid-public-key"),

  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<{ ok: boolean }>("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription),
    }),

  getWebAuthnOptions: (mode: "register" | "authenticate") =>
    request<Record<string, unknown>>("/api/auth/webauthn/options", {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),

  verifyWebAuthn: (payload: Record<string, unknown>) =>
    request<{ ok: boolean; verified?: boolean }>("/api/auth/webauthn/verify", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listPtySessions: async (): Promise<PtySessionInfo[]> => {
    const data = await request<PtySessionInfo[] | { sessions: PtySessionInfo[] }>(
      "/api/pty/sessions"
    ).catch(() => ({ sessions: [] as PtySessionInfo[] }));
    return Array.isArray(data) ? data : data.sessions || [];
  },

  createPtySession: (cwd?: string) =>
    request<PtySessionInfo>("/api/pty/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: cwd || null }),
    }),
};
