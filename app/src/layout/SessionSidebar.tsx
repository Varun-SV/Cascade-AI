import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Trash2, MessageSquare, PanelLeftClose, PanelLeftOpen, RotateCcw, Download, GitCompareArrows, MonitorSmartphone } from 'lucide-react';
import {
  useAppDispatch, useAppSelector,
  setActiveSessionId, removeSession, loadTranscript,
  toggleSessionSidebar, setSessionSidebarCollapsed, setChangesSessionId, setShowContinue,
  type RuntimeSession,
} from '../store/index.js';
import { fetchSessionTranscript } from '../utils/sessionLoad.js';
import { PromptDialog } from '../components/PromptDialog.js';

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
  session, active, authToken, backendPort, socket, onSelect, onDelete, onRollback, onReviewChanges,
}: {
  session: RuntimeSession;
  active: boolean;
  authToken: string;
  backendPort: number;
  socket: Socket | null;
  onSelect: () => void;
  onDelete: () => void;
  onRollback: () => void;
  onReviewChanges: () => void;
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

  const handleExport = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(`http://localhost:${backendPort}/api/export?sessions=${session.sessionId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      const bundle = await res.text();
      const safeTitle = (session.title || 'chat').replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 40) || 'chat';
      await window.cascade?.saveJson?.(`cascade-${safeTitle}.json`, bundle);
    } catch { /* backend unavailable */ }
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
          <>
            <button
              onClick={handleExport}
              title="Export this chat as a JSON bundle"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', padding: 2, borderRadius: 3,
                display: 'flex', alignItems: 'center',
                transition: 'color var(--dur) var(--ease)',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--accent)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
            >
              <Download size={10} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onReviewChanges(); }}
              title="Review file changes (diffs) from this session"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', padding: 2, borderRadius: 3,
                display: 'flex', alignItems: 'center',
                transition: 'color var(--dur) var(--ease)',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--accent)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
            >
              <GitCompareArrows size={10} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onRollback(); }}
              title="Roll back file changes from this session"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-dim)', padding: 2, borderRadius: 3,
                display: 'flex', alignItems: 'center',
                transition: 'color var(--dur) var(--ease)',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--warn)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
            >
              <RotateCcw size={10} />
            </button>
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
          </>
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
  const { sessions, activeSessionId, sessionId, authToken, backendPort, sessionSidebarCollapsed } = useAppSelector((s) => s.app);

  const currentActiveId = activeSessionId ?? sessionId;

  const handleSelect = async (session: RuntimeSession) => {
    // Picking a session tucks the list away so it stops taking real estate.
    dispatch(setSessionSidebarCollapsed(true));
    if (session.sessionId === currentActiveId) return;
    if (currentActiveId && socket) socket.emit('leave:session', { sessionId: currentActiveId });
    if (socket) socket.emit('join:session', { sessionId: session.sessionId });
    dispatch(setActiveSessionId(session.sessionId));
    // Load the stored transcript so the Chat/Code panels show the session's
    // history and the next send continues it (instead of starting fresh).
    const messages = await fetchSessionTranscript(backendPort, authToken, session.sessionId);
    if (messages) dispatch(loadTranscript({ sessionId: session.sessionId, messages }));
  };

  const handleDelete = (sessionId: string) => {
    dispatch(removeSession(sessionId));
  };

  // Rollback: confirm first, then POST; the result note shows briefly below the list.
  const [rollbackTarget, setRollbackTarget] = useState<RuntimeSession | null>(null);
  const [rollbackNote, setRollbackNote] = useState('');

  const doRollback = async (session: RuntimeSession) => {
    setRollbackTarget(null);
    try {
      const res = await fetch(`http://localhost:${backendPort}/api/sessions/${session.sessionId}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const body = (await res.json()) as { restored?: number; message?: string };
      setRollbackNote(body.message ?? `Restored ${body.restored ?? 0} file${body.restored === 1 ? '' : 's'}.`);
    } catch {
      setRollbackNote('Rollback failed — backend unavailable.');
    }
    setTimeout(() => setRollbackNote(''), 5000);
  };

  const sorted = [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const railBtnStyle: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 4, borderRadius: 5,
  };

  // Collapsed: a slim rail that keeps the list reachable without the width.
  if (sessionSidebarCollapsed) {
    return (
      <aside style={{
        width: 36, background: 'var(--bg-surface)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8, gap: 6, flexShrink: 0,
      }}>
        <button title="Show sessions" onClick={() => dispatch(toggleSessionSidebar())} style={railBtnStyle}>
          <PanelLeftOpen size={15} />
        </button>
        <span title={`${sorted.length} sessions`} style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{sorted.length}</span>
      </aside>
    );
  }

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
        padding: '10px 12px 8px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '2px',
          color: 'var(--text-dim)', fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase', flex: 1,
        }}>
          CASCADE
        </span>
        <span style={{
          fontSize: 9, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono)',
        }}>
          {sorted.length}
        </span>
        <button title="Continue elsewhere — hand off to / from the web" onClick={() => dispatch(setShowContinue(true))} style={railBtnStyle}>
          <MonitorSmartphone size={13} />
        </button>
        <button title="Hide sessions" onClick={() => dispatch(toggleSessionSidebar())} style={railBtnStyle}>
          <PanelLeftClose size={13} />
        </button>
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 2, paddingBottom: 8 }}>
        {sorted.length === 0 ? (
          <div style={{
            padding: '32px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center',
            textAlign: 'center', animation: 'fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: '16px', marginBottom: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(135deg, rgba(var(--accent-rgb), 0.1), rgba(var(--accent-rgb), 0.02))',
              border: '1px solid rgba(var(--accent-rgb), 0.15)', color: 'var(--accent)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.02)',
            }}>
              <MessageSquare size={22} style={{ filter: 'drop-shadow(0 1px 2px rgba(var(--accent-rgb), 0.2))' }} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6, letterSpacing: '-0.2px' }}>No Sessions</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>Run a task in Mission Control to begin orchestration.</div>
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
              onRollback={() => setRollbackTarget(s)}
              onReviewChanges={() => dispatch(setChangesSessionId(s.sessionId))}
            />
          ))
        )}
      </div>

      {rollbackNote && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', fontSize: 10.5, color: 'var(--text-muted)' }}>
          {rollbackNote}
        </div>
      )}

      {rollbackTarget && (
        <PromptDialog
          title={`Roll back file changes from "${rollbackTarget.title || 'Untitled session'}"? Files return to their pre-run state.`}
          confirmOnly
          confirmLabel="Roll back"
          onSubmit={() => { void doRollback(rollbackTarget); }}
          onCancel={() => setRollbackTarget(null)}
        />
      )}
    </aside>
  );
}
