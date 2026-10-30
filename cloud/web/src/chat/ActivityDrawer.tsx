import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, ArrowUpCircle, Ban } from 'lucide-react';
import CascadeMark from '../components/CascadeMark.js';
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

/** Coarse status, so an icon only re-animates when the state really changes. */
function statusKind(status: string): string {
  const s = status.toUpperCase();
  if (s.includes('COMPLETE') || s.includes('DONE')) return 'done';
  if (s.includes('BLOCK') || s.includes('SKIP')) return 'blocked';
  if (s.includes('FAIL') || s.includes('ERROR')) return 'failed';
  if (s.includes('ESCALAT')) return 'escalated';
  return 'active';
}

function StatusIcon({ status }: { status: string }) {
  const s = status.toUpperCase();
  if (s.includes('COMPLETE') || s.includes('DONE')) return <CheckCircle2 size={13} className="text-success-300" />;
  // BLOCKED is terminal, and it is NOT an error — this section was skipped
  // because something upstream failed, so it spent nothing and broke nothing.
  // It has to be matched before the generic fallback: matching nothing meant
  // falling through to the animated mark, which left skipped work looking like
  // it was still running for the rest of the session.
  if (s.includes('BLOCK') || s.includes('SKIP')) return <Ban size={13} className="text-ink-500" />;
  if (s.includes('FAIL') || s.includes('ERROR')) return <AlertTriangle size={13} className="text-danger-500" />;
  if (s.includes('ESCALAT')) return <ArrowUpCircle size={13} className="text-warning-300" />;
  return <CascadeMark size={13} />;
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
      className="overflow-hidden"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="sr-only">Run activity</div>
      <div className="flex flex-col">
        {nodes.map((n) => {
          const { name, level } = tierMeta(n.role);
          const detail = n.currentAction || n.label;
          const tier = n.role.slice(0, 2);
          const dot = tier === 'T1' ? 'bg-t1' : tier === 'T2' ? 'bg-t2' : tier === 'T3' ? 'bg-t3' : 'bg-ink-500';
          return (
            <motion.div
              key={n.tierId}
              layout="position"
              // A worker springs out of its manager: it arrives from the left,
              // one indent up, as the tree spawns it.
              initial={{ opacity: 0, x: -12, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              className="relative grid grid-cols-[14px_1fr_auto] items-center gap-x-2 rounded-md py-1 text-[13px]"
              style={{ paddingLeft: level * 16 }}
            >
              <AnimatePresence initial={false}>
                {statusKind(n.status) === 'done' && (
                  // Finishing flashes the row once in its tier's colour.
                  <motion.span
                    key="flash"
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-md"
                    style={{ background: `rgb(var(--c-${tier === 'T1' || tier === 'T2' || tier === 'T3' ? tier.toLowerCase() : 't3'}) / 0.16)` }}
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: 1.1, ease: 'easeOut' }}
                  />
                )}
              </AnimatePresence>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={statusKind(n.status)}
                  className="relative inline-flex"
                  initial={{ scale: 0.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.3, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 520, damping: 22 }}
                >
                  <StatusIcon status={n.status} />
                </motion.span>
              </AnimatePresence>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={detail || name}
                  className="relative min-w-0 truncate text-ink-100"
                  title={name}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.16 }}
                >
                  {detail || name}
                </motion.span>
              </AnimatePresence>
              <span className="receipt relative flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-500">
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
                {n.role}
                {n.model && <span>· {shortModel(n.model)}</span>}
              </span>
              {typeof n.progressPct === 'number' && n.progressPct > 0 && n.progressPct < 100 && (
                <div className="col-span-2 col-start-2 mt-1 h-0.5 overflow-hidden rounded-full bg-elev/10">
                  <motion.div
                    className="h-full rounded-full"
                    initial={false}
                    animate={{ width: `${Math.min(100, Math.max(0, n.progressPct))}%` }}
                    transition={{ type: 'spring', stiffness: 120, damping: 22 }}
                    style={{ background: 'var(--cascade-ramp-x)' }}
                  />
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}
