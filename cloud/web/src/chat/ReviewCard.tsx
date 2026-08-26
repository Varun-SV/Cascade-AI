import { CircleX, RotateCw } from 'lucide-react';
import { motion } from 'framer-motion';
import type { ReviewSummary } from './useChatSession';

/**
 * What a review pass rejected, as a card in the transcript.
 *
 * This replaces putting the reviewer's prose into the status line. That line
 * is rendered unclamped by the status button above, so a 780-character verdict
 * arrived as a wall of text beside a chevron sized for a sentence — and
 * clamping it there would have hidden the only explanation of why the run is
 * repeating itself. The verdict is structured now, so it can be shown as what
 * it is: a short line, and the gaps underneath.
 */
export function ReviewCard({ review, onSkip }: { review: ReviewSummary; onSkip?: () => void }): React.ReactElement {
  return (
    <motion.div
      className="overflow-hidden rounded-xl border border-ink-800/70 bg-ink-900/40"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="flex items-center gap-2 border-b border-ink-800/60 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">Review</span>
        <span className="rounded bg-warning-500/12 px-1.5 py-px text-[10px] font-semibold text-warning-500">
          {review.gaps.length === 1 ? '1 gap' : `${review.gaps.length} gaps`}
        </span>
      </div>

      {review.summary && (
        <div className="px-3 pt-2.5 text-[13px] leading-relaxed text-ink-200">{review.summary}</div>
      )}

      <div className="flex flex-col gap-0.5 p-2">
        {review.gaps.map((gap, i) => (
          <div key={`${i}-${gap.title}`} className="flex items-start gap-2.5 rounded-lg bg-ink-900/60 px-2 py-2">
            <CircleX size={14} className="mt-0.5 shrink-0 text-warning-500" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium leading-snug text-ink-200">{gap.title}</span>
              {gap.detail && <span className="text-xs leading-relaxed text-ink-400">{gap.detail}</span>}
              {gap.sections && gap.sections.length > 0 && (
                <span className="mt-px font-mono text-[10px] text-ink-500">{gap.sections.join(' · ')}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-ink-800/60 px-3 py-2">
        <RotateCw size={13} className="shrink-0 text-success-500" />
        <span className="text-xs text-ink-400">Replanning</span>
        {onSkip && (
          <>
            <span className="flex-1" />
            <button type="button" onClick={onSkip} className="text-xs text-accent-400 hover:text-accent-300">
              Skip and keep
            </button>
          </>
        )}
      </div>
    </motion.div>
  );
}
