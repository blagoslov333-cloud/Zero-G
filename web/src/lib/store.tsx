import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ActiveMobilePrompt,
  ActiveTab,
  ApprovalDecisionRequest,
  ApprovalItem,
  ArtifactItem,
  AutomationItem,
  HookConfigSnippet,
  HostGlanceSnapshot,
  MacroShortcut,
  MobileToolCreateRequest,
  MobileToolRequestFrame,
  MobileToolSpec,
  NotifyCardItem,
  OutboxItem,
  PairingCodeResponse,
  PowerGearUpdateRequest,
  ProjectSummary,
  PtySessionInfo,
  RuleEntry,
  SessionSummary,
  StreamEnvelope,
  ThemePreset,
  TimelineStep,
  TunnelBackend,
  TunnelStatus,
  WorktreeTaskRequest,
} from "../types/contracts";
import {
  ApiError,
  api,
  consumeUrlPairingParams,
  isLocalhostOrigin,
  setAuthToken,
} from "./api";
import { handleIncomingMobileToolRequest } from "./mobileToolRunner";
import {
  enqueueOutbox,
  generateClientMsgId,
  listOutbox,
  removeOutbox,
  updateOutboxItem,
} from "./outbox";
import { wsClient, type WsConnectionStatus } from "./ws";

const THEME_KEY = "0g_theme_preset";

function parseInitialTab(): ActiveTab {
  if (typeof window === "undefined") return "projects";
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (
    tab === "projects" ||
    tab === "inbox" ||
    tab === "new" ||
    tab === "tools" ||
    tab === "host"
  ) {
    return tab;
  }
  return "projects";
}

function parseAuxPaneFlag(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("view") === "auxpane";
}

function parseInitialTheme(): ThemePreset {
  if (typeof window === "undefined") return "obsidian";
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "obsidian" || saved === "outdoor" || saved === "wireframe") {
    return saved;
  }
  return "obsidian";
}

export interface ZeroGStoreValue {
  theme: ThemePreset;
  setTheme: (theme: ThemePreset) => void;
  isAuxPane: boolean;
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  wsStatus: WsConnectionStatus;
  lastSeq: number;
  loading: boolean;
  apiError: string | null;
  pairingRequired: boolean;
  showPairingModal: boolean;
  setShowPairingModal: (open: boolean) => void;
  claimPairing: (code: string) => Promise<void>;
  refreshAll: () => Promise<void>;

  projects: ProjectSummary[];
  sessions: SessionSummary[];
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
  timelinesBySession: Record<string, TimelineStep[]>;
  artifactsBySession: Record<string, ArtifactItem[]>;
  loadSessionTimeline: (sessionId: string) => Promise<void>;
  sendSteering: (sessionId: string, message: string) => Promise<"sent" | "queued">;
  spawnWorker: (req: WorktreeTaskRequest) => Promise<SessionSummary>;
  cancelWorker: (sessionId: string) => Promise<void>;

  outboxItems: OutboxItem[];
  flushOutboxNow: () => Promise<void>;
  discardOutboxItem: (clientMsgId: string) => Promise<void>;

  approvals: ApprovalItem[];
  decideApproval: (id: string, req: ApprovalDecisionRequest) => Promise<void>;
  rules: RuleEntry[];
  saveRule: (rule: Partial<RuleEntry>) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;

  mobileTools: MobileToolSpec[];
  saveMobileTool: (
    tool: MobileToolCreateRequest & { id?: string; enabled?: boolean }
  ) => Promise<MobileToolSpec>;
  deleteMobileTool: (id: string) => Promise<void>;
  automations: AutomationItem[];
  runAutomation: (slug: string) => Promise<void>;
  macros: MacroShortcut[];
  runMacro: (id: string) => Promise<void>;

  hostGlance: HostGlanceSnapshot | null;
  updatePowerGear: (req: PowerGearUpdateRequest) => Promise<void>;
  panicLock: (lockWorkstation?: boolean) => Promise<void>;
  unlockHost: () => Promise<void>;

  tunnelStatus: TunnelStatus | null;
  startTunnel: (backend: TunnelBackend) => Promise<void>;
  stopTunnel: () => Promise<void>;
  pairingCode: PairingCodeResponse | null;
  generatePairingCode: () => Promise<PairingCodeResponse | null>;
  hookConfigs: HookConfigSnippet[];

  ptySessions: PtySessionInfo[];
  activePtyId: string | null;
  setActivePtyId: (id: string | null) => void;
  ptyOutputBySession: Record<string, string>;
  createPty: (cwd?: string) => Promise<void>;
  sendPtyInput: (sessionId: string, data: string) => void;

  activeMobilePrompt: ActiveMobilePrompt | null;
  closeMobilePrompt: () => void;
  notifyCards: NotifyCardItem[];
  dismissNotifyCard: (id: string) => void;
  pushNotifyCard: (card: NotifyCardItem) => void;
  openPromptModal: (prompt: ActiveMobilePrompt) => void;
}

const ZeroGStoreContext = createContext<ZeroGStoreValue | null>(null);

export const ZeroGStoreProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [theme, setThemeState] = useState<ThemePreset>(parseInitialTheme);
  const [isAuxPane] = useState<boolean>(parseAuxPaneFlag);
  const [activeTab, setActiveTabState] = useState<ActiveTab>(parseInitialTab);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>(wsClient.getStatus());
  const [lastSeq, setLastSeq] = useState<number>(wsClient.getLastSeq());
  const [loading, setLoading] = useState<boolean>(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [pairingRequired, setPairingRequired] = useState<boolean>(false);
  const [showPairingModal, setShowPairingModal] = useState<boolean>(false);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [timelinesBySession, setTimelinesBySession] = useState<
    Record<string, TimelineStep[]>
  >({});
  const [artifactsBySession, setArtifactsBySession] = useState<
    Record<string, ArtifactItem[]>
  >({});
  const [outboxItems, setOutboxItems] = useState<OutboxItem[]>([]);

  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [rules, setRules] = useState<RuleEntry[]>([]);
  const [mobileTools, setMobileTools] = useState<MobileToolSpec[]>([]);
  const [automations, setAutomations] = useState<AutomationItem[]>([]);
  const [macros, setMacros] = useState<MacroShortcut[]>([]);
  const [hostGlance, setHostGlance] = useState<HostGlanceSnapshot | null>(null);
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(null);
  const [pairingCode, setPairingCode] = useState<PairingCodeResponse | null>(null);
  const [hookConfigs, setHookConfigs] = useState<HookConfigSnippet[]>([]);

  const [ptySessions, setPtySessions] = useState<PtySessionInfo[]>([]);
  const [activePtyId, setActivePtyId] = useState<string | null>(null);
  const [ptyOutputBySession, setPtyOutputBySession] = useState<
    Record<string, string>
  >({});

  const [activeMobilePrompt, setActiveMobilePrompt] =
    useState<ActiveMobilePrompt | null>(null);
  const [notifyCards, setNotifyCards] = useState<NotifyCardItem[]>([]);

  const handledTicketsRef = useRef<Set<string>>(new Set());
  const mobileToolsRef = useRef<MobileToolSpec[]>([]);
  mobileToolsRef.current = mobileTools;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemePreset) => {
    setThemeState(next);
  }, []);

  const setActiveTab = useCallback((tab: ActiveTab) => {
    setActiveTabState(tab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  const pushNotifyCard = useCallback((card: NotifyCardItem) => {
    setNotifyCards((prev) => [card, ...prev].slice(0, 6));
  }, []);

  const dismissNotifyCard = useCallback((id: string) => {
    setNotifyCards((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const openPromptModal = useCallback((prompt: ActiveMobilePrompt) => {
    setActiveMobilePrompt(prompt);
  }, []);

  const closeMobilePrompt = useCallback(() => {
    setActiveMobilePrompt(null);
  }, []);

  const refreshOutbox = useCallback(async () => {
    const items = await listOutbox();
    setOutboxItems(items);
  }, []);

  const flushOutboxNow = useCallback(async () => {
    const items = await listOutbox();
    if (items.length === 0) {
      setOutboxItems([]);
      return;
    }
    for (const item of items) {
      await updateOutboxItem(item.clientMsgId, { status: "syncing" }).catch(() => {});
      setOutboxItems(await listOutbox());
      try {
        const res = await api.flushOutboxItem(item);
        if (res.conflict) {
          await updateOutboxItem(item.clientMsgId, {
            status: "failed",
            errorReason:
              res.reason ||
              "Guarded step # or git HEAD SHA changed before reconnect",
          });
        } else {
          await removeOutbox(item.clientMsgId);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await updateOutboxItem(item.clientMsgId, {
            status: "failed",
            errorReason: err.detail || "State guard conflict (step/HEAD changed)",
          });
        } else {
          await updateOutboxItem(item.clientMsgId, { status: "offline-queued" });
          break;
        }
      }
    }
    setOutboxItems(await listOutbox());
  }, []);

  const discardOutboxItem = useCallback(async (clientMsgId: string) => {
    await removeOutbox(clientMsgId);
    setOutboxItems(await listOutbox());
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    try {
      const [
        projRes,
        sessRes,
        appRes,
        rulesRes,
        toolsRes,
        glanceRes,
        autoRes,
        macroRes,
        tunnelRes,
        hookRes,
        ptyRes,
      ] = await Promise.allSettled([
        api.getProjects(),
        api.getSessions(),
        api.getApprovals(),
        api.getRules(),
        api.getMobileTools(),
        api.getHostGlance(),
        api.getAutomations(),
        api.getMacros(),
        api.getTunnelStatus(),
        api.getHookConfigs(),
        api.listPtySessions(),
      ]);

      const checkAuthErr = (r: PromiseSettledResult<unknown>) =>
        r.status === "rejected" &&
        r.reason instanceof ApiError &&
        (r.reason.status === 401 || r.reason.status === 403);

      if (
        checkAuthErr(projRes) ||
        checkAuthErr(sessRes) ||
        checkAuthErr(glanceRes)
      ) {
        if (!isLocalhostOrigin()) {
          setPairingRequired(true);
          setShowPairingModal(true);
        }
        setApiError("Authentication required — enter 6-digit pairing code.");
        setLoading(false);
        return;
      }

      setPairingRequired(false);

      if (projRes.status === "fulfilled") {
        setProjects(projRes.value);
        setSelectedProjectId((prev) => prev || projRes.value[0]?.id || null);
      }
      if (sessRes.status === "fulfilled") {
        setSessions(sessRes.value);
        setSelectedSessionId((prev) => prev || sessRes.value[0]?.id || null);
      }
      if (appRes.status === "fulfilled") setApprovals(appRes.value);
      if (rulesRes.status === "fulfilled") setRules(rulesRes.value);
      if (toolsRes.status === "fulfilled") setMobileTools(toolsRes.value);
      if (glanceRes.status === "fulfilled") setHostGlance(glanceRes.value);
      if (autoRes.status === "fulfilled") setAutomations(autoRes.value);
      if (macroRes.status === "fulfilled") setMacros(macroRes.value);
      if (tunnelRes.status === "fulfilled") setTunnelStatus(tunnelRes.value);
      if (hookRes.status === "fulfilled") setHookConfigs(hookRes.value);
      if (ptyRes.status === "fulfilled") {
        setPtySessions(ptyRes.value);
        setActivePtyId((prev) => prev || ptyRes.value[0]?.id || null);
        const bufMap: Record<string, string> = {};
        for (const s of ptyRes.value) {
          if (s.buffer) bufMap[s.id] = s.buffer;
        }
        if (Object.keys(bufMap).length > 0) {
          setPtyOutputBySession((prev) => ({ ...bufMap, ...prev }));
        }
      }

      const allFailed =
        projRes.status === "rejected" &&
        sessRes.status === "rejected" &&
        glanceRes.status === "rejected";
      if (allFailed) {
        const msg =
          projRes.reason instanceof Error
            ? projRes.reason.message
            : "0G daemon unreachable at 127.0.0.1:8790";
        setApiError(msg);
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to connect to 0G daemon");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSessionTimeline = useCallback(async (sessionId: string) => {
    try {
      const { steps, artifacts } = await api.getTimeline(sessionId);
      setTimelinesBySession((prev) => ({ ...prev, [sessionId]: steps }));
      if (artifacts) {
        setArtifactsBySession((prev) => ({ ...prev, [sessionId]: artifacts }));
      }
    } catch {
      // Handled gracefully in timeline view
    }
  }, []);

  useEffect(() => {
    if (selectedSessionId) {
      void loadSessionTimeline(selectedSessionId);
    }
  }, [selectedSessionId, loadSessionTimeline]);

  // Handle incoming WS StreamEnvelope events
  const handleWsFrame = useCallback(
    (env: StreamEnvelope) => {
      const p = env.payload || {};
      switch (env.eventType) {
        case "session.created":
        case "session_created":
        case "session.updated":
        case "session_updated": {
          const s = (p.session as SessionSummary | undefined) || (p as unknown as SessionSummary);
          if (s && s.id) {
            setSessions((prev) => {
              const idx = prev.findIndex((x) => x.id === s.id);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], ...s };
                return copy;
              }
              return [s, ...prev];
            });
          }
          break;
        }
        case "timeline.step":
        case "timeline_step": {
          const step = (p.step as TimelineStep | undefined) || (p as unknown as TimelineStep);
          const sid = step?.sessionId || env.sessionId;
          if (sid && step && step.id) {
            setTimelinesBySession((prev) => {
              const existing = prev[sid] || [];
              if (existing.some((x) => x.id === step.id)) return prev;
              return { ...prev, [sid]: [...existing, step] };
            });
          }
          break;
        }
        case "timeline.token":
        case "timeline_token": {
          const sid = env.sessionId || (p.sessionId as string | undefined);
          const chunk = typeof p.text === "string" ? p.text : typeof p.token === "string" ? p.token : "";
          const stepId = typeof p.stepId === "string" ? p.stepId : `stream_${sid}`;
          if (sid && chunk) {
            setTimelinesBySession((prev) => {
              const existing = prev[sid] || [];
              const idx = existing.findIndex((x) => x.id === stepId);
              if (idx >= 0) {
                const copy = [...existing];
                copy[idx] = { ...copy[idx], content: copy[idx].content + chunk };
                return { ...prev, [sid]: copy };
              }
              const nextStep: TimelineStep = {
                id: stepId,
                sessionId: sid,
                stepIdx: existing.length,
                role: (p.role as TimelineStep["role"]) || "assistant",
                content: chunk,
                redacted: false,
                ts: env.ts || Date.now() / 1000,
              };
              return { ...prev, [sid]: [...existing, nextStep] };
            });
          }
          break;
        }
        case "approval.created":
        case "approval.updated":
        case "approval.resolved":
        case "approval.escalated":
        case "approval_updated": {
          const item = (p.approval as ApprovalItem | undefined) || (p as unknown as ApprovalItem);
          if (item && item.id) {
            setApprovals((prev) => {
              const idx = prev.findIndex((a) => a.id === item.id);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], ...item };
                return copy;
              }
              return [item, ...prev];
            });
          }
          break;
        }
        case "host.glance":
        case "host_glance": {
          const glance = (p.glance as HostGlanceSnapshot | undefined) || (p as unknown as HostGlanceSnapshot);
          if (glance && typeof glance.cpuPercent === "number") {
            setHostGlance(glance);
          }
          break;
        }
        case "host.locked":
        case "panic_locked": {
          setHostGlance((prev) => (prev ? { ...prev, hostLocked: true } : prev));
          break;
        }
        case "host.unlocked":
        case "panic_unlocked": {
          setHostGlance((prev) => (prev ? { ...prev, hostLocked: false } : prev));
          break;
        }
        case "power.gear":
        case "power_gear_updated": {
          setHostGlance((prev) =>
            prev
              ? {
                  ...prev,
                  powerGear: (p.powerGear as HostGlanceSnapshot["powerGear"]) || prev.powerGear,
                  autoGovernorEnabled:
                    typeof p.autoGovernorEnabled === "boolean"
                      ? p.autoGovernorEnabled
                      : prev.autoGovernorEnabled,
                }
              : prev
          );
          break;
        }
        case "rule.updated":
        case "rule_updated": {
          void api.getRules().then(setRules).catch(() => {});
          break;
        }
        case "mobile_tool.updated":
        case "mobile_tool_updated": {
          void api.getMobileTools().then(setMobileTools).catch(() => {});
          break;
        }
        case "tunnel.updated":
        case "tunnel_updated": {
          const st = (p.tunnel as TunnelStatus | undefined) || (p as unknown as TunnelStatus);
          if (st && st.status) {
            setTunnelStatus(st);
          }
          break;
        }
        case "pty.output":
        case "pty_output": {
          const sid = String(p.ptySessionId || p.sessionId || env.sessionId || "");
          const chunk = String(p.data || p.output || "");
          if (sid && chunk) {
            setPtyOutputBySession((prev) => {
              const next = ((prev[sid] || "") + chunk).slice(-24000);
              return { ...prev, [sid]: next };
            });
          }
          break;
        }
        case "mobile_tool_request": {
          const req = p as unknown as MobileToolRequestFrame;
          if (req && req.ticketId && !handledTicketsRef.current.has(req.ticketId)) {
            handledTicketsRef.current.add(req.ticketId);
            const matched = mobileToolsRef.current.find(
              (t) => t.name === req.toolName
            );
            void handleIncomingMobileToolRequest(
              {
                ...req,
                runtime: req.runtime || matched?.runtime,
                code: req.code || matched?.code,
              },
              { pushNotifyCard, openPromptModal }
            );
          }
          break;
        }
        default:
          break;
      }
    },
    [pushNotifyCard, openPromptModal]
  );

  useEffect(() => {
    let cancelled = false;
    const unsubFrames = wsClient.subscribeFrames(handleWsFrame);
    const unsubStatus = wsClient.subscribeStatus((status, seq) => {
      setWsStatus(status);
      setLastSeq(seq);
      if (status === "connected") {
        void flushOutboxNow();
      }
    });

    const boot = async () => {
      const { pendingPairCode } = consumeUrlPairingParams();
      if (pendingPairCode) {
        try {
          const res = await api.claimPairingCode(pendingPairCode, "0G Mobile PWA");
          const sessionTok = res.token || res.sessionToken;
          if (sessionTok) {
            setAuthToken(sessionTok);
          }
          setPairingRequired(false);
          setShowPairingModal(false);
        } catch {
          setPairingRequired(true);
          setShowPairingModal(true);
        }
      }
      if (cancelled) return;
      await refreshOutbox();
      await refreshAll();
      wsClient.connect();
    };
    void boot();

    const pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void api.getHostGlance().then(setHostGlance).catch(() => {});
      }
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      unsubFrames();
      unsubStatus();
      wsClient.disconnect();
    };
  }, [handleWsFrame, refreshAll, refreshOutbox, flushOutboxNow]);

  const claimPairing = useCallback(
    async (code: string) => {
      const res = await api.claimPairingCode(code, "0G Mobile PWA");
      const sessionTok = res.token || res.sessionToken;
      if (sessionTok) {
        setAuthToken(sessionTok);
      }
      setPairingRequired(false);
      setShowPairingModal(false);
      wsClient.disconnect();
      wsClient.connect();
      await refreshAll();
    },
    [refreshAll]
  );

  const sendSteering = useCallback(
    async (sessionId: string, message: string): Promise<"sent" | "queued"> => {
      const trimmed = message.trim();
      const targetSession = sessions.find((s) => s.id === sessionId);
      const clientMsgId = generateClientMsgId();
      const expectedStepIdx = targetSession?.stepIdx ?? null;
      const expectedGitHeadSha = targetSession?.gitHeadSha ?? null;

      if (
        (typeof navigator !== "undefined" && navigator.onLine === false) ||
        wsStatus !== "connected"
      ) {
        await enqueueOutbox({
          clientMsgId,
          sessionId,
          message: trimmed,
          expectedStepIdx,
          expectedGitHeadSha,
          createdAt: Date.now(),
          status: "offline-queued",
        });
        setOutboxItems(await listOutbox());
        return "queued";
      }

      try {
        await api.steerSession(sessionId, {
          message: trimmed,
          clientMsgId,
          expectedStepIdx,
          expectedGitHeadSha,
        });
        return "sent";
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          throw err;
        }
        await enqueueOutbox({
          clientMsgId,
          sessionId,
          message: trimmed,
          expectedStepIdx,
          expectedGitHeadSha,
          createdAt: Date.now(),
          status: "offline-queued",
        });
        setOutboxItems(await listOutbox());
        return "queued";
      }
    },
    [sessions, wsStatus]
  );

  const spawnWorker = useCallback(async (req: WorktreeTaskRequest) => {
    const created = await api.spawnSession(req);
    setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
    setSelectedSessionId(created.id);
    return created;
  }, []);

  const cancelWorker = useCallback(async (sessionId: string) => {
    await api.cancelSession(sessionId);
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, status: "cancelled" } : s))
    );
  }, []);

  const decideApproval = useCallback(
    async (id: string, req: ApprovalDecisionRequest) => {
      const updated = await api.decideApproval(id, req);
      setApprovals((prev) => prev.map((a) => (a.id === id ? updated : a)));
      const nextRules = await api.getRules().catch(() => null);
      if (nextRules) setRules(nextRules);
    },
    []
  );

  const saveRule = useCallback(async (rule: Partial<RuleEntry>) => {
    const saved = await api.upsertRule(rule);
    setRules((prev) => {
      const idx = prev.findIndex((r) => r.id === saved.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = saved;
        return copy;
      }
      return [saved, ...prev];
    });
  }, []);

  const deleteRule = useCallback(async (id: string) => {
    await api.deleteRule(id);
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const saveMobileTool = useCallback(
    async (tool: MobileToolCreateRequest & { id?: string; enabled?: boolean }) => {
      const saved = await api.saveMobileTool(tool);
      setMobileTools((prev) => {
        const idx = prev.findIndex((t) => t.id === saved.id || t.name === saved.name);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = saved;
          return copy;
        }
        return [saved, ...prev];
      });
      return saved;
    },
    []
  );

  const deleteMobileTool = useCallback(async (id: string) => {
    await api.deleteMobileTool(id);
    setMobileTools((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const runAutomation = useCallback(
    async (slug: string) => {
      await api.runAutomation(slug);
      pushNotifyCard({
        id: `auto_${Date.now()}`,
        title: "Automation Triggered",
        body: `Scheduled job "${slug}" dispatched to host.`,
        severity: "success",
        ts: Date.now(),
      });
      void api.getAutomations().then(setAutomations).catch(() => {});
    },
    [pushNotifyCard]
  );

  const runMacro = useCallback(
    async (id: string) => {
      const res = await api.runMacro(id);
      pushNotifyCard({
        id: `macro_${Date.now()}`,
        title: "Laptop Macro Executed",
        body: res.output ? res.output.slice(0, 140) : `Macro ${id} completed.`,
        severity: "info",
        ts: Date.now(),
      });
    },
    [pushNotifyCard]
  );

  const updatePowerGear = useCallback(async (req: PowerGearUpdateRequest) => {
    const next = await api.updatePowerGear(req);
    setHostGlance(next);
  }, []);

  const panicLock = useCallback(async (lockWorkstation = false) => {
    await api.panicHost(lockWorkstation);
    setHostGlance((prev) => (prev ? { ...prev, hostLocked: true } : prev));
  }, []);

  const unlockHost = useCallback(async () => {
    await api.unlockHost();
    setHostGlance((prev) => (prev ? { ...prev, hostLocked: false } : prev));
  }, []);

  const startTunnel = useCallback(async (backend: TunnelBackend) => {
    const st = await api.startTunnel(backend);
    setTunnelStatus(st);
  }, []);

  const stopTunnel = useCallback(async () => {
    const st = await api.stopTunnel();
    setTunnelStatus(st);
  }, []);

  const generatePairingCode = useCallback(async () => {
    const res = await api.createPairingCode();
    setPairingCode(res);
    return res;
  }, []);

  const createPty = useCallback(async (cwd?: string) => {
    const created = await api.createPtySession(cwd);
    setPtySessions((prev) => [created, ...prev.filter((p) => p.id !== created.id)]);
    setActivePtyId(created.id);
    if (created.buffer) {
      setPtyOutputBySession((prev) => ({ ...prev, [created.id]: created.buffer || "" }));
    }
  }, []);

  const sendPtyInput = useCallback((sessionId: string, data: string) => {
    wsClient.sendWs("pty_input", { sessionId, data });
  }, []);

  const value = useMemo<ZeroGStoreValue>(
    () => ({
      theme,
      setTheme,
      isAuxPane,
      activeTab,
      setActiveTab,
      wsStatus,
      lastSeq,
      loading,
      apiError,
      pairingRequired,
      showPairingModal,
      setShowPairingModal,
      claimPairing,
      refreshAll,
      projects,
      sessions,
      selectedProjectId,
      setSelectedProjectId,
      selectedSessionId,
      setSelectedSessionId,
      timelinesBySession,
      artifactsBySession,
      loadSessionTimeline,
      sendSteering,
      spawnWorker,
      cancelWorker,
      outboxItems,
      flushOutboxNow,
      discardOutboxItem,
      approvals,
      decideApproval,
      rules,
      saveRule,
      deleteRule,
      mobileTools,
      saveMobileTool,
      deleteMobileTool,
      automations,
      runAutomation,
      macros,
      runMacro,
      hostGlance,
      updatePowerGear,
      panicLock,
      unlockHost,
      tunnelStatus,
      startTunnel,
      stopTunnel,
      pairingCode,
      generatePairingCode,
      hookConfigs,
      ptySessions,
      activePtyId,
      setActivePtyId,
      ptyOutputBySession,
      createPty,
      sendPtyInput,
      activeMobilePrompt,
      closeMobilePrompt,
      notifyCards,
      dismissNotifyCard,
      pushNotifyCard,
      openPromptModal,
    }),
    [
      theme,
      setTheme,
      isAuxPane,
      activeTab,
      setActiveTab,
      wsStatus,
      lastSeq,
      loading,
      apiError,
      pairingRequired,
      showPairingModal,
      claimPairing,
      refreshAll,
      projects,
      sessions,
      selectedProjectId,
      selectedSessionId,
      timelinesBySession,
      artifactsBySession,
      loadSessionTimeline,
      sendSteering,
      spawnWorker,
      cancelWorker,
      outboxItems,
      flushOutboxNow,
      discardOutboxItem,
      approvals,
      decideApproval,
      rules,
      saveRule,
      deleteRule,
      mobileTools,
      saveMobileTool,
      deleteMobileTool,
      automations,
      runAutomation,
      macros,
      runMacro,
      hostGlance,
      updatePowerGear,
      panicLock,
      unlockHost,
      tunnelStatus,
      startTunnel,
      stopTunnel,
      pairingCode,
      generatePairingCode,
      hookConfigs,
      ptySessions,
      activePtyId,
      ptyOutputBySession,
      createPty,
      sendPtyInput,
      activeMobilePrompt,
      closeMobilePrompt,
      notifyCards,
      dismissNotifyCard,
      pushNotifyCard,
      openPromptModal,
    ]
  );

  return (
    <ZeroGStoreContext.Provider value={value}>
      {children}
    </ZeroGStoreContext.Provider>
  );
};

export function useZeroG(): ZeroGStoreValue {
  const ctx = useContext(ZeroGStoreContext);
  if (!ctx) {
    throw new Error("useZeroG must be used inside ZeroGStoreProvider");
  }
  return ctx;
}
