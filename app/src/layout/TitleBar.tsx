import { useAppSelector } from '../store/index.js';

/**
 * Custom draggable title strip that replaces the native OS title bar / menu.
 * The window is created frameless (titleBarStyle: 'hidden' / 'hiddenInset'),
 * so this bar provides the drag region and brand chrome. Native window controls
 * sit on top — traffic lights inset on macOS, themed min/max/close overlay on
 * Windows/Linux — so we reserve padding on the matching side.
 */
export function TitleBar() {
  const isMac = (window.cascade?.platform ?? 'darwin') === 'darwin';
  const connected = useAppSelector((s) => s.app.connected);

  return (
    <div
      // The whole bar is draggable; interactive children opt out via no-drag.
      style={{
        height: 40,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        // macOS: leave room for traffic lights on the left.
        // Windows/Linux: leave room for the window-controls overlay on the right.
        paddingLeft: isMac ? 78 : 12,
        paddingRight: isMac ? 12 : 138,
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
        userSelect: 'none',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* Brand mark */}
      <div style={{
        width: 22, height: 22, borderRadius: 6,
        background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 800, color: '#fff', letterSpacing: '-0.5px',
        boxShadow: '0 0 0 1px var(--accent-soft)',
      }}>C</div>

      <span style={{
        fontSize: 12.5, fontWeight: 700, letterSpacing: '-0.2px', color: 'var(--text)',
      }}>
        Cascade AI
      </span>

      {/* Connection dot */}
      <span
        title={connected ? 'Connected' : 'Offline'}
        style={{
          width: 6, height: 6, borderRadius: '50%',
          background: connected ? 'var(--success)' : 'var(--text-dim)',
          boxShadow: connected ? '0 0 6px var(--success)' : 'none',
          marginLeft: 2,
        }}
      />

      <div style={{ flex: 1 }} />
    </div>
  );
}
