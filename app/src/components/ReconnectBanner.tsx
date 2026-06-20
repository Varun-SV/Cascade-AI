import { useAppSelector } from '../store/index.js';

export function ReconnectBanner() {
  const reconnecting = useAppSelector((s) => s.app.reconnecting);
  if (!reconnecting) return null;

  return (
    <div style={{
      background: 'var(--warn-soft)',
      borderBottom: '1px solid var(--warn)',
      color: 'var(--warn)',
      fontSize: 11,
      fontWeight: 600,
      padding: '6px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexShrink: 0,
    }}>
      <span style={{
        display: 'inline-block',
        width: 8, height: 8, borderRadius: '50%',
        background: 'var(--warn)',
        animation: 'pulse 1.2s ease-in-out infinite',
      }} />
      Reconnecting to Cascade backend…
    </div>
  );
}
