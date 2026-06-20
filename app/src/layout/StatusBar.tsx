import { Wifi, WifiOff, Terminal, Coins } from 'lucide-react';
import { useAppDispatch, useAppSelector, toggleTerminal } from '../store/index.js';

export function StatusBar() {
  const dispatch = useAppDispatch();
  const { connected, totalCostUsd, totalTokens, activeModel } = useAppSelector((s) => s.app);

  const fmtCost = (c: number) => c < 0.001 ? '<$0.001' : `$${c.toFixed(4)}`;
  const fmtTokens = (t: number) => t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

  return (
    <footer style={{
      height: 24,
      background: 'var(--bg-surface)',
      display: 'flex', alignItems: 'center',
      padding: '0 10px', gap: 14,
      fontSize: 11, color: 'var(--text-muted)',
      borderTop: '1px solid var(--border)',
      flexShrink: 0,
      userSelect: 'none',
    }}>
      {/* Connection */}
      <span style={{
        display: 'flex', alignItems: 'center', gap: 5,
        color: connected ? 'var(--success)' : 'var(--text-dim)',
        fontWeight: 600,
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: connected ? 'var(--success)' : 'var(--text-dim)',
          boxShadow: connected ? '0 0 6px var(--success)' : 'none',
        }} />
        {connected ? <Wifi size={11} /> : <WifiOff size={11} />}
        {connected ? 'connected' : 'offline'}
      </span>

      <Divider />

      {/* Models — tier-colored */}
      <TierChip tier="T1" color="var(--t1)" model={activeModel.t1} />
      <TierChip tier="T2" color="var(--t2)" model={activeModel.t2} />
      <TierChip tier="T3" color="var(--t3)" model={activeModel.t3} />

      <div style={{ flex: 1 }} />

      {/* Cost & tokens */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <Coins size={11} style={{ color: 'var(--text-dim)' }} />
        {fmtTokens(totalTokens)} tok
      </span>
      <span style={{
        color: totalCostUsd > 1 ? 'var(--warn)' : 'var(--text)',
        fontVariantNumeric: 'tabular-nums', fontWeight: 600,
      }}>
        {fmtCost(totalCostUsd)}
      </span>

      <Divider />

      {/* Terminal toggle */}
      <button
        onClick={() => dispatch(toggleTerminal())}
        title="Toggle terminal (Ctrl+`)"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, transition: 'color var(--dur) var(--ease)' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; }}
      >
        <Terminal size={11} /> terminal
      </button>
    </footer>
  );
}

function TierChip({ tier, color, model }: { tier: string; color: string; model: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
        color, padding: '1px 4px', borderRadius: 3,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}>{tier}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{model}</span>
    </span>
  );
}

function Divider() {
  return <span style={{ width: 1, height: 12, background: 'var(--border-strong)', opacity: 0.6 }} />;
}
