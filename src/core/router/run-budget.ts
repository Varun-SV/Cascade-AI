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

import type { ModelInfo } from '../../types.js';
import { calculateCost } from '../../utils/cost.js';

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
  /**
   * Planned work the budget held back: sections and workers cut from a plan
   * to fit it, work calls refused while wrapping up, and sections or workers
   * not started then. A run can wrap up with nothing left to hold back — its
   * last worker crossing the line — and then its answer covers everything.
   */
  workNotStarted: number;
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
 * The line under an answer when the budget held planned work back: what it
 * covers is what was finished, not everything that was asked, and the reader
 * should know why.
 */
export function budgetNote(budget: RunBudget): string {
  const cap = budget.capUsd != null
    ? `this task's $${budget.capUsd.toFixed(2)} budget ($${budget.spentUsd.toFixed(2)} spent)`
    : `this task's ${(budget.capTokens ?? 0).toLocaleString()}-token budget (${budget.usedTokens.toLocaleString()} used)`;
  return `_Budget: not all the planned work fitted in ${cap}, so this answer covers what was finished. Raise the per-task budget for a fuller one._`;
}

// ── Sizing a plan to the budget ───────────────
//
// A plan is priced before it runs from the same rough shape the plan-approval
// estimate uses: a model call reads about 1,500 tokens and writes about 700; a
// section's manager makes about 3 calls and each worker about 4. Crude, but
// the planner only needs to know whether the budget pays for two sections or
// twenty — and the wrap-up above still catches a plan that runs over.

export const PLANNED_CALL = { inputTokens: 1_500, outputTokens: 700 } as const;
export const T2_CALLS_PER_SECTION = 3;
export const T3_CALLS_PER_SUBTASK = 4;
/** Workers a section is counted with when working out how many sections fit. */
const WORKERS_PER_SECTION = 2;

/** One call of the plan's shape on `model`; 0 when there is no model or no price. */
export function plannedCallUsd(model: ModelInfo | null | undefined): number {
  return model ? calculateCost(PLANNED_CALL.inputTokens, PLANNED_CALL.outputTokens, model) : 0;
}

/** How many workers a section's share of the budget pays for (Infinity when unpriced). */
export function workersWithin(
  sectionUsd: number,
  t2: ModelInfo | null | undefined,
  t3: ModelInfo | null | undefined,
): number {
  const worker = T3_CALLS_PER_SUBTASK * plannedCallUsd(t3);
  if (!(worker > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor((sectionUsd - T2_CALLS_PER_SECTION * plannedCallUsd(t2)) / worker));
}

/**
 * How many sections `workUsd` pays for, each counted with two workers. Null
 * when the models have no price — a local model costs nothing to fit a plan
 * to. Always at least one: a budget too small for one section is the
 * wrap-up's to handle, and a plan of nothing answers nothing.
 */
export function sectionsWithin(
  workUsd: number,
  t2: ModelInfo | null | undefined,
  t3: ModelInfo | null | undefined,
): number | null {
  const section = T2_CALLS_PER_SECTION * plannedCallUsd(t2) + WORKERS_PER_SECTION * T3_CALLS_PER_SUBTASK * plannedCallUsd(t3);
  if (!(section > 0)) return null;
  return Math.max(1, Math.floor(workUsd / section));
}

/**
 * At most `max` items, taken in the planner's order, each kept only together
 * with everything it depends on, directly or through another item. An item
 * whose prerequisites do not fit alongside it is dropped with them: running it
 * without the work the planner said it needs would change what the plan
 * means, and the executors would silently drop a dependency on a cut item.
 *
 * In an acyclic plan something always fits, since an item with no
 * dependencies needs only itself. If nothing does (every item sits behind a
 * cycle larger than `max`), the smallest complete group is kept anyway: the
 * run's wrap-up still holds the budget, and a partial group would not.
 */
export function keepFirst<T extends { dependsOn?: string[] }>(items: readonly T[], max: number, id: (item: T) => string): T[] {
  if (items.length <= max) return [...items];
  const byId = new Map(items.map((item) => [id(item), item] as const));
  const kept = new Set<string>();
  /** The item and every item it depends on that is not already kept. */
  const needs = (item: T): Set<string> => {
    const need = new Set<string>();
    const stack = [item];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const key = id(next);
      if (kept.has(key) || need.has(key)) continue;
      need.add(key);
      for (const dep of next.dependsOn ?? []) {
        const found = byId.get(dep);
        if (found) stack.push(found);
      }
    }
    return need;
  };
  for (const item of items) {
    if (kept.size >= max) break;
    const need = needs(item);
    if (kept.size + need.size <= max) for (const key of need) kept.add(key);
  }
  if (kept.size === 0) {
    let smallest: Set<string> | null = null;
    for (const item of items) {
      const need = needs(item);
      if (!smallest || need.size < smallest.size) smallest = need;
    }
    for (const key of smallest ?? []) kept.add(key);
  }
  return items.filter((item) => kept.has(id(item)));
}

/**
 * The request for one direct answer, when the budget ran down before any of
 * the planned work finished: the reserve kept for the answer answers the
 * question itself, as a fast answer would, rather than reporting a failure
 * the budget caused.
 */
export function directAnswerPrompt(request: string): string {
  return 'Answer this request directly, in one reply, as well as you can without further research or tools. '
    + 'The planned multi-step work did not fit within this task\'s budget, so end with one short line on what a fuller answer would still need.'
    + `\n\nRequest: ${request}`;
}
