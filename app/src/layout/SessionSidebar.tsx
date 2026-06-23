import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Trash2 } from 'lucide-react';
import {
  useAppDispatch, useAppSelector,
  setActiveSessionId, removeSession,
  type RuntimeSession,
} from '../store/index.js';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function SessionRow({
  session, active, authToken, backendPort, socket, onSelect, onDelete,
}: {
  session: RuntimeSession;
  active: boolean;
  authToken: string;
  backendPort: number;
  socket: Socket | null;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const statusColor = session.status === 'ACTIVE' ? 'var(--success)' : 'var(--text-dim)';

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`http://localhost:${backendPort}/api/sessions/${session.sessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
    } catch { /* backend unavailable */ }
    onDelete();
  };

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        padding: '5px 12px 5px 16px',
        cursor: 'pointer',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        background: active ? 'var(--accent-soft)' : hovered ? 'var(--bg-hover)' : 'transparent',
        transition: 'background var(--dur) var(--ease)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: statusColor,
          boxShadow: session.status === 'ACTIVE' ? `0 0 5px ${statusColor}` : 'none',
        }} />
        <span style={{
          flex: 1, fontSize: 11.5, color: active ? 'var(--text)' : 'var(--text-muted)',
          fontWeight: active ? 600 : 400,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {session.title || 'Untitled session'}
        </span>
        {hovered && (
          <button
            onClick={handleDelete}
            title="Delete session"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', padding: 2, borderRadius: 3,
              display: 'flex', alignItems: 'center',
              transition: 'color var(--dur) var(--ease)',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--danger)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
          >
            <Trash2 size={10} />
          </button>
        )}
        {!hovered && (
          <span style={{ fontSize: 9, color: 'var(--text-dim)', flexShrink: 0 }}>
            {relativeTime(session.updatedAt)}
          </span>
        )}
      </div>
      {session.latestPrompt && (
        <div style={{
          marginTop: 2, marginLeft: 12,
          fontSize: 10, color: 'var(--text-dim)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {session.latestPrompt}
        </div>
      )}
    </div>
  );
}

export function SessionSidebar({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  const { sessions, activeSessionId, sessionId, authToken, backendPort } = useAppSelector((s) => s.app);

  const currentActiveId = activeSessionId ?? sessionId;

  const handleSelect = (session: RuntimeSession) => {
    if (session.sessionId === currentActiveId) return;
    if (currentActiveId && socket) socket.emit('leave:session', { sessionId: currentActiveId });
    if (socket) socket.emit('join:session', { sessionId: session.sessionId });
    dispatch(setActiveSessionId(session.sessionId));
  };

  const handleDelete = (sessionId: string) => {
    dispatch(removeSession(sessionId));
  };

  const sorted = [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  return (
    <aside style={{
      width: 240,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 16px 8px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '2px',
          color: 'var(--text-dim)', fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
        }}>
          CASCADE
        </span>
        <span style={{
          fontSize: 9, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono)',
        }}>
          {sorted.length}
        </span>
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 2, paddingBottom: 8 }}>
        {sorted.length === 0 ? (
          <div style={{
            padding: '24px 16px', textAlign: 'center',
            fontSize: 11, color: 'var(--text-dim)',
          }}>
            No sessions yet.<br />Run a task to get started.
          </div>
        ) : (
          sorted.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              active={s.sessionId === currentActiveId}
              authToken={authToken}
              backendPort={backendPort}
              socket={socket}
              onSelect={() => handleSelect(s)}
              onDelete={() => handleDelete(s.sessionId)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
