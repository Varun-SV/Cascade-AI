import type { PlanApproval } from './useChatSession.js';

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
