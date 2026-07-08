import { Wifi, WifiOff, Terminal, Coins, Square, Radio, HelpCircle } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { useAppDispatch, useAppSelector, toggleTerminal, openBottomTab, setShowWhyPanel } from '../store/index.js';

export function StatusBar({ socket }: { socket?: Socket | null }) {
  const dispatch = useAppDispatch();
  const { connected, reconnecting, backendError, totalCostUsd, totalTokens, activeModel } = useAppSelector((s) => s.app);
  const { runActive, runSessionId, activeSessionId, sessionId, showWhyPanel } = useAppSelector((s) => s.app);

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

      {/* Persistent run indicator + Stop — the StatusBar never unmounts, so a
          run stays stoppable from ANY view (the in-view Stop buttons die with
          their view when the user switches sections mid-run). */}
      {runActive && (
        <>
          <button
            onClick={() => socket?.emit('session:halt', { sessionId: runSessionId ?? activeSessionId ?? sessionId ?? undefined })}
            title="Stop the running task"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'color-mix(in srgb, #ff4444 12%, transparent)',
              border: '1px solid color-mix(in srgb, #ff4444 40%, transparent)',
              borderRadius: 4, padding: '1px 8px', cursor: 'pointer',
              color: '#ff6b6b', fontWeight: 700, fontSize: 10.5,
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#ff4444',
              animation: 'pulse 1.2s ease-in-out infinite',
            }} />
            <Square size={8} fill="currentColor" /> STOP
          </button>
          <Divider />
        </>
      )}

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

      {/* Why? — the run inspector for the current session's last run */}
      <button
        onClick={() => dispatch(setShowWhyPanel(!showWhyPanel))}
        title="Why? — explain how the last run was routed"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: showWhyPanel ? 'var(--accent)' : 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4, transition: 'color var(--dur) var(--ease)' }}
        onMouseEnter={(e) => { if (!showWhyPanel) (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; }}
        onMouseLeave={(e) => { if (!showWhyPanel) (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
      >
        <HelpCircle size={10} /> why?
      </button>

      {/* Comms feed — agent-to-agent chatter in the bottom panel */}
      <button
        onClick={() => dispatch(openBottomTab('comms'))}
        title="Open the agent comms feed"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4, transition: 'color var(--dur) var(--ease)' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
      >
        <Radio size={10} /> comms
      </button>

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
