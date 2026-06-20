import { useAppSelector } from '../store/index.js';

export function ReconnectBanner() {
  const reconnecting = useAppSelector((s) => s.app.reconnecting);
  if (!reconnecting) return null;

  return (
    <div style={{
      background: 'rgba(245,166,35,0.15)',
      borderBottom: '1px solid rgba(245,166,35,0.4)',
      color: '#f5a623',
      fontSize: 11,
      padding: '5px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexShrink: 0,
    }}>
      <span style={{
        display: 'inline-block',
        width: 8, height: 8, borderRadius: '50%',
        background: '#f5a623',
        animation: 'pulse 1.2s ease-in-out infinite',
      }} />
      Reconnecting to Cascade backend…
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}
