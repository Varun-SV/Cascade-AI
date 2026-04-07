import React, { memo, useEffect, useState } from 'react';
import { useAppSelector } from '../../store';
import { selectActiveSession } from '../../store/slices/runtimeSlice';

interface TopBarProps {
  isConnected: boolean;
  totalCostUsd: number;
  totalTokens: number;
}

function useLiveLatency(isConnected: boolean) {
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  useEffect(() => {
    if (!isConnected) { setLatencyMs(null); return; }
    // Approximate: measure time from last re-render cycle
    const t = Date.now();
    const raf = requestAnimationFrame(() => setLatencyMs(Date.now() - t));
    return () => cancelAnimationFrame(raf);
  }, [isConnected]);
  return latencyMs;
}

function useUptime(startedAt?: string) {
  const [elapsed, setElapsed] = useState('');
  useEffect(() => {
    if (!startedAt) { setElapsed(''); return; }
    const update = () => {
      const diff = Date.now() - new Date(startedAt).getTime();
      const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
      const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
      const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
      setElapsed(`${h}:${m}:${s}`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return elapsed;
}

export const TopBar = memo(function TopBar({ isConnected, totalCostUsd, totalTokens }: TopBarProps) {
  const session = useAppSelector(selectActiveSession);
  const latency = useLiveLatency(isConnected);
  const uptime = useUptime(session?.startedAt);

  return (
    <header
      aria-label="Dashboard header"
      className="flex items-center justify-between px-6 h-12 border-b border-[var(--border-subtle)]
                 bg-[var(--bg-surface)] flex-shrink-0 z-10"
    >
      {/* Left: connection status + session name */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span
            aria-label={isConnected ? 'Connected' : 'Disconnected'}
            className={`w-2 h-2 rounded-full transition-all duration-500 ${
              isConnected
                ? 'bg-[var(--success)] shadow-[var(--shadow-glow-green)] animate-pulse'
                : 'bg-[var(--text-faint)]'
            }`}
          />
          <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-medium">
            {isConnected ? 'Live' : 'Disconnected'}
          </span>
        </div>

        {session && (
          <>
            <div className="w-px h-4 bg-[var(--border-subtle)]" />
            <span className="text-sm font-medium text-[var(--text-primary)] truncate max-w-[240px]">
              {session.title || 'Untitled Session'}
            </span>
            <span className={`badge ${
              session.status === 'ACTIVE' ? 'badge-ACTIVE'
              : session.status === 'COMPLETED' ? 'badge-COMPLETED'
              : 'badge-FAILED'
            }`}>
              {session.status}
            </span>
          </>
        )}
      </div>

      {/* Right: metrics */}
      <div className="flex items-center gap-5 font-mono text-[11px]">
        {latency !== null && (
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-faint)] uppercase tracking-wider">Latency</span>
            <span className="text-[var(--t3-color)] font-semibold">{latency}ms</span>
          </div>
        )}

        {uptime && (
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-faint)] uppercase tracking-wider">Uptime</span>
            <span className="text-[var(--text-muted)]">{uptime}</span>
          </div>
        )}

        <div className="w-px h-4 bg-[var(--border-subtle)]" />

        <div className="flex items-center gap-1.5">
          <span className="text-[var(--text-faint)] uppercase tracking-wider">Tokens</span>
          <span className="text-[var(--text-primary)]">{totalTokens.toLocaleString()}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[var(--text-faint)] uppercase tracking-wider">Cost</span>
          <span className={`font-semibold ${totalCostUsd > 1 ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]'}`}>
            ${totalCostUsd.toFixed(4)}
          </span>
        </div>
      </div>
    </header>
  );
});
