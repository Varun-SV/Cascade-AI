import { useEffect } from 'react';
import { useAppDispatch, useAppSelector, toggleTerminal } from '../store/index.js';
import { TerminalPanel } from '../components/TerminalPanel.js';

export function BottomPanel() {
  const dispatch = useAppDispatch();
  const visible = useAppSelector((s) => s.app.terminalVisible);
  const workspacePath = useAppSelector((s) => s.app.workspacePath);

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
        gap: 10,
      }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text)', letterSpacing: 1, textTransform: 'uppercase' }}>Terminal</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspacePath || '~'}</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => dispatch(toggleTerminal())}
          title="Close terminal"
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '2px 6px', borderRadius: 4, transition: 'color var(--dur), background var(--dur)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >×</button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <TerminalPanel cwd={workspacePath || undefined} />
      </div>
    </div>
  );
}
