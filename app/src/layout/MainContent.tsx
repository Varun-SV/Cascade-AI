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

  return (
    <main style={{ flex: 1, overflow: 'hidden', position: 'relative', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column' }}>
      <ReconnectBanner />
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {view === 'cockpit'  && <CockpitView socket={socket} />}
        {view === 'chat'     && <ChatView socket={socket} />}
        {view === 'code'     && <CodeView socket={socket} />}
        {/* The browser tab is a fixed singleton (see BROWSER_TAB_ID) and every
            path that activates it — CommandPalette, clicking the tab in
            TabBar — sets `view` to 'browser' in the same dispatch, so `view`
            alone is the source of truth. It must be: BrowserView renders a
            native WebContentsView layered above the whole React tree, so if
            this also stayed true while `view` moved on to something else
            (switching away via the Activity Bar only changes `view`, not
            which tab is "active"), the browser would keep covering the
            newly-selected view instead of yielding to it. */}
        {view === 'browser'  && <BrowserView />}
        {view === 'insights' && <InsightsView />}
      </div>
    </main>
  );
}
