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
  AgentGateMode,
  AgyAutostartStatus,
  AgyConversationDetail,
  AgyConversationSummary,
  AgyCreateConversationRequest,
  AgyCreateConversationResponse,
  AgyCustomizationsResponse,
  AgyDevPort,
  AgyProject,
  AgyProjectConfigUpsertRequest,
  AgySendMessageResponse,
  AgySwarmDetailResponse,
  AgyUploadFileItem,
  AgyVoiceCapabilities,
  ApprovalDecisionRequest,
  ApprovalItem,
  ArtifactItem,
  AutomationItem,
  HookConfigSnippet,
  HostGlanceSnapshot,
  InterfaceLayout,
  MacroShortcut,
  MobileToolCreateRequest,
  MobileToolRequestFrame,
  MobileToolSpec,
  NotifyCardItem,
  OutboxItem,
  PairingCodeResponse,
  PermissionPreset,
  PowerGearUpdateRequest,
  ProjectSummary,
  PtySessionInfo,
  RightAuxTab,
  RuleEntry,
  SessionSummary,
  SettingsSection,
  StreamEnvelope,
  ThemePreset,
  TimelineStep,
  TunnelBackend,
  TunnelStatus,
  VoicePlaybackSpeed,
  WorktreeMode,
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
import { voiceClient, type VoiceClientSnapshot } from "./voiceClient";
import { wsClient, type WsConnectionStatus } from "./ws";

const THEME_KEY = "0g_theme_preset";
const LAYOUT_KEY = "0g_interface_layout";
const PRESET_KEY = "0g_permission_preset";
const RIGHT_AUX_KEY = "0g_right_aux_open";

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

function parseInitialLayout(): InterfaceLayout {
  if (typeof window === "undefined") return "software_engineering";
  const saved = localStorage.getItem(LAYOUT_KEY);
  if (saved === "software_engineering" || saved === "knowledge_work") {
    return saved;
  }
  return "software_engineering";
}

function parseInitialPreset(): PermissionPreset {
  if (typeof window === "undefined") return "default";
  const saved = localStorage.getItem(PRESET_KEY);
  if (
    saved === "request_review" ||
    saved === "default" ||
    saved === "auto" ||
    saved === "turbo"
  ) {
    return saved;
  }
  return "default";
}

function parseInitialLeftSidebar(): boolean {
  if (typeof window === "undefined") return true;
  return window.innerWidth >= 1024;
}

function parseInitialRightAux(): boolean {
  if (typeof window === "undefined") return false;
  if (window.innerWidth < 1280) return false;
  const saved = localStorage.getItem(RIGHT_AUX_KEY);
  if (saved === "true") return true;
  if (saved === "false") return false;
  return false;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export interface ZeroGStoreValue {
  theme: ThemePreset;
  setTheme: (theme: ThemePreset) => void;
  isAuxPane: boolean;

  // Single-Canvas Shell Drawers & Modals
  leftSidebarOpen: boolean;
  setLeftSidebarOpen: (open: boolean) => void;
  toggleLeftSidebar: () => void;
  rightAuxOpen: boolean;
  setRightAuxOpen: (open: boolean) => void;
  toggleRightAux: () => void;
  rightAuxTab: RightAuxTab;
  setRightAuxTab: (tab: RightAuxTab) => void;
  openRightAuxTab: (
    tab: RightAuxTab,
    opts?: { artifactPath?: string | null; previewPort?: number | null }
  ) => void;
  focusedArtifactPath: string | null;
  setFocusedArtifactPath: (path: string | null) => void;

  settingsModalOpen: boolean;
  settingsSection: SettingsSection;
  openSettingsModal: (section?: SettingsSection) => void;
  closeSettingsModal: () => void;

  // Antigravity Global Settings & Autostart
  interfaceLayout: InterfaceLayout;
  setInterfaceLayout: (layout: InterfaceLayout) => Promise<void>;
  permissionPreset: PermissionPreset;
  setPermissionPreset: (preset: PermissionPreset) => Promise<void>;
  autostartStatus: AgyAutostartStatus | null;
  updateAutostart: (body: {
    enabled?: boolean;
    notifyEmail?: string;
    autoEmailOnTunnelChange?: boolean;
    sendTestNow?: boolean;
  }) => Promise<AgyAutostartStatus>;
  voiceCapabilities: AgyVoiceCapabilities | null;

  // Connection & Pairing
  wsStatus: WsConnectionStatus;
  lastSeq: number;
  loading: boolean;
  apiError: string | null;
  pairingRequired: boolean;
  showPairingModal: boolean;
  setShowPairingModal: (open: boolean) => void;
  claimPairing: (code: string) => Promise<void>;
  refreshAll: () => Promise<void>;

  // Core Sessions & Outbox
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

  // Approvals, Rules & Host Controls
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
  agentGateMode: AgentGateMode;
  setAgentGateMode: (mode: AgentGateMode) => Promise<void>;
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

  // Antigravity Native Remote Control (/api/agy/*)
  agyProjects: AgyProject[];
  selectedProjectPath: string | null;
  setSelectedProjectPath: (path: string | null) => void;
  selectedProject: AgyProject | null;
  upsertProjectConfig: (req: AgyProjectConfigUpsertRequest) => Promise<void>;
  deleteProjectConfig: (projectId: string) => Promise<void>;

  agyConversations: AgyConversationSummary[];
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  isNewChatDraft: boolean;
  startFreshNewConversationView: (projectPath?: string | null) => void;
  activeConversationDetail: AgyConversationDetail | null;
  swarmDetail: AgySwarmDetailResponse | null;
  refreshSwarmDetail: (conversationId: string) => Promise<void>;
  nudgeConversation: (conversationId: string, message: string) => Promise<void>;
  agyConversationLoading: boolean;
  agyError: string | null;
  customizations: AgyCustomizationsResponse | null;

  composerDraft: string;
  setComposerDraft: React.Dispatch<React.SetStateAction<string>>;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  worktreeMode: WorktreeMode;
  setWorktreeMode: (mode: WorktreeMode) => void;
  worktreeBranch: string;
  setWorktreeBranch: (branch: string) => void;
  uploadedAttachments: AgyUploadFileItem[];
  uploadingAttachment: boolean;
  uploadAttachment: (file: File) => Promise<AgyUploadFileItem>;
  removeUploadedAttachment: (relPath: string) => void;
  clearUploadedAttachments: () => void;

  devPorts: AgyDevPort[];
  refreshDevPorts: () => Promise<void>;
  selectedPreviewPort: number | null;
  setSelectedPreviewPort: (port: number | null) => void;

  terminalCwd: string | null;
  setTerminalCwd: (cwd: string | null) => void;
  refreshAgyData: () => Promise<void>;
  loadAgyConversationDetail: (conversationId: string) => Promise<void>;
  startNewAgyConversation: (
    req: AgyCreateConversationRequest
  ) => Promise<AgyCreateConversationResponse>;
  sendAgyChatMessage: (
    conversationId: string,
    message: string
  ) => Promise<AgySendMessageResponse>;

  // Voice Mode
  voiceSnapshot: VoiceClientSnapshot;
  voiceMinimized: boolean;
  setVoiceMinimized: (minimized: boolean) => void;
  startVoiceCall: () => Promise<void>;
  endVoiceCall: () => void;
  toggleVoiceMic: () => void;
  toggleVoiceSpeaker: () => void;
  cycleVoiceSpeed: () => void;
}

const ZeroGStoreContext = createContext<ZeroGStoreValue | null>(null);

export const ZeroGStoreProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [theme, setThemeState] = useState<ThemePreset>(parseInitialTheme);
  const [isAuxPane] = useState<boolean>(parseAuxPaneFlag);

  const [leftSidebarOpen, setLeftSidebarOpen] = useState<boolean>(
    parseInitialLeftSidebar
  );
  const [rightAuxOpen, setRightAuxOpenState] = useState<boolean>(
    parseInitialRightAux
  );
  const [rightAuxTab, setRightAuxTabState] = useState<RightAuxTab>("subagents");
  const [focusedArtifactPath, setFocusedArtifactPath] = useState<string | null>(
    null
  );

  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");

  const [interfaceLayout, setInterfaceLayoutState] =
    useState<InterfaceLayout>(parseInitialLayout);
  const [permissionPreset, setPermissionPresetState] =
    useState<PermissionPreset>(parseInitialPreset);
  const [autostartStatus, setAutostartStatus] =
    useState<AgyAutostartStatus | null>(null);
  const [voiceCapabilities, setVoiceCapabilities] =
    useState<AgyVoiceCapabilities | null>(null);

  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>(
    wsClient.getStatus()
  );
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
  const [pairingCode, setPairingCode] = useState<PairingCodeResponse | null>(
    null
  );
  const [hookConfigs, setHookConfigs] = useState<HookConfigSnippet[]>([]);

  const [ptySessions, setPtySessions] = useState<PtySessionInfo[]>([]);
  const [activePtyId, setActivePtyId] = useState<string | null>(null);
  const [ptyOutputBySession, setPtyOutputBySession] = useState<
    Record<string, string>
  >({});

  const [activeMobilePrompt, setActiveMobilePrompt] =
    useState<ActiveMobilePrompt | null>(null);
  const [notifyCards, setNotifyCards] = useState<NotifyCardItem[]>([]);

  // Antigravity Native Remote Control State
  const [agyProjects, setAgyProjects] = useState<AgyProject[]>([]);
  const [agyConversations, setAgyConversations] = useState<
    AgyConversationSummary[]
  >([]);
  const [activeConversationId, setActiveConversationIdRaw] = useState<
    string | null
  >(null);
  const [isNewChatDraft, setIsNewChatDraft] = useState<boolean>(false);
  const isNewChatDraftRef = useRef<boolean>(false);
  isNewChatDraftRef.current = isNewChatDraft;

  const [activeConversationDetail, setActiveConversationDetail] =
    useState<AgyConversationDetail | null>(null);
  const [swarmDetail, setSwarmDetail] =
    useState<AgySwarmDetailResponse | null>(null);
  const [agyConversationLoading, setAgyConversationLoading] =
    useState<boolean>(false);
  const [agyError, setAgyError] = useState<string | null>(null);
  const [selectedProjectPath, setSelectedProjectPathState] = useState<
    string | null
  >(null);
  const [customizations, setCustomizations] =
    useState<AgyCustomizationsResponse | null>(null);

  const [composerDraft, setComposerDraft] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>("local");
  const [worktreeBranch, setWorktreeBranch] = useState<string>("");
  const [uploadedAttachments, setUploadedAttachments] = useState<
    AgyUploadFileItem[]
  >([]);
  const [uploadingAttachment, setUploadingAttachment] = useState<boolean>(false);

  const [devPorts, setDevPorts] = useState<AgyDevPort[]>([]);
  const [selectedPreviewPort, setSelectedPreviewPort] = useState<number | null>(
    null
  );

  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [pollBoostTick, setPollBoostTick] = useState<number>(0);
  const boostPollUntilRef = useRef<number>(0);

  // Voice Mode State
  const [voiceSnapshot, setVoiceSnapshot] = useState<VoiceClientSnapshot>(
    voiceClient.getSnapshot()
  );
  const [voiceMinimized, setVoiceMinimized] = useState<boolean>(false);

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

  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarOpen((v) => !v);
  }, []);

  const setRightAuxOpen = useCallback((open: boolean) => {
    setRightAuxOpenState(open);
    if (typeof window !== "undefined" && window.innerWidth >= 1280) {
      localStorage.setItem(RIGHT_AUX_KEY, String(open));
    }
  }, []);

  const toggleRightAux = useCallback(() => {
    setRightAuxOpenState((prev) => {
      const next = !prev;
      if (typeof window !== "undefined" && window.innerWidth >= 1280) {
        localStorage.setItem(RIGHT_AUX_KEY, String(next));
      }
      return next;
    });
  }, []);

  const setRightAuxTab = useCallback((tab: RightAuxTab) => {
    setRightAuxTabState(tab);
  }, []);

  const openRightAuxTab = useCallback(
    (
      tab: RightAuxTab,
      opts?: { artifactPath?: string | null; previewPort?: number | null }
    ) => {
      if (opts?.artifactPath !== undefined) {
        setFocusedArtifactPath(opts.artifactPath);
      }
      if (opts?.previewPort) {
        setSelectedPreviewPort(opts.previewPort);
      }
      setRightAuxTabState(tab);
      setRightAuxOpen(true);
    },
    [setRightAuxOpen]
  );

  const openSettingsModal = useCallback((section: SettingsSection = "general") => {
    setSettingsSection(section);
    setSettingsModalOpen(true);
  }, []);

  const closeSettingsModal = useCallback(() => {
    setSettingsModalOpen(false);
  }, []);

  const setActiveConversationId = useCallback((id: string | null) => {
    if (id) {
      setIsNewChatDraft(false);
      isNewChatDraftRef.current = false;
    }
    setActiveConversationIdRaw(id);
    if (id && voiceClient.getSnapshot().active) {
      voiceClient.bindConversation(id);
    }
  }, []);

  const setSelectedProjectPath = useCallback(
    (path: string | null) => {
      setSelectedProjectPathState(path);
      if (path) {
        const matched = agyProjects.find(
          (p) => p.path === path || p.folders?.includes(path)
        );
        if (matched?.defaultWorktreeMode) {
          setWorktreeMode(matched.defaultWorktreeMode);
        }
        setTerminalCwd((prev) => prev || path);
      }
    },
    [agyProjects]
  );

  const startFreshNewConversationView = useCallback(
    (projectPath?: string | null) => {
      setIsNewChatDraft(true);
      isNewChatDraftRef.current = true;
      setActiveConversationIdRaw(null);
      setActiveConversationDetail(null);
      setSwarmDetail(null);
      if (projectPath !== undefined) {
        setSelectedProjectPath(projectPath);
      }
      if (typeof window !== "undefined" && window.innerWidth < 1024) {
        setLeftSidebarOpen(false);
      }
    },
    [setSelectedProjectPath]
  );

  const selectedProject = useMemo<AgyProject | null>(() => {
    if (!selectedProjectPath) {
      return agyProjects[0] || null;
    }
    return (
      agyProjects.find(
        (p) =>
          p.path === selectedProjectPath ||
          (p.folders && p.folders.includes(selectedProjectPath))
      ) || null
    );
  }, [agyProjects, selectedProjectPath]);

  const setInterfaceLayout = useCallback(async (layout: InterfaceLayout) => {
    setInterfaceLayoutState(layout);
    localStorage.setItem(LAYOUT_KEY, layout);
    if (layout === "knowledge_work") {
      setRightAuxTabState((prev) =>
        prev === "artifacts" || prev === "subagents" ? prev : "artifacts"
      );
    }
    try {
      const res = await api.updateAgySettings({ interfaceLayout: layout });
      if (res.interfaceLayout) {
        setInterfaceLayoutState(res.interfaceLayout);
      }
    } catch {
      // Persisted locally if daemon route is unavailable
    }
  }, []);

  const setPermissionPreset = useCallback(async (preset: PermissionPreset) => {
    setPermissionPresetState(preset);
    localStorage.setItem(PRESET_KEY, preset);
    const mappedGate: AgentGateMode =
      preset === "auto" || preset === "turbo" ? "agent_turbo" : "ask_on_phone";
    try {
      const res = await api.updateAgySettings({ permissionPreset: preset });
      if (res.permissionPreset) {
        setPermissionPresetState(res.permissionPreset);
      }
      if (res.agentGateMode) {
        setHostGlance((prev) =>
          prev ? { ...prev, agentGateMode: res.agentGateMode } : prev
        );
      } else {
        setHostGlance((prev) =>
          prev ? { ...prev, agentGateMode: mappedGate } : prev
        );
      }
    } catch {
      await api.updateAgentGate(mappedGate).catch(() => {});
      setHostGlance((prev) =>
        prev ? { ...prev, agentGateMode: mappedGate } : prev
      );
    }
  }, []);

  const updateAutostart = useCallback(
    async (body: {
      enabled?: boolean;
      notifyEmail?: string;
      autoEmailOnTunnelChange?: boolean;
      sendTestNow?: boolean;
    }) => {
      const res = await api.updateAgyAutostart(body);
      setAutostartStatus(res);
      return res;
    },
    []
  );

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
      await updateOutboxItem(item.clientMsgId, { status: "syncing" }).catch(
        () => {}
      );
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
            errorReason:
              err.detail || "State guard conflict (step/HEAD changed)",
          });
        } else {
          await updateOutboxItem(item.clientMsgId, {
            status: "offline-queued",
          });
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

  const refreshDevPorts = useCallback(async () => {
    try {
      const ports = await api.getAgyPorts();
      setDevPorts(ports);
      setSelectedPreviewPort((prev) => prev || ports[0]?.port || null);
    } catch {
      // Fallback to hostGlance listeningPorts if /api/agy/ports is not yet up
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    setAgyError(null);
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
        agyProjRes,
        agyConvRes,
        agyCustRes,
        agySettingsRes,
        agyPortsRes,
        agyAutostartRes,
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
        api.getAgyProjects(),
        api.getAgyConversations({ includeSubagents: false, limit: 60 }),
        api.getAgyCustomizations(),
        api.getAgySettings(),
        api.getAgyPorts(),
        api.getAgyAutostart(),
      ]);

      const checkAuthErr = (r: PromiseSettledResult<unknown>) =>
        r.status === "rejected" &&
        r.reason instanceof ApiError &&
        (r.reason.status === 401 || r.reason.status === 403);

      if (
        checkAuthErr(projRes) ||
        checkAuthErr(sessRes) ||
        checkAuthErr(glanceRes) ||
        checkAuthErr(agyProjRes) ||
        checkAuthErr(agyConvRes)
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

      if (agyProjRes.status === "fulfilled") {
        setAgyProjects(agyProjRes.value);
        setSelectedProjectPathState(
          (prev) => prev || agyProjRes.value[0]?.path || null
        );
        setTerminalCwd((prev) => prev || agyProjRes.value[0]?.path || null);
      }
      if (agyConvRes.status === "fulfilled") {
        setAgyConversations(agyConvRes.value);
        setActiveConversationIdRaw((prev) => {
          if (isNewChatDraftRef.current) return null;
          if (prev && agyConvRes.value.some((c) => c.id === prev)) return prev;
          return agyConvRes.value[0]?.id || prev || null;
        });
      } else if (agyConvRes.status === "rejected") {
        setAgyError(
          agyConvRes.reason instanceof Error
            ? agyConvRes.reason.message
            : "Failed to load Antigravity conversations"
        );
      }
      if (agyCustRes.status === "fulfilled") {
        setCustomizations(agyCustRes.value);
      }
      if (agySettingsRes.status === "fulfilled") {
        const s = agySettingsRes.value;
        if (s.permissionPreset) {
          setPermissionPresetState(s.permissionPreset);
          localStorage.setItem(PRESET_KEY, s.permissionPreset);
        }
        if (s.interfaceLayout) {
          setInterfaceLayoutState(s.interfaceLayout);
          localStorage.setItem(LAYOUT_KEY, s.interfaceLayout);
        }
        if (s.autostart) {
          setAutostartStatus(s.autostart);
        }
        if (s.voiceCapabilities) {
          setVoiceCapabilities(s.voiceCapabilities);
        }
      }
      if (agyAutostartRes.status === "fulfilled") {
        setAutostartStatus(agyAutostartRes.value);
      }
      if (agyPortsRes.status === "fulfilled") {
        setDevPorts(agyPortsRes.value);
        setSelectedPreviewPort(
          (prev) => prev || agyPortsRes.value[0]?.port || null
        );
      } else if (glanceRes.status === "fulfilled") {
        const fallbackPorts: AgyDevPort[] = glanceRes.value.listeningPorts
          .map((lp) => ({
            port: Number(lp.port ?? lp.localPort ?? 0),
            label: lp.label ? String(lp.label) : undefined,
            process: lp.process ? String(lp.process) : undefined,
          }))
          .filter((p) => p.port >= 1024 && p.port <= 65535 && p.port !== 8790);
        setDevPorts(fallbackPorts);
        setSelectedPreviewPort(
          (prev) => prev || fallbackPorts[0]?.port || null
        );
      }

      const allFailed =
        projRes.status === "rejected" &&
        sessRes.status === "rejected" &&
        glanceRes.status === "rejected" &&
        agyConvRes.status === "rejected";
      if (allFailed) {
        const msg =
          projRes.reason instanceof Error
            ? projRes.reason.message
            : "0G daemon unreachable at 127.0.0.1:8790";
        setApiError(msg);
      }
    } catch (err) {
      setApiError(
        err instanceof Error ? err.message : "Failed to connect to 0G daemon"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAgyData = useCallback(async () => {
    setAgyError(null);
    const [projRes, convRes, custRes, portsRes] = await Promise.allSettled([
      api.getAgyProjects(),
      api.getAgyConversations({ includeSubagents: false, limit: 60 }),
      api.getAgyCustomizations(),
      api.getAgyPorts(),
    ]);
    if (projRes.status === "fulfilled") {
      setAgyProjects(projRes.value);
      setSelectedProjectPathState(
        (prev) => prev || projRes.value[0]?.path || null
      );
      setTerminalCwd((prev) => prev || projRes.value[0]?.path || null);
    }
    if (convRes.status === "fulfilled") {
      setAgyConversations(convRes.value);
      setActiveConversationIdRaw((prev) => {
        if (isNewChatDraftRef.current) return null;
        if (prev && convRes.value.some((c) => c.id === prev)) return prev;
        return convRes.value[0]?.id || prev || null;
      });
    } else {
      setAgyError(
        convRes.reason instanceof Error
          ? convRes.reason.message
          : "Failed to refresh Antigravity conversations"
      );
    }
    if (custRes.status === "fulfilled") {
      setCustomizations(custRes.value);
    }
    if (portsRes.status === "fulfilled") {
      setDevPorts(portsRes.value);
      setSelectedPreviewPort((prev) => prev || portsRes.value[0]?.port || null);
    }
  }, []);

  const refreshSwarmDetail = useCallback(async (conversationId: string) => {
    if (!conversationId) return;
    try {
      const sw = await api.getAgySwarmDetail(conversationId);
      setSwarmDetail(sw);
    } catch {
      // Optional endpoint; activeConversationDetail also carries subagents & swarmPlan
    }
  }, []);

  const loadAgyConversationDetail = useCallback(
    async (conversationId: string) => {
      if (!conversationId) return;
      try {
        const detail = await api.getAgyConversationDetail(conversationId, 150);
        setActiveConversationDetail(detail);
        setAgyError(null);
        if (detail.conversation?.hasSwarm || detail.subagents?.length > 0) {
          void refreshSwarmDetail(conversationId);
        }
      } catch (err) {
        setAgyError(
          err instanceof Error
            ? err.message
            : "Failed to load conversation transcript"
        );
      }
    },
    [refreshSwarmDetail]
  );

  useEffect(() => {
    if (!activeConversationId) {
      setActiveConversationDetail(null);
      setSwarmDetail(null);
      return;
    }
    let cancelled = false;
    setAgyConversationLoading(true);
    void api
      .getAgyConversationDetail(activeConversationId, 150)
      .then((detail) => {
        if (!cancelled) {
          setActiveConversationDetail(detail);
          setAgyError(null);
          if (detail.conversation?.hasSwarm || detail.subagents?.length > 0) {
            void refreshSwarmDetail(activeConversationId);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAgyError(
            err instanceof Error
              ? err.message
              : "Failed to load conversation transcript"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setAgyConversationLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId, refreshSwarmDetail]);

  const activeConvStatusFromList = useMemo(() => {
    if (!activeConversationId) return undefined;
    return agyConversations.find((c) => c.id === activeConversationId)?.status;
  }, [agyConversations, activeConversationId]);

  useEffect(() => {
    if (!activeConversationId) return;
    const isRunning =
      activeConversationDetail?.conversation?.status === "running" ||
      activeConvStatusFromList === "running";
    const inBoostWindow = Date.now() < boostPollUntilRef.current;
    if (!isRunning && !inBoostWindow) return;

    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const stillRunning =
        activeConversationDetail?.conversation?.status === "running" ||
        activeConvStatusFromList === "running";
      if (!stillRunning && Date.now() >= boostPollUntilRef.current) {
        return;
      }
      void loadAgyConversationDetail(activeConversationId);
      void api
        .getAgyConversations({ includeSubagents: false, limit: 60 })
        .then(setAgyConversations)
        .catch(() => {});
    }, 3000);

    return () => window.clearInterval(timer);
  }, [
    activeConversationId,
    activeConversationDetail?.conversation?.status,
    activeConvStatusFromList,
    pollBoostTick,
    loadAgyConversationDetail,
  ]);

  const upsertProjectConfig = useCallback(
    async (req: AgyProjectConfigUpsertRequest) => {
      const res = await api.upsertAgyProjectConfig(req);
      const updatedProjects = await api.getAgyProjects();
      setAgyProjects(updatedProjects);
      if (res.project?.path) {
        setSelectedProjectPathState(res.project.path);
      } else if (req.folders[0]) {
        setSelectedProjectPathState(req.folders[0]);
      }
    },
    []
  );

  const deleteProjectConfig = useCallback(async (projectId: string) => {
    await api.deleteAgyProjectConfig(projectId);
    const updatedProjects = await api.getAgyProjects();
    setAgyProjects(updatedProjects);
    setSelectedProjectPathState((prev) => prev || updatedProjects[0]?.path || null);
  }, []);

  const uploadAttachment = useCallback(
    async (file: File): Promise<AgyUploadFileItem> => {
      const targetProjPath =
        activeConversationDetail?.conversation.workspacePaths?.[0] ||
        selectedProject?.path ||
        selectedProjectPath ||
        agyProjects[0]?.path ||
        projects[0]?.path ||
        "";
      if (!targetProjPath) {
        throw new Error("Select a workspace project first before uploading files.");
      }
      setUploadingAttachment(true);
      try {
        const dataBase64 = await fileToBase64(file);
        const res = await api.uploadWorkspaceFile({
          projectPath: targetProjPath,
          filename: file.name,
          dataBase64,
        });
        const item: AgyUploadFileItem = {
          fileName: res.fileName,
          relPath: res.relPath,
          absPath: res.absPath,
          sizeBytes: res.sizeBytes,
          mentionToken: res.mentionToken,
        };
        setUploadedAttachments((prev) => [
          ...prev.filter((x) => x.relPath !== item.relPath),
          item,
        ]);
        return item;
      } finally {
        setUploadingAttachment(false);
      }
    },
    [
      activeConversationDetail?.conversation.workspacePaths,
      selectedProject?.path,
      selectedProjectPath,
      agyProjects,
      projects,
    ]
  );

  const removeUploadedAttachment = useCallback((relPath: string) => {
    setUploadedAttachments((prev) => prev.filter((x) => x.relPath !== relPath));
  }, []);

  const clearUploadedAttachments = useCallback(() => {
    setUploadedAttachments([]);
  }, []);

  const startNewAgyConversation = useCallback(
    async (req: AgyCreateConversationRequest) => {
      const res = await api.createAgyConversation(req);
      setIsNewChatDraft(false);
      isNewChatDraftRef.current = false;
      boostPollUntilRef.current = Date.now() + 30000;
      setPollBoostTick((t) => t + 1);
      if (res.conversationId) {
        setActiveConversationIdRaw(res.conversationId);
        void loadAgyConversationDetail(res.conversationId);
        if (voiceClient.getSnapshot().active) {
          voiceClient.bindConversation(res.conversationId);
        }
      }
      void api
        .getAgyConversations({ includeSubagents: false, limit: 60 })
        .then(setAgyConversations)
        .catch(() => {});
      if (req.worktreeMode === "worktree") {
        void api.getAgyProjects().then(setAgyProjects).catch(() => {});
      }
      return res;
    },
    [loadAgyConversationDetail]
  );

  const sendAgyChatMessage = useCallback(
    async (conversationId: string, message: string) => {
      const res = await api.sendAgyMessage(conversationId, message);
      boostPollUntilRef.current = Date.now() + 30000;
      setPollBoostTick((t) => t + 1);
      void loadAgyConversationDetail(conversationId);
      void api
        .getAgyConversations({ includeSubagents: false, limit: 60 })
        .then(setAgyConversations)
        .catch(() => {});
      return res;
    },
    [loadAgyConversationDetail]
  );

  const nudgeConversation = useCallback(
    async (conversationId: string, message: string) => {
      await api.nudgeAgyConversation(conversationId, message);
      boostPollUntilRef.current = Date.now() + 30000;
      setPollBoostTick((t) => t + 1);
      if (activeConversationId) {
        void loadAgyConversationDetail(activeConversationId);
        void refreshSwarmDetail(activeConversationId);
      }
    },
    [activeConversationId, loadAgyConversationDetail, refreshSwarmDetail]
  );

  const loadSessionTimeline = useCallback(async (sessionId: string) => {
    try {
      const { steps, artifacts } = await api.getTimeline(sessionId);
      setTimelinesBySession((prev) => ({ ...prev, [sessionId]: steps }));
      if (artifacts) {
        setArtifactsBySession((prev) => ({ ...prev, [sessionId]: artifacts }));
      }
    } catch {
      // Handled gracefully
    }
  }, []);

  useEffect(() => {
    if (selectedSessionId) {
      void loadSessionTimeline(selectedSessionId);
    }
  }, [selectedSessionId, loadSessionTimeline]);

  // Voice Client subscription
  useEffect(() => {
    const unsubState = voiceClient.subscribe((snap) => {
      setVoiceSnapshot(snap);
    });
    const unsubBound = voiceClient.onConversationBound((cid) => {
      setIsNewChatDraft(false);
      isNewChatDraftRef.current = false;
      setActiveConversationIdRaw(cid);
      boostPollUntilRef.current = Date.now() + 30000;
      setPollBoostTick((t) => t + 1);
      void loadAgyConversationDetail(cid);
      void api
        .getAgyConversations({ includeSubagents: false, limit: 60 })
        .then(setAgyConversations)
        .catch(() => {});
    });
    return () => {
      unsubState();
      unsubBound();
      voiceClient.stop();
    };
  }, [loadAgyConversationDetail]);

  const startVoiceCall = useCallback(async () => {
    setVoiceMinimized(false);
    await voiceClient.start(activeConversationId);
  }, [activeConversationId]);

  const endVoiceCall = useCallback(() => {
    voiceClient.stop();
    setVoiceMinimized(false);
  }, []);

  const toggleVoiceMic = useCallback(() => {
    voiceClient.setMicMuted(!voiceClient.getSnapshot().micMuted);
  }, []);

  const toggleVoiceSpeaker = useCallback(() => {
    voiceClient.setSpeakerMuted(!voiceClient.getSnapshot().speakerMuted);
  }, []);

  const cycleVoiceSpeed = useCallback(() => {
    const cur = voiceClient.getSnapshot().playbackSpeed;
    const next: VoicePlaybackSpeed =
      cur === 1 ? 1.25 : cur === 1.25 ? 1.5 : 1;
    voiceClient.setPlaybackSpeed(next);
  }, []);

  // Handle incoming WS StreamEnvelope events
  const handleWsFrame = useCallback(
    (env: StreamEnvelope) => {
      const p = env.payload || {};
      switch (env.eventType) {
        case "session.created":
        case "session_created":
        case "session.updated":
        case "session_updated": {
          const s =
            (p.session as SessionSummary | undefined) ||
            (p as unknown as SessionSummary);
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
          const step =
            (p.step as TimelineStep | undefined) ||
            (p as unknown as TimelineStep);
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
          const chunk =
            typeof p.text === "string"
              ? p.text
              : typeof p.token === "string"
                ? p.token
                : "";
          const stepId =
            typeof p.stepId === "string" ? p.stepId : `stream_${sid}`;
          if (sid && chunk) {
            setTimelinesBySession((prev) => {
              const existing = prev[sid] || [];
              const idx = existing.findIndex((x) => x.id === stepId);
              if (idx >= 0) {
                const copy = [...existing];
                copy[idx] = {
                  ...copy[idx],
                  content: copy[idx].content + chunk,
                };
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
          const item =
            (p.approval as ApprovalItem | undefined) ||
            (p as unknown as ApprovalItem);
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
          const glance =
            (p.glance as HostGlanceSnapshot | undefined) ||
            (p as unknown as HostGlanceSnapshot);
          if (glance && typeof glance.cpuPercent === "number") {
            setHostGlance(glance);
          }
          break;
        }
        case "host.locked":
        case "panic_locked": {
          setHostGlance((prev) =>
            prev ? { ...prev, hostLocked: true } : prev
          );
          break;
        }
        case "host.unlocked":
        case "panic_unlocked": {
          setHostGlance((prev) =>
            prev ? { ...prev, hostLocked: false } : prev
          );
          break;
        }
        case "power.gear":
        case "power_gear_updated": {
          setHostGlance((prev) =>
            prev
              ? {
                  ...prev,
                  powerGear:
                    (p.powerGear as HostGlanceSnapshot["powerGear"]) ||
                    prev.powerGear,
                  autoGovernorEnabled:
                    typeof p.autoGovernorEnabled === "boolean"
                      ? p.autoGovernorEnabled
                      : prev.autoGovernorEnabled,
                }
              : prev
          );
          break;
        }
        case "agent_gate.updated": {
          const nextMode = p.agentGateMode as AgentGateMode | undefined;
          if (nextMode === "ask_on_phone" || nextMode === "agent_turbo") {
            setHostGlance((prev) =>
              prev ? { ...prev, agentGateMode: nextMode } : prev
            );
          }
          break;
        }
        case "agy.settings_updated": {
          const nextPreset = p.permissionPreset as PermissionPreset | undefined;
          const nextLayout = p.interfaceLayout as InterfaceLayout | undefined;
          if (nextPreset) setPermissionPresetState(nextPreset);
          if (nextLayout) setInterfaceLayoutState(nextLayout);
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
          const st =
            (p.tunnel as TunnelStatus | undefined) ||
            (p as unknown as TunnelStatus);
          if (st && st.status) {
            setTunnelStatus(st);
          }
          break;
        }
        case "pty.output":
        case "pty_output": {
          const sid = String(
            p.ptySessionId || p.sessionId || env.sessionId || ""
          );
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
          if (
            req &&
            req.ticketId &&
            !handledTicketsRef.current.has(req.ticketId)
          ) {
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
          const res = await api.claimPairingCode(
            pendingPairCode,
            "0G Mobile PWA"
          );
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
        void api
          .getAgyConversations({ includeSubagents: false, limit: 60 })
          .then(setAgyConversations)
          .catch(() => {});
        void api.getAgyPorts().then(setDevPorts).catch(() => {});
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
    setSessions((prev) => [
      created,
      ...prev.filter((s) => s.id !== created.id),
    ]);
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
    async (
      tool: MobileToolCreateRequest & { id?: string; enabled?: boolean }
    ) => {
      const saved = await api.saveMobileTool(tool);
      setMobileTools((prev) => {
        const idx = prev.findIndex(
          (t) => t.id === saved.id || t.name === saved.name
        );
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
        title: "Scheduled Task Triggered",
        body: `Task "${slug}" dispatched to Antigravity host.`,
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
        title: "Host Macro Executed",
        body: res.output ? res.output.slice(0, 140) : `Macro ${id} completed.`,
        severity: "info",
        ts: Date.now(),
      });
    },
    [pushNotifyCard]
  );

  const updatePowerGear = useCallback(async (req: PowerGearUpdateRequest) => {
    const next = await api.updatePowerGear(req);
    setHostGlance((prev) => (prev ? { ...prev, ...next } : next));
  }, []);

  const setAgentGateMode = useCallback(async (mode: AgentGateMode) => {
    const res = await api.updateAgentGate(mode);
    const applied = res.agentGateMode || mode;
    setHostGlance((prev) =>
      prev ? { ...prev, agentGateMode: applied } : prev
    );
    setPermissionPresetState(applied === "agent_turbo" ? "turbo" : "request_review");
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
    setPtySessions((prev) => [
      created,
      ...prev.filter((p) => p.id !== created.id),
    ]);
    setActivePtyId(created.id);
    if (created.buffer) {
      setPtyOutputBySession((prev) => ({
        ...prev,
        [created.id]: created.buffer || "",
      }));
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
      leftSidebarOpen,
      setLeftSidebarOpen,
      toggleLeftSidebar,
      rightAuxOpen,
      setRightAuxOpen,
      toggleRightAux,
      rightAuxTab,
      setRightAuxTab,
      openRightAuxTab,
      focusedArtifactPath,
      setFocusedArtifactPath,
      settingsModalOpen,
      settingsSection,
      openSettingsModal,
      closeSettingsModal,
      interfaceLayout,
      setInterfaceLayout,
      permissionPreset,
      setPermissionPreset,
      autostartStatus,
      updateAutostart,
      voiceCapabilities,
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
      agentGateMode: hostGlance?.agentGateMode || "ask_on_phone",
      setAgentGateMode,
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
      agyProjects,
      selectedProjectPath,
      setSelectedProjectPath,
      selectedProject,
      upsertProjectConfig,
      deleteProjectConfig,
      agyConversations,
      activeConversationId,
      setActiveConversationId,
      isNewChatDraft,
      startFreshNewConversationView,
      activeConversationDetail,
      swarmDetail,
      refreshSwarmDetail,
      nudgeConversation,
      agyConversationLoading,
      agyError,
      customizations,
      composerDraft,
      setComposerDraft,
      selectedModel,
      setSelectedModel,
      worktreeMode,
      setWorktreeMode,
      worktreeBranch,
      setWorktreeBranch,
      uploadedAttachments,
      uploadingAttachment,
      uploadAttachment,
      removeUploadedAttachment,
      clearUploadedAttachments,
      devPorts,
      refreshDevPorts,
      selectedPreviewPort,
      setSelectedPreviewPort,
      terminalCwd,
      setTerminalCwd,
      refreshAgyData,
      loadAgyConversationDetail,
      startNewAgyConversation,
      sendAgyChatMessage,
      voiceSnapshot,
      voiceMinimized,
      setVoiceMinimized,
      startVoiceCall,
      endVoiceCall,
      toggleVoiceMic,
      toggleVoiceSpeaker,
      cycleVoiceSpeed,
    }),
    [
      theme,
      setTheme,
      isAuxPane,
      leftSidebarOpen,
      toggleLeftSidebar,
      rightAuxOpen,
      setRightAuxOpen,
      toggleRightAux,
      rightAuxTab,
      setRightAuxTab,
      openRightAuxTab,
      focusedArtifactPath,
      settingsModalOpen,
      settingsSection,
      openSettingsModal,
      closeSettingsModal,
      interfaceLayout,
      setInterfaceLayout,
      permissionPreset,
      setPermissionPreset,
      autostartStatus,
      updateAutostart,
      voiceCapabilities,
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
      setAgentGateMode,
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
      agyProjects,
      selectedProjectPath,
      setSelectedProjectPath,
      selectedProject,
      upsertProjectConfig,
      deleteProjectConfig,
      agyConversations,
      activeConversationId,
      setActiveConversationId,
      isNewChatDraft,
      startFreshNewConversationView,
      activeConversationDetail,
      swarmDetail,
      refreshSwarmDetail,
      nudgeConversation,
      agyConversationLoading,
      agyError,
      customizations,
      composerDraft,
      selectedModel,
      worktreeMode,
      worktreeBranch,
      uploadedAttachments,
      uploadingAttachment,
      uploadAttachment,
      removeUploadedAttachment,
      clearUploadedAttachments,
      devPorts,
      refreshDevPorts,
      selectedPreviewPort,
      terminalCwd,
      refreshAgyData,
      loadAgyConversationDetail,
      startNewAgyConversation,
      sendAgyChatMessage,
      voiceSnapshot,
      voiceMinimized,
      startVoiceCall,
      endVoiceCall,
      toggleVoiceMic,
      toggleVoiceSpeaker,
      cycleVoiceSpeed,
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
