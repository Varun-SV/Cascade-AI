// ─────────────────────────────────────────────
//  Cascade AI — Run budget: work, then the answer
// ─────────────────────────────────────────────
//
// A per-run cap used to be a wall: the call that crossed it was refused, the
// calls in flight were cancelled, and a run that had finished half its work
// ended with "stopped to avoid runaway cost" and nothing else. The money spent
// on the finished half bought nothing the user could see.
//
// So a run's cap is split. Most of it pays for work — planning, workers,
// reviews. The rest is kept back for the one call that writes the answer from
// whatever work is done. Work that would eat into that reserve is not started;
// the answer is written instead. The cap itself stays the hard ceiling.

/** The share of a per-run cap kept back for writing the answer. */
export const WRAP_UP_RESERVE = 0.2;

/** An answer call with less room than this is not worth asking for. */
export const MIN_FINAL_OUTPUT_TOKENS = 256;

/** Where a run stands against its caps. */
export interface RunBudget {
  /** The per-run cost cap, when one is set. */
  capUsd?: number;
  spentUsd: number;
  /** What work may still spend before the answer's reserve. */
  workRemainingUsd?: number;
  /** What the whole cap has left, the reserve included. */
  remainingUsd?: number;
  /** The per-run token cap, when one is set. */
  capTokens?: number;
  usedTokens: number;
  workRemainingTokens?: number;
  remainingTokens?: number;
  /** True once work has stopped so that what is left pays for the answer. */
  wrappingUp: boolean;
}

/** The part of a cap that work may spend. */
export function workShare(cap: number): number {
  return cap * (1 - WRAP_UP_RESERVE);
}

/** A call refused, or cut off, by a per-run cap — wrap-up or the hard stop. */
export function isBudgetStop(err: unknown): boolean {
  return err instanceof Error && (err.name === 'BudgetWrapUpError' || err.name === 'BudgetExceededError');
}

/**
 * The finished work, as it stands, when there is no budget left to write an
 * answer from it. Each finished section under its own heading, then what was
 * not finished and why — no model call, so it cannot fail or cost anything.
 */
export function assembleFinishedWork(
  sections: ReadonlyArray<{ title: string; text: string }>,
  unfinished: readonly string[],
  reason: string,
): string {
  const parts = [`_${reason}_`];
  for (const s of sections) parts.push(`## ${s.title}\n\n${s.text.trim()}`);
  if (unfinished.length) parts.push(`**Not finished:** ${unfinished.join(', ')}.`);
  return parts.join('\n\n');
}

/**
 * The line under an answer written while wrapping up: what it covers is what
 * was finished, not everything that was asked, and the reader should know why.
 */
export function wrapUpNote(budget: RunBudget): string {
  const spent = budget.capUsd != null
    ? `$${budget.spentUsd.toFixed(2)} of this task's $${budget.capUsd.toFixed(2)} budget`
    : `${budget.usedTokens.toLocaleString()} of this task's ${(budget.capTokens ?? 0).toLocaleString()}-token budget`;
  return `_Budget: work stopped at ${spent}, so this answer covers what was finished. Raise the per-task budget for a fuller one._`;
}
