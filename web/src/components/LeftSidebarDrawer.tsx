import React, { useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Layers,
  MessageSquare,
  Play,
  Plus,
  Puzzle,
  Search,
  Settings,
  Settings2,
  Shield,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useZeroG } from "../lib/store";
import type {
  AgyCustomizationEntry,
  AgyProject,
  ProjectPermissionPreset,
  WorktreeMode,
} from "../types/contracts";

const PROJECT_PRESET_OPTIONS: Array<{
  id: ProjectPermissionPreset;
  label: string;
}> = [
  { id: "inherit", label: "Inherit Global" },
  { id: "request_review", label: "Request Review" },
  { id: "default", label: "Default" },
  { id: "auto", label: "Auto" },
  { id: "turbo", label: "Turbo" },
];

const PRESET_BADGE: Record<ProjectPermissionPreset, string> = {
  inherit: "",
  request_review: "Review",
  default: "Default",
  auto: "Auto",
  turbo: "Turbo",
};

function folderBasename(p: string): string {
  const clean = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return clean[clean.length - 1] || p;
}

function formatRelShort(tsSec?: number | null): string {
  if (!tsSec) return "";
  const ms = tsSec > 1e12 ? tsSec : tsSec * 1000;
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function formatCustEntry(entry: AgyCustomizationEntry | string): {
  title: string;
  sub?: string;
} {
  if (typeof entry === "string") return { title: entry };
  return {
    title: entry.name || entry.command || entry.id || "Customization",
    sub: entry.description || entry.source || undefined,
  };
}

export const LeftSidebarDrawer: React.FC = () => {
  const {
    leftSidebarOpen,
    setLeftSidebarOpen,
    openSettingsModal,
    agyProjects,
    projects,
    selectedProject,
    setSelectedProjectPath,
    upsertProjectConfig,
    deleteProjectConfig,
    agyConversations,
    activeConversationId,
    setActiveConversationId,
    startFreshNewConversationView,
    isNewChatDraft,
    automations,
    runAutomation,
    customizations,
    interfaceLayout,
    permissionPreset,
  } = useZeroG();

  const [searchQuery, setSearchQuery] = useState("");
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [recentExpanded, setRecentExpanded] = useState(true);
  const [scheduledExpanded, setScheduledExpanded] = useState(false);
  const [custExpanded, setCustExpanded] = useState(false);
  const [runningAutoSlug, setRunningAutoSlug] = useState<string | null>(null);

  // Project Config / New Multi-Folder Project Modal state
  const [editingProject, setEditingProject] = useState<{
    id: string | null;
    name: string;
    folders: string[];
    permissionPreset: ProjectPermissionPreset;
    defaultWorktreeMode: WorktreeMode;
    isCustom: boolean;
  } | null>(null);
  const [customFolderInput, setCustomFolderInput] = useState("");
  const [savingProject, setSavingProject] = useState(false);
  const [projectFormError, setProjectFormError] = useState<string | null>(null);

  const availableFolders = useMemo(() => {
    const set = new Set<string>();
    for (const p of agyProjects) {
      if (p.path) set.add(p.path);
      for (const f of p.folders || []) {
        if (f) set.add(f);
      }
    }
    for (const p of projects) {
      if (p.path) set.add(p.path);
    }
    return Array.from(set);
  }, [agyProjects, projects]);

  const q = searchQuery.trim().toLowerCase();

  const filteredProjects = useMemo(() => {
    if (!q) return agyProjects;
    return agyProjects.filter((p) => {
      const hay = `${p.name} ${p.path} ${(p.folders || []).join(" ")} ${
        p.gitBranch || ""
      }`.toLowerCase();
      return hay.includes(q);
    });
  }, [agyProjects, q]);

  const filteredConversations = useMemo(() => {
    if (!q) return agyConversations;
    return agyConversations.filter((c) => {
      const hay = `${c.title} ${c.projectName || ""} ${c.workspacePaths.join(
        " "
      )}`.toLowerCase();
      return hay.includes(q);
    });
  }, [agyConversations, q]);

  const closeOnMobile = () => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setLeftSidebarOpen(false);
    }
  };

  const openNewProjectModal = () => {
    setProjectFormError(null);
    setCustomFolderInput("");
    setEditingProject({
      id: null,
      name: "",
      folders: agyProjects[0]?.path ? [agyProjects[0].path] : [],
      permissionPreset: "inherit",
      defaultWorktreeMode: "local",
      isCustom: true,
    });
  };

  const openEditProjectModal = (proj: AgyProject) => {
    setProjectFormError(null);
    setCustomFolderInput("");
    const folders =
      proj.folders && proj.folders.length > 0 ? proj.folders : [proj.path];
    setEditingProject({
      id: proj.id,
      name: proj.name,
      folders,
      permissionPreset: proj.permissionPreset || "inherit",
      defaultWorktreeMode: proj.defaultWorktreeMode || "local",
      isCustom: Boolean(proj.isCustom),
    });
  };

  const toggleFolderInModal = (folderPath: string) => {
    setEditingProject((prev) => {
      if (!prev) return prev;
      const exists = prev.folders.includes(folderPath);
      const nextFolders = exists
        ? prev.folders.filter((f) => f !== folderPath)
        : [...prev.folders, folderPath];
      const autoName =
        prev.name.trim() ||
        (nextFolders.length > 0 ? folderBasename(nextFolders[0]) : "");
      return {
        ...prev,
        name: autoName,
        folders: nextFolders,
      };
    });
  };

  const handleAddCustomFolder = () => {
    const trimmed = customFolderInput.trim();
    if (!trimmed) return;
    setEditingProject((prev) => {
      if (!prev) return prev;
      if (prev.folders.includes(trimmed)) return prev;
      return {
        ...prev,
        name: prev.name.trim() || folderBasename(trimmed),
        folders: [...prev.folders, trimmed],
      };
    });
    setCustomFolderInput("");
  };

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject) return;
    if (editingProject.folders.length === 0) {
      setProjectFormError("Select or enter at least one workspace folder.");
      return;
    }
    const cleanName =
      editingProject.name.trim() || folderBasename(editingProject.folders[0]);
    setSavingProject(true);
    setProjectFormError(null);
    try {
      await upsertProjectConfig({
        id: editingProject.id,
        name: cleanName,
        folders: editingProject.folders,
        permissionPreset: editingProject.permissionPreset,
        defaultWorktreeMode: editingProject.defaultWorktreeMode,
      });
      setEditingProject(null);
    } catch (err) {
      setProjectFormError(
        err instanceof Error ? err.message : "Failed to save project settings"
      );
    } finally {
      setSavingProject(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!editingProject?.id) return;
    setSavingProject(true);
    setProjectFormError(null);
    try {
      await deleteProjectConfig(editingProject.id);
      setEditingProject(null);
    } catch (err) {
      setProjectFormError(
        err instanceof Error ? err.message : "Failed to delete project"
      );
    } finally {
      setSavingProject(false);
    }
  };

  const handleRunAutomation = async (slug: string) => {
    setRunningAutoSlug(slug);
    try {
      await runAutomation(slug);
    } finally {
      setRunningAutoSlug(null);
    }
  };

  const custCount =
    (customizations?.plugins?.length || 0) +
    (customizations?.skills?.length || 0) +
    (customizations?.rules?.length || 0);

  const sidebarContent = (
    <div
      className="h-full w-72 max-w-[86vw] flex flex-col border-r select-none"
      style={{
        backgroundColor: "var(--bg-surface)",
        borderColor: "var(--border-default)",
        color: "var(--text-primary)",
      }}
    >
      {/* Top Action + Search */}
      <div
        className="p-3 space-y-2.5 border-b shrink-0"
        style={{ borderColor: "var(--border-default)" }}
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => startFreshNewConversationView()}
            className={`flex-1 min-h-[44px] px-3 rounded-[var(--radius-inner)] border flex items-center gap-2 text-sm font-semibold ${
              isNewChatDraft ? "btn-primary" : "btn-secondary !justify-start"
            }`}
          >
            <SquarePen className="w-4 h-4 shrink-0" />
            <span className="truncate">New Conversation</span>
          </button>

          <button
            type="button"
            onClick={() => setLeftSidebarOpen(false)}
            className="agy-icon-btn lg:hidden"
            aria-label="Close sidebar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="relative flex items-center">
          <Search
            className="w-4 h-4 absolute left-3 pointer-events-none"
            style={{ color: "var(--text-muted)" }}
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search projects & chats…"
            aria-label="Search projects and conversations"
            className="w-full rounded-[var(--radius-inner)] border pl-9 pr-3 py-2 text-base"
            style={{
              backgroundColor: "var(--bg-subtle)",
              borderColor: "var(--border-default)",
              color: "var(--text-primary)",
            }}
          />
        </div>
      </div>

      {/* Scrollable Navigation Sections */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {/* 1. Projects (Multi-Folder + Presets) */}
        <section aria-label="Projects">
          <div className="flex items-center justify-between px-1">
            <button
              type="button"
              onClick={() => setProjectsExpanded((v) => !v)}
              className="flex items-center gap-1.5 min-h-[44px] px-1 text-xs font-semibold uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              {projectsExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              <span>Projects ({filteredProjects.length})</span>
            </button>

            <button
              type="button"
              onClick={openNewProjectModal}
              className="agy-icon-btn"
              title="New Multi-Folder Project"
              aria-label="Create new multi-folder project"
            >
              <FolderPlus className="w-4 h-4" />
            </button>
          </div>

          {projectsExpanded && (
            <div className="space-y-1 mt-0.5">
              {filteredProjects.length === 0 ? (
                <p
                  className="px-3 py-2 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  No matching projects.
                </p>
              ) : (
                filteredProjects.map((proj) => {
                  const isSelected = selectedProject?.id === proj.id;
                  const folderList =
                    proj.folders && proj.folders.length > 0
                      ? proj.folders
                      : [proj.path];
                  const presetKey = proj.permissionPreset || "inherit";

                  return (
                    <div
                      key={proj.id}
                      className="rounded-[var(--radius-inner)] border p-1.5 space-y-1"
                      style={{
                        backgroundColor: isSelected
                          ? "var(--bg-elevated)"
                          : "var(--bg-subtle)",
                        borderColor: isSelected
                          ? "var(--accent-primary)"
                          : "var(--border-default)",
                      }}
                    >
                      <div className="flex items-center gap-1 min-w-0">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedProjectPath(proj.path);
                            closeOnMobile();
                          }}
                          className="flex-1 min-w-0 min-h-[44px] px-1.5 flex items-center gap-2 text-left"
                        >
                          {folderList.length > 1 ? (
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
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold truncate">
                              {proj.name}
                            </div>
                            <div
                              className="flex items-center gap-1.5 text-[10px] font-mono truncate"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {folderList.length > 1 ? (
                                <span>{folderList.length} folders</span>
                              ) : (
                                <span className="truncate">
                                  {folderBasename(proj.path)}
                                </span>
                              )}
                              {proj.gitBranch && (
                                <span
                                  className="inline-flex items-center gap-0.5 truncate"
                                  style={{ color: "var(--accent-secondary)" }}
                                >
                                  · <GitBranch className="w-2.5 h-2.5 shrink-0" />
                                  {proj.gitBranch}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => startFreshNewConversationView(proj.path)}
                          className="agy-icon-btn !min-w-[44px] !min-h-[44px]"
                          title={`New conversation in ${proj.name}`}
                          aria-label={`New conversation in ${proj.name}`}
                        >
                          <Plus className="w-4 h-4" />
                        </button>

                        <button
                          type="button"
                          onClick={() => openEditProjectModal(proj)}
                          className="agy-icon-btn !min-w-[44px] !min-h-[44px]"
                          title={`Configure ${proj.name}`}
                          aria-label={`Configure ${proj.name}`}
                        >
                          <Settings2 className="w-4 h-4" />
                        </button>
                      </div>

                      {(folderList.length > 1 ||
                        proj.dirtyCount > 0 ||
                        presetKey !== "inherit") && (
                        <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1">
                          {folderList.length > 1 &&
                            folderList.map((f) => (
                              <span
                                key={f}
                                className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-mono border max-w-full truncate"
                                style={{
                                  backgroundColor: "var(--bg-surface)",
                                  borderColor: "var(--border-default)",
                                  color: "var(--text-muted)",
                                }}
                                title={f}
                              >
                                <Folder className="w-2.5 h-2.5 shrink-0" />
                                {folderBasename(f)}
                              </span>
                            ))}
                          {proj.dirtyCount > 0 && (
                            <span
                              className="rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums"
                              style={{
                                backgroundColor: "var(--status-warning-bg)",
                                color: "var(--status-warning-fg)",
                              }}
                            >
                              {proj.dirtyCount} modified
                            </span>
                          )}
                          {presetKey !== "inherit" && (
                            <span
                              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-mono"
                              style={{
                                backgroundColor: "var(--status-info-bg)",
                                color: "var(--status-info-fg)",
                              }}
                            >
                              <Shield className="w-2.5 h-2.5" />
                              {PRESET_BADGE[presetKey]}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </section>

        {/* 2. Recent Conversations */}
        <section aria-label="Recent Conversations">
          <button
            type="button"
            onClick={() => setRecentExpanded((v) => !v)}
            className="w-full flex items-center justify-between min-h-[44px] px-2 text-xs font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              {recentExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              Recent Conversations ({filteredConversations.length})
            </span>
          </button>

          {recentExpanded && (
            <div className="space-y-1 mt-0.5">
              {filteredConversations.length === 0 ? (
                <p
                  className="px-3 py-2 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  No conversations found.
                </p>
              ) : (
                filteredConversations.map((conv) => {
                  const active =
                    !isNewChatDraft && activeConversationId === conv.id;
                  const isRunning = conv.status === "running";
                  const projLabel =
                    conv.projectName ||
                    (conv.workspacePaths[0]
                      ? folderBasename(conv.workspacePaths[0])
                      : null);

                  return (
                    <button
                      key={conv.id}
                      type="button"
                      onClick={() => {
                        setActiveConversationId(conv.id);
                        closeOnMobile();
                      }}
                      className="w-full min-h-[46px] px-2.5 py-2 rounded-[var(--radius-inner)] border text-left flex items-start gap-2.5"
                      style={{
                        backgroundColor: active
                          ? "var(--bg-elevated)"
                          : "transparent",
                        borderColor: active
                          ? "var(--accent-primary)"
                          : "transparent",
                      }}
                    >
                      <span className="mt-1 shrink-0">
                        {isRunning ? (
                          <span
                            className="block w-2.5 h-2.5 rounded-full animate-pulse"
                            style={{ backgroundColor: "var(--status-success)" }}
                            title="Running"
                          />
                        ) : (
                          <MessageSquare
                            className="w-3.5 h-3.5"
                            style={{
                              color: active
                                ? "var(--accent-primary)"
                                : "var(--text-muted)",
                            }}
                          />
                        )}
                      </span>

                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="text-xs font-medium truncate">
                          {conv.title || "Untitled conversation"}
                        </div>
                        <div
                          className="flex items-center gap-1.5 text-[10px] font-mono tabular-nums truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {projLabel && (
                            <span className="truncate max-w-[110px]">
                              {projLabel}
                            </span>
                          )}
                          <span>· {conv.stepCount} steps</span>
                          {conv.lastModifiedAt > 0 && (
                            <span>· {formatRelShort(conv.lastModifiedAt)}</span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </section>

        {/* 3. Scheduled Tasks (/api/automations) */}
        <section aria-label="Scheduled Tasks">
          <button
            type="button"
            onClick={() => setScheduledExpanded((v) => !v)}
            className="w-full flex items-center justify-between min-h-[44px] px-2 text-xs font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              {scheduledExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              <CalendarClock className="w-3.5 h-3.5" />
              Scheduled Tasks ({automations.length})
            </span>
          </button>

          {scheduledExpanded && (
            <div className="space-y-1.5 px-1 pt-1">
              {automations.length === 0 ? (
                <p
                  className="px-2 py-1.5 text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  No scheduled tasks configured. Use <code>/schedule</code> in
                  chat to add one.
                </p>
              ) : (
                automations.map((auto) => (
                  <div
                    key={auto.slug}
                    className="surface-subtle p-2 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold truncate">
                        {auto.name}
                      </div>
                      <div
                        className="text-[10px] font-mono truncate"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {auto.schedule}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={runningAutoSlug === auto.slug}
                      onClick={() => void handleRunAutomation(auto.slug)}
                      className="btn-secondary !min-h-[44px] !min-w-[44px] !px-2.5 text-xs shrink-0"
                      aria-label={`Run scheduled task ${auto.name}`}
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>
                        {runningAutoSlug === auto.slug ? "…" : "Run"}
                      </span>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </section>

        {/* 4. Customizations (/api/agy/customizations) */}
        <section aria-label="Customizations">
          <button
            type="button"
            onClick={() => setCustExpanded((v) => !v)}
            className="w-full flex items-center justify-between min-h-[44px] px-2 text-xs font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              {custExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              <Puzzle className="w-3.5 h-3.5" />
              Customizations ({custCount})
            </span>
          </button>

          {custExpanded && (
            <div className="space-y-2 px-1 pt-1">
              {(
                [
                  {
                    key: "plugins",
                    label: "Plugins",
                    items: customizations?.plugins || [],
                  },
                  {
                    key: "skills",
                    label: "Skills",
                    items: customizations?.skills || [],
                  },
                  {
                    key: "rules",
                    label: "Rules",
                    items: customizations?.rules || [],
                  },
                ] as const
              ).map((grp) => (
                <div key={grp.key} className="space-y-1">
                  <div
                    className="px-1 text-[10px] font-mono uppercase"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {grp.label} ({grp.items.length})
                  </div>
                  {grp.items.length === 0 ? (
                    <p
                      className="px-2 text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      None
                    </p>
                  ) : (
                    grp.items.slice(0, 12).map((item, idx) => {
                      const info = formatCustEntry(item);
                      return (
                        <div
                          key={`${grp.key}-${idx}`}
                          className="surface-subtle px-2.5 py-1.5 text-xs"
                        >
                          <div className="font-mono text-[11px] font-semibold truncate">
                            {info.title}
                          </div>
                          {info.sub && (
                            <div
                              className="text-[10px] truncate"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {info.sub}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Pinned Bottom Settings Button */}
      <div
        className="p-2.5 border-t shrink-0"
        style={{ borderColor: "var(--border-default)" }}
      >
        <button
          type="button"
          onClick={() => {
            openSettingsModal("general");
            closeOnMobile();
          }}
          className="w-full min-h-[46px] px-3 rounded-[var(--radius-inner)] border flex items-center justify-between gap-2 text-left"
          style={{
            backgroundColor: "var(--bg-subtle)",
            borderColor: "var(--border-default)",
            color: "var(--text-primary)",
          }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Settings
              className="w-4 h-4 shrink-0"
              style={{ color: "var(--accent-primary)" }}
            />
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate">Settings</div>
              <div
                className="text-[10px] font-mono truncate"
                style={{ color: "var(--text-muted)" }}
              >
                {interfaceLayout === "software_engineering"
                  ? "Software Eng"
                  : "Knowledge Work"}{" "}
                · {permissionPreset.replace("_", " ")}
              </div>
            </div>
          </div>
          <ChevronRight
            className="w-4 h-4 shrink-0"
            style={{ color: "var(--text-muted)" }}
          />
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Docked Sidebar */}
      {leftSidebarOpen && (
        <aside
          aria-label="Antigravity Navigation Sidebar"
          className="hidden lg:flex h-full shrink-0"
        >
          {sidebarContent}
        </aside>
      )}

      {/* Mobile Slide-Over Drawer */}
      {leftSidebarOpen && (
        <div
          className="fixed inset-0 z-40 flex lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation Drawer"
        >
          <div
            className="fixed inset-0"
            style={{ backgroundColor: "var(--overlay-scrim)" }}
            onClick={() => setLeftSidebarOpen(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 h-full">{sidebarContent}</div>
        </div>
      )}

      {/* Multi-Folder Project Create / Edit Modal */}
      {editingProject && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3"
          style={{ backgroundColor: "var(--overlay-scrim)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-config-title"
        >
          <div className="surface-card w-full max-w-lg max-h-[90dvh] flex flex-col overflow-hidden">
            <div
              className="px-4 py-3 border-b flex items-center justify-between gap-2"
              style={{ borderColor: "var(--border-default)" }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Layers
                  className="w-4 h-4 shrink-0"
                  style={{ color: "var(--accent-primary)" }}
                />
                <h2
                  id="project-config-title"
                  className="font-display text-sm font-bold truncate"
                >
                  {editingProject.id
                    ? "Project Folders & Permissions"
                    : "New Multi-Folder Project"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                className="agy-icon-btn"
                aria-label="Close project dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => void handleSaveProject(e)}
              className="flex-1 overflow-y-auto p-4 space-y-4"
            >
              <label className="block space-y-1">
                <span
                  className="text-xs font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  Project Name
                </span>
                <input
                  type="text"
                  value={editingProject.name}
                  onChange={(e) =>
                    setEditingProject((prev) =>
                      prev ? { ...prev, name: e.target.value } : prev
                    )
                  }
                  placeholder="e.g. Full-Stack Workspace"
                  className="w-full rounded-[var(--radius-inner)] border px-3 py-2.5 text-base"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderColor: "var(--border-default)",
                    color: "var(--text-primary)",
                  }}
                />
              </label>

              {/* Multi-Folder Picker (F:\ & scratch\ workspaces) */}
              <div className="space-y-2">
                <span
                  className="block text-xs font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  Workspace Folders ({editingProject.folders.length} selected)
                </span>

                <div className="max-h-44 overflow-y-auto space-y-1.5 pr-1">
                  {Array.from(
                    new Set([...availableFolders, ...editingProject.folders])
                  ).map((folderPath) => {
                    const checked = editingProject.folders.includes(folderPath);
                    return (
                      <button
                        key={folderPath}
                        type="button"
                        onClick={() => toggleFolderInModal(folderPath)}
                        className="w-full min-h-[44px] px-3 py-2 rounded-[var(--radius-inner)] border flex items-center justify-between gap-2 text-left"
                        style={{
                          backgroundColor: checked
                            ? "var(--bg-elevated)"
                            : "var(--bg-subtle)",
                          borderColor: checked
                            ? "var(--accent-primary)"
                            : "var(--border-default)",
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold truncate">
                            {folderBasename(folderPath)}
                          </div>
                          <div
                            className="text-[11px] font-mono truncate"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {folderPath}
                          </div>
                        </div>
                        {checked && (
                          <Check
                            className="w-4 h-4 shrink-0"
                            style={{ color: "var(--accent-primary)" }}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Add folder path manually from F:\ or scratch\ */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={customFolderInput}
                    onChange={(e) => setCustomFolderInput(e.target.value)}
                    placeholder="Add folder path (e.g. F:\repo or scratch\app)"
                    className="flex-1 min-w-0 rounded-[var(--radius-inner)] border px-3 py-2 text-base font-mono"
                    style={{
                      backgroundColor: "var(--bg-subtle)",
                      borderColor: "var(--border-default)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomFolder}
                    className="btn-secondary !min-h-[44px] !px-3 text-xs shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
              </div>

              {/* Per-Project Permission Preset */}
              <div className="space-y-1.5">
                <span
                  className="block text-xs font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  Project Permission Preset
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {PROJECT_PRESET_OPTIONS.map((opt) => {
                    const active = editingProject.permissionPreset === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          setEditingProject((prev) =>
                            prev ? { ...prev, permissionPreset: opt.id } : prev
                          )
                        }
                        className={
                          active
                            ? "btn-primary !min-h-[44px] !px-2.5 text-xs"
                            : "btn-secondary !min-h-[44px] !px-2.5 text-xs"
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Default Worktree Mode */}
              <div className="space-y-1.5">
                <span
                  className="block text-xs font-semibold"
                  style={{ color: "var(--text-muted)" }}
                >
                  Default Git Execution Mode
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setEditingProject((prev) =>
                        prev ? { ...prev, defaultWorktreeMode: "local" } : prev
                      )
                    }
                    className={
                      editingProject.defaultWorktreeMode === "local"
                        ? "btn-primary !min-h-[44px] text-xs"
                        : "btn-secondary !min-h-[44px] text-xs"
                    }
                  >
                    Local mode
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingProject((prev) =>
                        prev
                          ? { ...prev, defaultWorktreeMode: "worktree" }
                          : prev
                      )
                    }
                    className={
                      editingProject.defaultWorktreeMode === "worktree"
                        ? "btn-primary !min-h-[44px] text-xs"
                        : "btn-secondary !min-h-[44px] text-xs"
                    }
                  >
                    New worktree mode
                  </button>
                </div>
              </div>

              {projectFormError && (
                <div
                  role="alert"
                  className="rounded-[var(--radius-inner)] border p-2.5 text-xs"
                  style={{
                    backgroundColor: "var(--status-danger-bg)",
                    borderColor: "var(--status-danger)",
                    color: "var(--status-danger-fg)",
                  }}
                >
                  {projectFormError}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                {editingProject.id && editingProject.isCustom ? (
                  <button
                    type="button"
                    disabled={savingProject}
                    onClick={() => void handleDeleteProject()}
                    className="btn-danger !min-h-[44px] !px-3 text-xs"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                ) : (
                  <span />
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingProject(null)}
                    className="btn-secondary !min-h-[44px] !px-3 text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingProject}
                    className="btn-primary !min-h-[44px] !px-4 text-xs"
                  >
                    {savingProject ? "Saving…" : "Save Project"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
