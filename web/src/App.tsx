import React from "react";
import { AuxPaneView } from "./components/AuxPaneView";
import { ChatCanvas } from "./components/ChatCanvas";
import { LeftSidebarDrawer } from "./components/LeftSidebarDrawer";
import { MobilePromptModal } from "./components/MobilePromptModal";
import { PairingModal } from "./components/PairingModal";
import { RightAuxPane } from "./components/RightAuxPane";
import { SettingsModal } from "./components/SettingsModal";
import { TopHeader } from "./components/TopHeader";
import { ZeroGStoreProvider, useZeroG } from "./lib/store";

const AppShell: React.FC = () => {
  const { isAuxPane } = useZeroG();

  return (
    <div
      className="h-[100dvh] w-full flex flex-col overflow-hidden"
      style={{
        backgroundColor: "var(--bg-canvas)",
        color: "var(--text-primary)",
      }}
    >
      <TopHeader />

      {isAuxPane ? (
        <AuxPaneView />
      ) : (
        <div className="flex-1 flex min-h-0 relative overflow-hidden">
          <LeftSidebarDrawer />
          <ChatCanvas />
          <RightAuxPane />
        </div>
      )}

      <SettingsModal />
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
