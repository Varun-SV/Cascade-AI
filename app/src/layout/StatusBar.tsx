import { Wifi, WifiOff, Terminal } from 'lucide-react';
import { useAppDispatch, useAppSelector, toggleTerminal } from '../store/index.js';

export function StatusBar() {
  const dispatch = useAppDispatch();
  const { connected, totalCostUsd, totalTokens, activeModel } = useAppSelector((s) => s.app);

  const fmtCost = (c: number) => c < 0.001 ? '<$0.001' : `$${c.toFixed(4)}`;
  const fmtTokens = (t: number) => t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);

  return (
    <footer style={{
      height: 22,
      background: connected ? 'var(--accent-dim)' : 'var(--bg-raised)',
      display: 'flex', alignItems: 'center',
      padding: '0 8px', gap: 12,
      fontSize: 11, color: connected ? 'var(--accent)' : 'var(--text-muted)',
      borderTop: '1px solid var(--border)',
      flexShrink: 0,
      userSelect: 'none',
    }}>
      {/* Connection */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {connected
          ? <Wifi size={11} />
          : <WifiOff size={11} />}
        {connected ? 'connected' : 'offline'}
      </span>

      <Divider />

      {/* Models */}
      <span>T1: {activeModel.t1}</span>
      <span>T2: {activeModel.t2}</span>
      <span>T3: {activeModel.t3}</span>

      <Divider />

      {/* Cost & tokens */}
      <span>{fmtTokens(totalTokens)} tokens</span>
      <span style={{ color: totalCostUsd > 1 ? 'var(--yellow)' : 'inherit' }}>
        {fmtCost(totalCostUsd)}
      </span>

      <div style={{ flex: 1 }} />

      {/* Terminal toggle */}
      <button
        onClick={() => dispatch(toggleTerminal())}
        title="Toggle terminal (Ctrl+`)"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <Terminal size={11} /> terminal
      </button>
    </footer>
  );
}

function Divider() {
  return <span style={{ opacity: 0.3 }}>|</span>;
}
