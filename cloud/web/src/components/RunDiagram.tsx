import { useEffect, useState } from 'react';
import { TIER_COLORS } from '../lib/brand.js';

/**
 * A compact orchestration run, played once in the hero.
 *
 * The old hero asserted "up to 90% cheaper" and left the reader to imagine how.
 * Watching one prompt become a plan, fan out to parallel workers, and come back
 * as an answer explains the product in about four seconds — which is roughly
 * four seconds less than the paragraph underneath it takes to read.
 *
 * It plays ONCE and freezes on the finished state. A looping animation on a
 * landing page competes with the copy for attention forever; this one makes its
 * point and then behaves like a diagram.
 */

interface Step {
  /** ms after mount when this step lights up. */
  at: number;
  tier: 0 | 1 | 2;
  label: string;
  /** Grid column, 0-2 — workers sit side by side to show real parallelism. */
  col?: 0 | 1 | 2;
}

const STEPS: readonly Step[] = [
  { at: 250, tier: 0, label: 'Plan the report' },
  { at: 900, tier: 1, label: 'Research' , col: 0 },
  { at: 1050, tier: 1, label: 'Pricing', col: 1 },
  { at: 1200, tier: 1, label: 'Draft', col: 2 },
  { at: 2000, tier: 2, label: 'gpt-5-mini', col: 0 },
  { at: 2300, tier: 2, label: 'haiku', col: 1 },
  { at: 2750, tier: 2, label: 'sonnet', col: 2 },
];

export default function RunDiagram({ reduced }: { reduced: boolean }) {
  // When motion is reduced we render the finished state immediately — the
  // information matters, the animation is the optional part.
  const [elapsed, setElapsed] = useState(reduced ? Infinity : 0);

  useEffect(() => {
    // Turning reduced motion ON mid-play must JUMP to the end, not stop where
    // it happens to be. Cancelling the frame loop alone left a half-lit diagram
    // with no cost row — the animation removed and the information with it,
    // which is the opposite of what the preference asks for.
    if (reduced) { setElapsed(Infinity); return; }

    // Re-enabling it replays from the start rather than resuming mid-way, so
    // the sequence still reads as a sequence.
    setElapsed(0);
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      const ms = performance.now() - started;
      setElapsed(ms);
      if (ms < 3400) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);

  const on = (step: Step) => elapsed >= step.at;
  const tiers = [0, 1, 2] as const;

  return (
    <div
      className="glass mx-auto w-full max-w-lg rounded-2xl p-4 sm:p-5"
      role="img"
      aria-label="A prompt is planned by Tier 1, split into three sections by Tier 2, and generated in parallel by three Tier 3 workers on different models."
    >
      <div className="mb-3 flex items-center gap-2 text-[11px] font-medium text-ink-400">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: TIER_COLORS[0] }} />
        “Write a competitor report”
      </div>

      <div className="space-y-2.5">
        {tiers.map((tier) => {
          const steps = STEPS.filter((s) => s.tier === tier);
          const color = TIER_COLORS[tier];
          return (
            <div key={tier} className="flex items-center gap-2.5">
              <span
                className="w-5 shrink-0 text-[10px] font-bold tabular-nums"
                style={{ color, opacity: steps.some(on) ? 1 : 0.3 }}
              >
                T{tier + 1}
              </span>
              <div className="grid flex-1 grid-cols-3 gap-1.5">
                {[0, 1, 2].map((col) => {
                  const step = steps.find((s) => (s.col ?? 0) === col)
                    // T1 has a single node; stretch it rather than leaving gaps.
                    ?? (tier === 0 && col === 0 ? steps[0] : undefined);
                  if (!step) return <span key={col} />;
                  const lit = on(step);
                  const span = tier === 0 ? 'col-span-3' : '';
                  return (
                    <div
                      key={col}
                      className={`${span} truncate rounded-lg border px-2 py-1.5 text-[11px] font-medium`}
                      style={{
                        borderColor: lit ? `${color}66` : 'rgb(var(--c-elev) / 0.10)',
                        background: lit ? `${color}14` : 'transparent',
                        color: lit ? 'rgb(var(--c-ink-100))' : 'rgb(var(--c-ink-500))',
                        transition: reduced ? undefined : 'all 320ms ease',
                      }}
                    >
                      {step.label}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="mt-3 flex items-center justify-between border-t border-elev/10 pt-2.5 text-[11px]"
        style={{ opacity: elapsed >= 3100 ? 1 : 0, transition: reduced ? undefined : 'opacity 400ms ease' }}
      >
        <span className="text-ink-400">3 workers · 2 in parallel</span>
        <span className="font-semibold" style={{ color: TIER_COLORS[2] }}>$0.04 · 89% saved</span>
      </div>
    </div>
  );
}
