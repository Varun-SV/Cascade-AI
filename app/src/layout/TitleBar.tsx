import { useAppSelector } from '../store/index.js';

export function TitleBar() {
  const isMac = (window.cascade?.platform ?? 'darwin') === 'darwin';
  const connected = useAppSelector((s) => s.app.connected);

  return (
    <div
      style={{
        height: 38,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingLeft: isMac ? 78 : 12,
        paddingRight: isMac ? 12 : 138,
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
        userSelect: 'none',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <div style={{
        width: 20, height: 20, borderRadius: 5,
        background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, color: '#fff',
        boxShadow: '0 0 0 1px var(--accent-soft)',
        flexShrink: 0,
      }}>◈</div>

      <span style={{
        fontSize: 12, fontWeight: 600, letterSpacing: '-0.1px', color: 'var(--text)',
      }}>
        Cascade AI
      </span>

      <span
        title={connected ? 'Connected' : 'Offline'}
        style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: connected ? 'var(--success)' : 'var(--text-dim)',
          boxShadow: connected ? '0 0 6px var(--success)' : 'none',
          marginLeft: 1,
        }}
      />

      <div style={{ flex: 1 }} />
    </div>
  );
}
