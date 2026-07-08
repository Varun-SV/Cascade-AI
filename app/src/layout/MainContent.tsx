import type { Socket } from 'socket.io-client';
import { useAppSelector } from '../store/index.js';
import { CockpitView } from '../views/CockpitView.js';
import { ChatView } from '../views/ChatView.js';
import { CodeView } from '../views/CodeView.js';
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
        {view === 'insights' && <InsightsView />}
      </div>
    </main>
  );
}
