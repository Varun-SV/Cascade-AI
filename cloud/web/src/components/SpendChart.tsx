import { useState } from 'react';
import type { SpendReport } from '../lib/api.js';

type Slot = SpendReport['series'][number];
type Bucket = SpendReport['bucket'];

export function fmtUsd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/** The smallest 1, 2, 2.5 or 5 × 10ⁿ at or above `v`, so axis ticks read cleanly. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v * (1 - 1e-9)) return m * p;
  return 10 * p;
}

// Keys are local calendar values, so they are formatted as UTC to stay put.
const dateOf = (key: string) => {
  const [y, m, d] = key.slice(0, 10).split('-').map(Number) as [number, number, number?];
  return new Date(Date.UTC(y, m - 1, d ?? 1));
};
const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' });

/** Short label for the x axis. */
export function slotLabel(key: string, bucket: Bucket): string {
  if (bucket === 'hour') return `${key.slice(11, 13)}:00`;
  if (bucket === 'month') return fmt({ month: 'short', year: '2-digit' }).format(dateOf(key));
  return fmt({ month: 'short', day: 'numeric' }).format(dateOf(key));
}

/** Full label for the tooltip and for screen readers. */
export function slotTitle(key: string, bucket: Bucket): string {
  if (bucket === 'hour') {
    const h = Number(key.slice(11, 13));
    return `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;
  }
  if (bucket === 'month') return fmt({ month: 'long', year: 'numeric' }).format(dateOf(key));
  return fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(dateOf(key));
}

/**
 * The slots that carry an x-axis label: every day of a week, otherwise about
 * five and always the last. The value says whether a label stays on a narrow
 * screen, where only the first, middle and last do.
 */
export function axisLabels(n: number, bucket: Bucket): Map<number, boolean> {
  const step = n <= 7 ? 1 : bucket === 'hour' ? 6 : Math.ceil(n / 5);
  const picked: number[] = [];
  // A label too close to the last one would collide with it.
  for (let i = 0; i < n; i += step) if (i === 0 || n - 1 - i >= step / 2) picked.push(i);
  if (n > 0 && picked[picked.length - 1] !== n - 1) picked.push(n - 1);
  const mid = picked[Math.floor(picked.length / 2)];
  return new Map(picked.map((i) => [i, i === 0 || i === n - 1 || i === mid]));
}

const runs = (n: number) => `${n} run${n === 1 ? '' : 's'}`;
export const slotSummary = (s: Slot, bucket: Bucket) =>
  `${slotTitle(s.key, bucket)}: ${fmtUsd(s.spentUsd)} spent, ${fmtUsd(s.savedUsd)} saved, ${runs(s.runs)}`;

const PLOT_HEIGHT = 168;

/**
 * Stacked columns: what was spent, and above it what delegation saved, so the
 * whole column is what running everything on T1 would have cost. One scale,
 * one axis. Hover or arrow keys show a slot's figures; the report's table view
 * holds the same numbers without either.
 */
export default function SpendChart({ series, bucket }: { series: Slot[]; bucket: Bucket }) {
  const [active, setActive] = useState<number | null>(null);
  const top = niceCeil(Math.max(0, ...series.map((s) => s.spentUsd + s.savedUsd)));
  const ticks = top > 0 ? [top, top / 2, 0] : [0];
  const labels = axisLabels(series.length, bucket);
  const pct = (v: number) => (top > 0 ? (v / top) * 100 : 0);
  const n = series.length;
  const shown = active !== null ? series[active] : undefined;

  function onKey(e: React.KeyboardEvent) {
    const last = n - 1;
    const cur = active ?? last;
    const next = e.key === 'ArrowLeft' ? Math.max(0, cur - 1)
      : e.key === 'ArrowRight' ? Math.min(last, cur + 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  }

  return (
    <div className="flex gap-2">
      {/* Y axis: three clean ticks, recessive. */}
      <div className="relative w-12 shrink-0 text-right text-[11px] tabular-nums text-ink-500" style={{ height: PLOT_HEIGHT }} aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - pct(t)}%` }}>{fmtUsd(t)}</span>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <div
          role="group"
          tabIndex={0}
          aria-label={`Spent and saved by ${bucket}. Use the arrow keys to read each ${bucket}.`}
          onKeyDown={onKey}
          onFocus={() => setActive((a) => a ?? n - 1)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="relative flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50"
          style={{ height: PLOT_HEIGHT }}
        >
          {ticks.map((t) => (
            <span key={t} aria-hidden className="pointer-events-none absolute inset-x-0 h-px" style={{ top: `${100 - pct(t)}%`, background: 'var(--chart-grid)' }} />
          ))}
          {series.map((s, i) => {
            const spentH = pct(s.spentUsd);
            const savedH = pct(s.savedUsd);
            return (
              // The whole slot is the hit target, not just the painted column.
              <div
                key={s.key}
                data-testid="spend-slot"
                onPointerEnter={() => setActive(i)}
                className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              >
                <div
                  className={`flex h-full w-[min(24px,70%)] flex-col justify-end gap-[2px] transition-opacity ${active !== null && active !== i ? 'opacity-60' : ''}`}
                >
                  {savedH > 0 && (
                    <span className="block shrink-0 rounded-t-[4px]" style={{ height: `max(2px, ${savedH}%)`, background: 'var(--chart-saved)' }} />
                  )}
                  {spentH > 0 && (
                    <span
                      className={`block shrink-0 ${savedH > 0 ? '' : 'rounded-t-[4px]'}`}
                      style={{ height: `max(2px, ${spentH}%)`, background: 'var(--chart-spent)' }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {/* X axis: selective labels, inside the chart's own height. */}
        <div className="relative mt-1.5 h-4 text-[11px] text-ink-500" aria-hidden>
          {series.map((s, i) => labels.has(i) && (
            <span
              key={s.key}
              className={`absolute whitespace-nowrap ${labels.get(i) ? '' : 'hidden sm:inline'}`}
              style={{
                left: `${((i + 0.5) / n) * 100}%`,
                transform: i === 0 && n > 7 ? 'none' : i === n - 1 && n > 7 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {slotLabel(s.key, bucket)}
            </span>
          ))}
        </div>
        {shown && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 flex min-w-[9.5rem] flex-col gap-1 rounded-[10px] bg-card px-3 py-2 text-[12px] text-ink-300"
            style={{
              // An edge of its own: over the card, in the dark theme, a shadow alone does not show one.
              boxShadow: 'inset 0 0 0 1px rgb(var(--c-elev) / 0.14), var(--glass-shadow-strong)',
              left: `${((active! + 0.5) / n) * 100}%`,
              transform: active! < n * 0.25 ? 'translateX(0)' : active! > n * 0.75 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            <span className="sr-only">{slotSummary(shown, bucket)}</span>
            <span aria-hidden className="text-ink-400">{slotTitle(shown.key, bucket)}</span>
            <span aria-hidden className="flex items-center gap-2">
              <span className="h-0.5 w-3 rounded-full" style={{ background: 'var(--chart-spent)' }} />
              <b className="font-semibold text-ink-50">{fmtUsd(shown.spentUsd)}</b> spent
            </span>
            <span aria-hidden className="flex items-center gap-2">
              <span className="h-0.5 w-3 rounded-full" style={{ background: 'var(--chart-saved)' }} />
              <b className="font-semibold text-ink-50">{fmtUsd(shown.savedUsd)}</b> saved
            </span>
            <span aria-hidden className="text-ink-500">{runs(shown.runs)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
