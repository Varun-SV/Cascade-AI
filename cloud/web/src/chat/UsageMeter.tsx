import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { fetchUsage, type UsageInfo } from '../lib/api.js';

interface Props {
  /** Estimated tokens of the CURRENT conversation (from its messages). */
  contextTokens: number;
  /** The active model's context window, in tokens. */
  contextWindow: number;
  /** Total tokens the last run spent across all tiers (throughput, not context). */
  lastRunTokens?: number;
  /** Changing this re-fetches usage (e.g. after a run completes). */
  refreshSignal: unknown;
}

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Sidebar gauges: daily runs vs plan limit, and how full THIS conversation is
 * relative to the active model's real context window. The context figure is
 * derived from the loaded messages (not the last run's throughput), so it is
 * accurate and survives a refresh.
 */
export default function UsageMeter({ contextTokens, contextWindow, lastRunTokens, refreshSignal }: Props) {
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  useEffect(() => {
    fetchUsage().then(setUsage).catch(() => setUsage(null));
  }, [refreshSignal]);

  if (!usage) return null;

  const runPct = Math.min(100, Math.round((usage.dailyRuns / usage.dailyRunLimit) * 100));
  const atRunLimit = usage.dailyRuns >= usage.dailyRunLimit;

  const window = contextWindow > 0 ? contextWindow : 128_000;
  const ctxPct = Math.min(100, Math.round((contextTokens / window) * 100));
  const ctxFull = ctxPct >= 85;

  return (
    <div className="flex flex-col gap-2 px-1 py-2 text-[11px] text-ink-400">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span>Runs today</span>
          <span className={clsx('tabular-nums', atRunLimit && 'text-danger-500')}>
            {usage.dailyRuns} / {usage.dailyRunLimit}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-elev/10">
          <div className={clsx('h-full rounded-full', atRunLimit ? 'bg-danger-500' : 'bg-accent-500')} style={{ width: `${runPct}%` }} />
        </div>
        {atRunLimit && <p className="mt-1 text-danger-500">Daily limit reached — resets at midnight UTC.</p>}
      </div>

      {contextTokens > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span>Context</span>
            <span className={clsx('tabular-nums', ctxFull && 'text-warning-500')}>
              ~{compact(contextTokens)} / {compact(window)} tok
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-elev/10">
            <div className={clsx('h-full rounded-full', ctxFull ? 'bg-warning-500' : 'bg-ink-600')} style={{ width: `${ctxPct}%` }} />
          </div>
          {ctxFull && <p className="mt-1 text-warning-500">This chat is filling the model's window — start a new chat to keep replies sharp.</p>}
          {typeof lastRunTokens === 'number' && lastRunTokens > 0 && (
            <p className="mt-1 text-ink-500">Last run used ~{compact(lastRunTokens)} tok across all tiers.</p>
          )}
        </div>
      )}
    </div>
  );
}
