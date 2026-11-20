import React from "react";
import {
  FolderKanban,
  Inbox,
  Laptop,
  PlusCircle,
  Wrench,
} from "lucide-react";
import { AuxPaneView } from "./components/AuxPaneView";
import { HostTab } from "./components/HostTab";
import { InboxTab } from "./components/InboxTab";
import { MobilePromptModal } from "./components/MobilePromptModal";
import { NewWorkerTab } from "./components/NewWorkerTab";
import { PairingModal } from "./components/PairingModal";
import { ProjectsFeedTab } from "./components/ProjectsFeedTab";
import { ToolsTab } from "./components/ToolsTab";
import { TopHeader } from "./components/TopHeader";
import { ZeroGStoreProvider, useZeroG } from "./lib/store";
import type { ActiveTab } from "./types/contracts";

const AppShell: React.FC = () => {
  const { isAuxPane, activeTab, setActiveTab, approvals } = useZeroG();
  const pendingCount = approvals.filter((a) => a.status === "pending").length;

  const tabs: Array<{
    id: ActiveTab;
    label: string;
    Icon: React.FC<{ className?: string }>;
    badge?: number;
  }> = [
    { id: "projects", label: "Projects", Icon: FolderKanban },
    { id: "inbox", label: "Inbox", Icon: Inbox, badge: pendingCount },
    { id: "new", label: "+ New", Icon: PlusCircle },
    { id: "tools", label: "Tools", Icon: Wrench },
    { id: "host", label: "Host", Icon: Laptop },
  ];

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        backgroundColor: "var(--bg-canvas)",
        color: "var(--text-primary)",
      }}
    >
      <TopHeader />

      {isAuxPane ? (
        <AuxPaneView />
      ) : (
        <>
          <main className="flex-1 mx-auto w-full max-w-4xl px-4 pt-4 pb-24">
            {activeTab === "projects" && <ProjectsFeedTab />}
            {activeTab === "inbox" && <InboxTab />}
            {activeTab === "new" && <NewWorkerTab />}
            {activeTab === "tools" && <ToolsTab />}
            {activeTab === "host" && <HostTab />}
          </main>

          <nav
            aria-label="Primary Navigation"
            className="fixed bottom-0 inset-x-0 z-30 border-t"
            style={{
              backgroundColor: "var(--bg-surface)",
              borderColor: "var(--border-default)",
            }}
          >
            <div className="mx-auto max-w-4xl grid grid-cols-5">
              {tabs.map(({ id, label, Icon, badge }) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveTab(id)}
                    aria-current={active ? "page" : undefined}
                    className="relative flex flex-col items-center justify-center gap-1 min-h-[56px] px-1 py-2 text-xs font-medium transition-opacity"
                    style={{
                      color: active
                        ? "var(--accent-primary)"
                        : "var(--text-muted)",
                    }}
                  >
                    <div className="relative">
                      <Icon className="w-5 h-5" />
                      {typeof badge === "number" && badge > 0 && (
                        <span
                          className="absolute -top-1.5 -right-2.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono font-bold tabular-nums flex items-center justify-center"
                          style={{
                            backgroundColor: "var(--status-warning)",
                            color: "var(--accent-primary-fg)",
                          }}
                        >
                          {badge}
                        </span>
                      )}
                    </div>
                    <span className="truncate max-w-full">{label}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </>
      )}

      <PairingModal />
      <MobilePromptModal />
    </div>
  );
};

export function App(): React.ReactElement {
  return (
    <ZeroGStoreProvider>
      <AppShell />
    </ZeroGStoreProvider>
  );
}

export default App;
