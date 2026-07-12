import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { fetchUsage, type UsageInfo } from '../lib/api.js';

// Soft context ceiling for the meter. Real limits are per-model; this is a
// visual "how full is this conversation" gauge, not an enforced cap.
const CONTEXT_SOFT_CAP = 100_000;

interface Props {
  lastTokens: number;
  /** Changing this re-fetches usage (e.g. after a run completes). */
  refreshSignal: unknown;
}

export default function UsageMeter({ lastTokens, refreshSignal }: Props) {
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  useEffect(() => {
    fetchUsage().then(setUsage).catch(() => setUsage(null));
  }, [refreshSignal]);

  if (!usage) return null;

  const runPct = Math.min(100, Math.round((usage.dailyRuns / usage.dailyRunLimit) * 100));
  const atRunLimit = usage.dailyRuns >= usage.dailyRunLimit;
  const ctxPct = Math.min(100, Math.round((lastTokens / CONTEXT_SOFT_CAP) * 100));
  const ctxFull = ctxPct >= 80;

  return (
    <div className="flex flex-col gap-2 px-1 py-2 text-[11px] text-ink-400">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span>Runs today</span>
          <span className={clsx('tabular-nums', atRunLimit && 'text-danger-500')}>
            {usage.dailyRuns} / {usage.dailyRunLimit}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-ink-800">
          <div className={clsx('h-full rounded-full', atRunLimit ? 'bg-danger-500' : 'bg-accent-500')} style={{ width: `${runPct}%` }} />
        </div>
        {atRunLimit && <p className="mt-1 text-danger-500">Daily limit reached — resets at midnight UTC.</p>}
      </div>

      {lastTokens > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span>Context</span>
            <span className={clsx('tabular-nums', ctxFull && 'text-warning-500')}>~{lastTokens.toLocaleString()} tok</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-ink-800">
            <div className={clsx('h-full rounded-full', ctxFull ? 'bg-warning-500' : 'bg-ink-600')} style={{ width: `${ctxPct}%` }} />
          </div>
          {ctxFull && <p className="mt-1 text-warning-500">Context is getting full — consider a new chat.</p>}
        </div>
      )}
    </div>
  );
}
