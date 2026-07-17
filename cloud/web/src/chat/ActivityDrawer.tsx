import { motion } from 'framer-motion';
import { CheckCircle2, Loader2, AlertTriangle, ArrowUpCircle, Cpu, CornerDownRight } from 'lucide-react';
import type { ActivityNode } from './useChatSession.js';

// Human name + indent depth for each tier role. Cascade orchestrates
// T1 (Administrator) → T2 (Manager) → T3 (Worker); the drawer renders that
// hierarchy as an indented tree so the delegation is visible at a glance.
function tierMeta(role: string): { name: string; level: number } {
  if (role.startsWith('T1')) return { name: 'Administrator', level: 0 };
  if (role.startsWith('T2')) return { name: 'Manager', level: 1 };
  if (role.startsWith('T3')) return { name: 'Worker', level: 2 };
  return { name: role || 'Tier', level: 0 };
}

function StatusIcon({ status }: { status: string }) {
  const s = status.toUpperCase();
  if (s.includes('COMPLETE') || s.includes('DONE')) return <CheckCircle2 size={13} className="text-emerald-400" />;
  if (s.includes('FAIL') || s.includes('ERROR')) return <AlertTriangle size={13} className="text-danger-500" />;
  if (s.includes('ESCALAT')) return <ArrowUpCircle size={13} className="text-amber-400" />;
  return <Loader2 size={13} className="animate-spin text-accent-400" />;
}

// Strip a leading "provider:" so the chip stays compact ("openai:gpt-5" → "gpt-5").
function shortModel(model: string): string {
  const i = model.indexOf(':');
  return i >= 0 ? model.slice(i + 1) : model;
}

export default function ActivityDrawer({ activity }: { activity: ActivityNode[] }) {
  if (activity.length === 0) return null;
  const nodes = [...activity].sort((a, b) => a.order - b.order);

  return (
    <motion.div
      className="overflow-hidden rounded-xl border border-ink-800/70 bg-ink-900/40"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="border-b border-ink-800/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-500">
        Run activity
      </div>
      <div className="flex flex-col gap-1 p-2">
        {nodes.map((n) => {
          const { name, level } = tierMeta(n.role);
          const detail = n.currentAction || n.label;
          return (
            <div
              key={n.tierId}
              className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-ink-800/40"
              style={{ marginLeft: level * 16 }}
            >
              {level > 0 && <CornerDownRight size={13} className="mt-0.5 shrink-0 text-ink-600" />}
              <StatusIcon status={n.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-ink-200">{name}</span>
                  <span className="rounded bg-ink-800/70 px-1 py-px text-[10px] font-medium text-ink-500">{n.role}</span>
                  {n.model && (
                    <span className="inline-flex items-center gap-1 rounded bg-accent-500/10 px-1.5 py-px text-[10px] font-medium text-accent-300">
                      <Cpu size={9} />
                      {shortModel(n.model)}
                    </span>
                  )}
                </div>
                {detail && <div className="mt-0.5 truncate text-[11px] text-ink-400">{detail}</div>}
                {typeof n.progressPct === 'number' && n.progressPct > 0 && n.progressPct < 100 && (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-ink-800">
                    <div
                      className="h-full rounded-full bg-accent-500 transition-all"
                      style={{ width: `${Math.min(100, Math.max(0, n.progressPct))}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
