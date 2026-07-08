import { useEffect } from 'react';
import { useAppDispatch, useAppSelector, toggleTerminal, setBottomTab, clearCommsEvents } from '../store/index.js';
import { TerminalPanel } from '../components/TerminalPanel.js';
import { CommsFeed } from '../components/CommsFeed.js';

export function BottomPanel() {
  const dispatch = useAppDispatch();
  const visible = useAppSelector((s) => s.app.terminalVisible);
  const tab = useAppSelector((s) => s.app.bottomTab);
  const commsCount = useAppSelector((s) => s.app.commsEvents.length);
  const workspacePath = useAppSelector((s) => s.app.workspacePath);
  const terminalCwd = useAppSelector((s) => s.app.terminalCwd);
  const cwd = terminalCwd || workspacePath;

  // Ctrl+` to toggle terminal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        dispatch(toggleTerminal());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  if (!visible) return null;

  const tabBtn = (id: 'terminal' | 'comms', label: string, badge?: number): React.ReactNode => (
    <button
      onClick={() => dispatch(setBottomTab(id))}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
        fontSize: 10.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
        color: tab === id ? 'var(--text)' : 'var(--text-dim)',
        borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`,
        height: '100%', display: 'flex', alignItems: 'center', gap: 5,
      }}
    >
      {label}
      {badge != null && badge > 0 && (
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 8, padding: '0 5px', letterSpacing: 0 }}>{badge}</span>
      )}
    </button>
  );

  return (
    <div style={{
      height: 260,
      background: 'var(--bg-surface)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      <div style={{
        height: 30, padding: '0 12px',
        display: 'flex', alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        gap: 14,
      }}>
        {tabBtn('terminal', 'Terminal')}
        {tabBtn('comms', 'Comms', commsCount)}
        {tab === 'terminal' && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cwd || '~'}</span>
        )}
        <div style={{ flex: 1 }} />
        {tab === 'comms' && commsCount > 0 && (
          <button
            onClick={() => dispatch(clearCommsEvents())}
            title="Clear the comms feed"
            style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 10.5, padding: '2px 6px' }}
          >clear</button>
        )}
        <button
          onClick={() => dispatch(toggleTerminal())}
          title="Close panel"
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '2px 6px', borderRadius: 4, transition: 'color var(--dur), background var(--dur)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >×</button>
      </div>
      {/* Keep the terminal mounted while the Comms tab is showing — unmounting
          TerminalPanel kills the PTY session, which is the panel's whole state. */}
      <div style={{ flex: 1, overflow: 'hidden', display: tab === 'terminal' ? 'block' : 'none' }}>
        <TerminalPanel cwd={cwd || undefined} />
      </div>
      {tab === 'comms' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <CommsFeed />
        </div>
      )}
    </div>
  );
}
