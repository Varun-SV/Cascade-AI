import type { Socket } from 'socket.io-client';
import { useAppSelector } from '../store/index.js';
import { CockpitView } from '../views/CockpitView.js';
import { ChatView } from '../views/ChatView.js';
import { CodeView } from '../views/CodeView.js';

export function MainContent({ socket }: { socket: Socket | null }) {
  const view = useAppSelector((s) => s.app.view);

  return (
    <main style={{ flex: 1, overflow: 'hidden', position: 'relative', background: 'var(--bg-base)' }}>
      {view === 'cockpit' && <CockpitView socket={socket} />}
      {view === 'chat'    && <ChatView socket={socket} />}
      {view === 'code'    && <CodeView />}
    </main>
  );
}
