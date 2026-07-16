import { motion } from 'framer-motion';
import { Layers, Zap } from 'lucide-react';
import type { ContextApprovalInfo } from './useChatSession.js';

/**
 * "Auto-detect + one-tap confirm" for the extended-context path. The input is
 * larger than the model's window; processing it means chunking + summarizing
 * (extra model calls), so we confirm before spending. Skipping still runs — the
 * model just gets the raw input and truncates it naturally.
 */
export default function ContextApprovalDialog({ info, onResolve }: {
  info: ContextApprovalInfo;
  onResolve: (approved: boolean) => void;
}) {
  const ratio = info.inputTokens && info.windowTokens ? info.inputTokens / info.windowTokens : undefined;
  const chunks = info.estChunks ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => onResolve(false)} />
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="glass-strong relative w-full max-w-md rounded-2xl p-5"
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-500/15 text-accent-300">
            <Layers size={18} />
          </span>
          <div>
            <p className="text-sm font-semibold text-ink-100">This input is larger than the model's window</p>
            <p className="text-xs text-ink-400">
              {ratio ? `~${ratio.toFixed(1)}× the limit` : 'Over the limit'} · Extended context can process it.
            </p>
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-300">
          Cascade will split it into{' '}
          <span className="font-semibold text-ink-100">{chunks} chunk{chunks === 1 ? '' : 's'}</span>, summarize each, and
          combine them to fit — roughly <span className="font-semibold text-ink-100">{chunks} extra call{chunks === 1 ? '' : 's'}</span>.
          Skipping sends the raw input instead (the model will truncate it).
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="flex-1 rounded-lg border border-elev/10 bg-elev/[0.04] px-3 py-2 text-sm font-medium text-ink-200 hover:bg-elev/10"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            className="accent-grad flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-accent-700/25"
          >
            <Zap size={14} /> Process with extended context
          </button>
        </div>
      </motion.div>
    </div>
  );
}
