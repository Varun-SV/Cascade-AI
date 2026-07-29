import type { Socket } from 'socket.io-client';
import { useAppSelector } from '../store/index.js';
import { CockpitView } from '../views/CockpitView.js';
import { ChatView } from '../views/ChatView.js';
import { CodeView } from '../views/CodeView.js';
import { BrowserView } from '../views/BrowserView.js';
import { InsightsView } from '../views/InsightsView.js';
import { ReconnectBanner } from '../components/ReconnectBanner.js';

export function MainContent({ socket }: { socket: Socket | null }) {
  const view = useAppSelector((s) => s.app.view);
  const openTabs = useAppSelector((s) => s.app.openTabs);
  const activeTabId = useAppSelector((s) => s.app.activeTabId);
  // The browser tab can be reached two ways: a full view switch (Activity
  // Bar / "Go to Browser") or as the active entry in the tab strip — same
  // singleton BrowserView either way (see BROWSER_TAB_ID).
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const showBrowser = view === 'browser' || activeTab?.type === 'browser';

  return (
    <main style={{ flex: 1, overflow: 'hidden', position: 'relative', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column' }}>
      <ReconnectBanner />
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {view === 'cockpit'  && <CockpitView socket={socket} />}
        {view === 'chat'     && <ChatView socket={socket} />}
        {view === 'code'     && <CodeView socket={socket} />}
        {showBrowser         && <BrowserView />}
        {view === 'insights' && <InsightsView />}
      </div>
    </main>
  );
}
