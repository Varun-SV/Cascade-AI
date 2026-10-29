import { motion, useReducedMotionConfig } from 'framer-motion';
import type { PlanApproval } from './useChatSession.js';

/**
 * The plan as a tree that grows: T1 at the top, a branch to each section's
 * manager, and a short stem for each of that section's workers. Drawn from the
 * plan itself, so the shape on screen is the shape of the run.
 */
function PlanTree({ sections }: { sections: Array<{ title?: string; t3Subtasks?: unknown[] }> }) {
  // MotionConfig's reducedMotion stops transform and layout animations, not
  // pathLength, so the tree would keep drawing itself for someone who asked
  // for less motion (OS setting, or Settings → Reduce motion, which App passes
  // as reducedMotion="always"). Reduced: render it already grown.
  const still = useReducedMotionConfig() ?? false;
  const shown = sections.slice(0, 6);
  if (shown.length === 0) return null;
  const W = 100, rootY = 10, midY = 46, leafY = 78;
  const xs = shown.map((_, i) => (shown.length === 1 ? 50 : 8 + (i * 84) / (shown.length - 1)));
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
  return (
    <svg viewBox={`0 0 ${W} 86`} preserveAspectRatio="none" className="h-[86px] w-full overflow-visible" aria-hidden="true">
      {xs.map((x, i) => (
        <motion.path
          key={`b${i}`} d={curve(50, rootY, x, midY)} fill="none" stroke="rgb(var(--c-t2))" strokeOpacity={0.7} strokeWidth={1.4}
          vectorEffect="non-scaling-stroke" initial={still ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.55, delay: 0.1 + i * 0.12, ease: 'easeOut' }}
        />
      ))}
      {xs.map((x, i) => {
        const n = Math.min(5, Math.max(1, shown[i].t3Subtasks?.length ?? 1));
        return Array.from({ length: n }, (_, k) => {
          const lx = x + (n === 1 ? 0 : (k / (n - 1) - 0.5) * Math.min(12, 70 / shown.length));
          return (
            <motion.path
              key={`l${i}-${k}`} d={curve(x, midY, lx, leafY)} fill="none" stroke="rgb(var(--c-t3))" strokeOpacity={0.6} strokeWidth={1.2}
              vectorEffect="non-scaling-stroke" initial={still ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, delay: 0.55 + i * 0.12 + k * 0.05, ease: 'easeOut' }}
            />
          );
        });
      })}
      <motion.circle cx={50} cy={rootY} r={3.2} fill="rgb(var(--c-t1))" initial={still ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 18 }} style={{ transformOrigin: '50px 10px' }} />
      {xs.map((x, i) => (
        <motion.circle
          key={`m${i}`} cx={x} cy={midY} r={2.4} fill="rgb(var(--c-t2))" initial={still ? false : { scale: 0 }} animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 18, delay: 0.45 + i * 0.12 }} style={{ transformOrigin: `${x}px ${midY}px` }}
        />
      ))}
    </svg>
  );
}

/**
 * What Cascade planned for the current run, read-only: one mono line of how
 * the work splits across T1 → T2 → T3 and the estimate, then the sections.
 * Hosted runs auto-proceed (there are no risky tools to gate), so this is
 * information, not a question.
 */
export default function PlanNotice({ approval }: { approval: PlanApproval }) {
  const sections = approval.plan?.sections ?? [];
  const t2 = approval.t2Count ?? sections.length;
  const t3 = approval.t3Count ?? sections.reduce((n, s) => n + (s.t3Subtasks?.length ?? 0), 0);
  const cost = typeof approval.estCostUsd === 'number' ? approval.estCostUsd : undefined;

  return (
    <div className="flex flex-col gap-2" aria-label="Cascade planned this run">
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 font-mono text-[12px] text-ink-300">
        <span className="inline-flex items-center gap-1.5"><span className="h-[7px] w-[7px] rounded-full bg-t1" />plan</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-[7px] w-[7px] rounded-full bg-t2" />{t2} {t2 === 1 ? 'manager' : 'managers'}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-[7px] w-[7px] rounded-full bg-t3" />{t3} {t3 === 1 ? 'worker' : 'workers'}</span>
        {cost !== undefined && <span>~${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}</span>}
        {approval.plan?.complexity && <span className="text-ink-500">{approval.plan.complexity}</span>}
      </div>
      {sections.length > 1 && <PlanTree sections={sections} />}
      {approval.summary && <p className="m-0 text-[13px] text-ink-300">{approval.summary}</p>}
      {sections.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-[3px] p-0 text-[13px] text-ink-300">
          {sections.slice(0, 6).map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-3.5 shrink-0 font-mono text-[11px] leading-5 text-ink-500">{i + 1}</span>
              <span className="min-w-0">
                <span className="text-ink-100">{s.title ?? `Task ${i + 1}`}</span>
                {s.description && <span className="text-ink-500"> — {s.description}</span>}
              </span>
            </li>
          ))}
          {sections.length > 6 && <li className="pl-[22px] text-[12px] text-ink-500">+{sections.length - 6} more</li>}
        </ol>
      )}
    </div>
  );
}
