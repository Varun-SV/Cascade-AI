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
        height: 28, padding: '0 12px',
        display: 'flex', alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        gap: 8,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase' }}>Terminal</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{workspacePath || '~'}</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => dispatch(toggleTerminal())}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
        >×</button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <TerminalPanel cwd={workspacePath || undefined} />
      </div>
    </div>
  );
}
