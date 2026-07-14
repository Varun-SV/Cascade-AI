import { useEffect, useState } from 'react';
import { fetchTierMix } from '../lib/api.js';

// Tier accent colors match the run-explorer (T1 green / T2 amber / T3 violet).
const TIER_COLOR: Record<string, string> = {
  T1: '#4ade80',
  T2: '#f0b429',
  T3: '#c084fc',
};

interface Props {
  /** Changing this re-fetches the mix (e.g. after a run completes). */
  refreshSignal: unknown;
}

/** Today's tier distribution — how Cascade Auto split the day's runs across
 *  T1/T2/T3, as a single stacked bar with a small legend. */
export default function TierMix({ refreshSignal }: Props) {
  const [mix, setMix] = useState<Array<{ tier: string; count: number }>>([]);

  useEffect(() => {
    fetchTierMix().then((r) => setMix(r.mix)).catch(() => setMix([]));
  }, [refreshSignal]);

  const total = mix.reduce((sum, m) => sum + m.count, 0);
  if (total === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 px-1 py-2 text-[11px] text-ink-400">
      <div className="flex items-center justify-between">
        <span>Tier mix · today</span>
        <span className="tabular-nums">{total} run{total === 1 ? '' : 's'}</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-white/10">
        {mix.map((m) => (
          <div
            key={m.tier}
            title={`${m.tier}: ${m.count}`}
            style={{ width: `${(m.count / total) * 100}%`, backgroundColor: TIER_COLOR[m.tier] ?? '#94a3b8' }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {mix.map((m) => (
          <span key={m.tier} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_COLOR[m.tier] ?? '#94a3b8' }} />
            <span className="font-mono">{m.tier}</span>
            <span className="tabular-nums text-ink-500">{Math.round((m.count / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
