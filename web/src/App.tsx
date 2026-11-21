import React from "react";
import {
  FolderKanban,
  Laptop,
  MessageSquare,
  Terminal,
} from "lucide-react";
import { AuxPaneView } from "./components/AuxPaneView";
import { ChatTab } from "./components/ChatTab";
import { LaptopTab } from "./components/LaptopTab";
import { MobilePromptModal } from "./components/MobilePromptModal";
import { PairingModal } from "./components/PairingModal";
import { ProjectsWorkspaceTab } from "./components/ProjectsWorkspaceTab";
import { TerminalTab } from "./components/TerminalTab";
import { TopHeader } from "./components/TopHeader";
import { ZeroGStoreProvider, useZeroG } from "./lib/store";
import type { ActiveTab } from "./types/contracts";

const AppShell: React.FC = () => {
  const { isAuxPane, activeTab, setActiveTab } = useZeroG();

  const tabs: Array<{
    id: ActiveTab;
    label: string;
    Icon: React.FC<{ className?: string }>;
  }> = [
    { id: "chat", label: "Chat", Icon: MessageSquare },
    { id: "projects", label: "Projects", Icon: FolderKanban },
    { id: "terminal", label: "Terminal", Icon: Terminal },
    { id: "laptop", label: "Laptop", Icon: Laptop },
  ];

  return (
    <div
      className="min-h-screen flex flex-col overflow-x-hidden"
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
          <main className="flex-1 mx-auto w-full max-w-4xl px-3 sm:px-4 pt-3 pb-24 min-w-0">
            {activeTab === "chat" && <ChatTab />}
            {activeTab === "projects" && <ProjectsWorkspaceTab />}
            {activeTab === "terminal" && <TerminalTab />}
            {activeTab === "laptop" && <LaptopTab />}
          </main>

          <nav
            aria-label="Primary Navigation"
            className="fixed bottom-0 inset-x-0 z-30 border-t"
            style={{
              backgroundColor: "var(--bg-surface)",
              borderColor: "var(--border-default)",
            }}
          >
            <div className="mx-auto max-w-4xl grid grid-cols-4">
              {tabs.map(({ id, label, Icon }) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveTab(id)}
                    aria-current={active ? "page" : undefined}
                    className="relative flex flex-col items-center justify-center gap-1 min-h-[56px] min-w-[44px] px-1 py-2 text-xs font-medium transition-opacity"
                    style={{
                      color: active
                        ? "var(--accent-primary)"
                        : "var(--text-muted)",
                    }}
                  >
                    <Icon className="w-5 h-5 shrink-0" />
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
