import { Wifi, WifiOff, Terminal, Coins } from 'lucide-react';
import { useAppDispatch, useAppSelector, toggleTerminal } from '../store/index.js';

export function StatusBar() {
  const dispatch = useAppDispatch();
  const { connected, reconnecting, backendError, totalCostUsd, totalTokens, activeModel } = useAppSelector((s) => s.app);

  const fmtCost = (c: number) => c < 0.001 ? '<$0.001' : `$${c.toFixed(4)}`;
  const fmtTokens = (t: number) => t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

  // Tri-state connection: connected → reconnecting → offline. When the embedded
  // backend failed to start, offer a one-click retry that restarts it and lets
  // App.tsx's onBackendStatus listener reconnect the socket with the new port.
  const retry = () => { window.cascade?.restartBackend?.(); };

  return (
    <footer className="status-bar" style={{
      height: 22,
      background: 'var(--bg-surface)',
      display: 'flex', alignItems: 'center',
      padding: '0 10px', gap: 12,
      fontSize: 11, color: 'var(--text-muted)',
      borderTop: '1px solid var(--border)',
      flexShrink: 0,
      userSelect: 'none',
    }}>
      {/* Connection — tri-state with click-to-retry when offline */}
      {(() => {
        const state = connected ? 'connected' : reconnecting ? 'reconnecting' : 'offline';
        const color = state === 'connected' ? 'var(--success)' : state === 'reconnecting' ? 'var(--warn)' : 'var(--text-dim)';
        const label = state === 'connected' ? 'cascade' : state === 'reconnecting' ? 'reconnecting…' : 'offline · retry';
        const title = backendError ?? (state === 'connected' ? 'Connected to the Cascade backend' : 'Backend not connected — click to retry');
        return (
          <button
            onClick={state === 'connected' ? undefined : retry}
            title={title}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              color, fontWeight: 600, fontSize: 11,
              background: 'none', border: 'none', padding: 0,
              cursor: state === 'connected' ? 'default' : 'pointer',
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: color,
              boxShadow: state === 'connected' ? '0 0 5px var(--success)' : 'none',
            }} />
            {state === 'connected' ? <Wifi size={10} /> : <WifiOff size={10} />}
            {label}
          </button>
        );
      })()}

      <Divider />

      {/* Models — tier-colored */}
      <TierChip tier="T1" color="var(--t1)" model={activeModel.t1} />
      <TierChip tier="T2" color="var(--t2)" model={activeModel.t2} />
      <TierChip tier="T3" color="var(--t3)" model={activeModel.t3} />

      <div style={{ flex: 1 }} />

      {/* Cost & tokens */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Coins size={10} style={{ color: 'var(--text-dim)' }} />
        {fmtTokens(totalTokens)} tok
      </span>
      <span style={{
        color: totalCostUsd > 1 ? 'var(--warn)' : 'var(--text-muted)',
        fontVariantNumeric: 'tabular-nums', fontWeight: 600,
      }}>
        {fmtCost(totalCostUsd)}
      </span>

      <Divider />

      {/* Terminal toggle */}
      <button
        onClick={() => dispatch(toggleTerminal())}
        title="Toggle terminal (Ctrl+`)"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4, transition: 'color var(--dur) var(--ease)' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
      >
        <Terminal size={10} /> terminal
      </button>
    </footer>
  );
}

function TierChip({ tier, color, model }: { tier: string; color: string; model: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
        color, padding: '1px 4px', borderRadius: 3,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}>{tier}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{model}</span>
    </span>
  );
}

function Divider() {
  return <span style={{ width: 1, height: 10, background: 'var(--border-strong)', opacity: 0.5 }} />;
}
