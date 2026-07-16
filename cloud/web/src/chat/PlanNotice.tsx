import { motion } from 'framer-motion';
import { GitBranch, Layers, Cpu } from 'lucide-react';
import type { PlanApproval } from './useChatSession.js';

/**
 * Read-only surfacing of a boardroom plan Cascade produced for the current run.
 * Hosted runs auto-proceed (there are no risky tools to gate), so this is
 * informational — it shows *what* Cascade decided to do: how the work splits
 * across the T1 → T2 → T3 tiers, and the estimated cost.
 */
export default function PlanNotice({ approval }: { approval: PlanApproval }) {
  const sections = approval.plan?.sections ?? [];
  const t2 = approval.t2Count ?? sections.length;
  const t3 = approval.t3Count ?? sections.reduce((n, s) => n + (s.t3Subtasks?.length ?? 0), 0);
  const complexity = approval.plan?.complexity;
  const cost = typeof approval.estCostUsd === 'number' ? approval.estCostUsd : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-accent-500/25 bg-accent-500/[0.06] p-3.5"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent-500/15 text-accent-300">
          <GitBranch size={14} />
        </span>
        <p className="text-sm font-semibold text-ink-100">Cascade planned this run</p>
        {complexity && (
          <span className="ml-auto rounded-full bg-elev/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-300">
            {complexity}
          </span>
        )}
      </div>

      {approval.summary && <p className="mt-2 text-xs text-ink-300">{approval.summary}</p>}
      {approval.plan?.reasoning && (
        <p className="mt-1.5 text-xs leading-relaxed text-ink-400">{approval.plan.reasoning}</p>
      )}

      {/* Tier breakdown — amber T1 (plan) / violet T2 (coordinate) / cyan T3 (execute). */}
      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
        <span className="flex items-center gap-1.5 rounded-lg border border-t1/30 bg-t1/10 px-2 py-1 font-medium text-t1">
          <Cpu size={12} /> T1 · plans
        </span>
        <span className="flex items-center gap-1.5 rounded-lg border border-t2/30 bg-t2/10 px-2 py-1 font-medium text-t2">
          <Layers size={12} /> T2 · {t2} {t2 === 1 ? 'manager' : 'managers'}
        </span>
        <span className="flex items-center gap-1.5 rounded-lg border border-t3/30 bg-t3/10 px-2 py-1 font-medium text-t3">
          <GitBranch size={12} /> T3 · {t3} {t3 === 1 ? 'worker' : 'workers'}
        </span>
        {cost !== undefined && (
          <span className="flex items-center gap-1.5 rounded-lg border border-elev/10 bg-elev/[0.04] px-2 py-1 font-medium text-ink-300">
            ~${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)} est.
          </span>
        )}
      </div>

      {sections.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {sections.slice(0, 6).map((s, i) => (
            <li key={i} className="flex gap-2 text-xs text-ink-300">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-t2/15 text-[10px] font-bold text-t2">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="font-medium text-ink-200">{s.title ?? `Task ${i + 1}`}</span>
                {s.description && <span className="text-ink-400"> — {s.description}</span>}
              </span>
            </li>
          ))}
          {sections.length > 6 && (
            <li className="pl-6 text-[11px] text-ink-500">+{sections.length - 6} more…</li>
          )}
        </ul>
      )}

      <p className="mt-3 text-[11px] text-ink-500">Proceeding automatically — hosted runs don't need approval.</p>
    </motion.div>
  );
}
