import React, { memo, useEffect, useState } from 'react';
import { useAppSelector } from '../../store';
import { selectActiveSession } from '../../store/slices/runtimeSlice';

interface TopBarProps {
  isConnected: boolean;
  totalCostUsd: number;
  totalTokens: number;
}

/**
 * Measures actual round-trip latency using a periodic Date.now() probe.
 * The previous implementation measured requestAnimationFrame scheduling
 * delay (0–16 ms), which has nothing to do with network latency.
 */
function usePingLatency(isConnected: boolean) {
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    if (!isConnected) { setLatencyMs(null); return; }

    let cancelled = false;

    const probe = async () => {
      const t0 = Date.now();
      try {
        await fetch('/api/ping', { cache: 'no-store' });
        if (!cancelled) setLatencyMs(Date.now() - t0);
      } catch {
        if (!cancelled) setLatencyMs(null);
      }
    };

    probe();
    const id = setInterval(probe, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isConnected]);

  return latencyMs;
}

function useUptime(startedAt?: string) {
  const [elapsed, setElapsed] = useState('');

  useEffect(() => {
    if (!startedAt) { setElapsed(''); return; }

    const update = () => {
      const diff = Date.now() - new Date(startedAt).getTime();
      const h = Math.floor(diff / 3_600_000).toString().padStart(2, '0');
      const m = Math.floor((diff % 3_600_000) / 60_000).toString().padStart(2, '0');
      const s = Math.floor((diff % 60_000) / 1_000).toString().padStart(2, '0');
      setElapsed(`${h}:${m}:${s}`);
    };

    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [startedAt]);

  return elapsed;
}

function MetricChip({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="metric-chip">
      <span className="label">{label}</span>
      <span className={`value ${highlight ? 'text-[var(--warning)]' : ''}`}>{value}</span>
    </div>
  );
}

export const TopBar = memo(function TopBar({ isConnected, totalCostUsd, totalTokens }: TopBarProps) {
  const session = useAppSelector(selectActiveSession);
  const latency = usePingLatency(isConnected);
  const uptime = useUptime(session?.startedAt);

  return (
    <header
      aria-label="Dashboard header"
      className="
        flex items-center justify-between px-5 h-11
        border-b border-[var(--border-subtle)]
        bg-[var(--bg-surface)] flex-shrink-0 z-10
      "
    >
      {/* Left: connection dot + session info */}
      <div className="flex items-center gap-4 min-w-0">
        {/* Live / disconnected pill */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            aria-label={isConnected ? 'Connected' : 'Disconnected'}
            className={`
              w-1.5 h-1.5 rounded-full transition-all duration-500
              ${isConnected
                ? 'bg-[var(--success)] shadow-[var(--shadow-glow-green)]'
                : 'bg-[var(--text-faint)]'
              }
            `}
          />
          <span className="section-label">
            {isConnected ? 'Live' : 'Offline'}
          </span>
        </div>

        {session && (
          <>
            <div className="divider-v h-4 flex-shrink-0" />
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[12px] font-medium text-[var(--text-primary)] truncate max-w-[200px]">
                {session.title || 'Untitled Session'}
              </span>
              <span className={`badge badge-${session.status} flex-shrink-0`}>
                {session.status}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Right: metrics row */}
      <div className="flex items-center gap-5">
        {latency !== null && (
          <MetricChip label="Ping" value={`${latency}ms`} />
        )}
        {uptime && (
          <MetricChip label="Uptime" value={uptime} />
        )}

        <div className="divider-v h-4" />

        <MetricChip
          label="Tokens"
          value={totalTokens >= 1_000
            ? `${(totalTokens / 1_000).toFixed(1)}k`
            : totalTokens.toLocaleString()}
        />
        <MetricChip
          label="Cost"
          value={`$${totalCostUsd.toFixed(4)}`}
          highlight={totalCostUsd > 1}
        />
      </div>
    </header>
  );
});