// ─────────────────────────────────────────────
//  Cascade AI — Section escalation policy
// ─────────────────────────────────────────────
//
//  The rules for "a worker stopped and asked a question" live here as pure
//  functions rather than inline in T2Manager.execute, because every bug this
//  feature has had was in these two decisions and neither was reachable by a
//  test while it sat inside a method that needs a live router to call.

import type { T3Result, T2Result } from '../../types.js';

/**
 * Should the user be asked?
 *
 * Deliberately NOT `determineStatus(results) === 'ESCALATED'`. That helper
 * checks `some(COMPLETED)` first, so a section with one finished worker and one
 * that stopped on a question reports PARTIAL — and gating on the aggregate
 * status meant the question was never asked at all, while the escalated
 * worker's output was dropped by the COMPLETED-only aggregation on its way out.
 */
export function sectionNeedsDecision(results: T3Result[]): boolean {
  return results.some((r) => r.status === 'ESCALATED');
}

/**
 * The terminal status for a section whose escalation is over — skipped by the
 * user, unanswered, or escalated again after its one retry.
 *
 * Never ESCALATED. T1 compiles every section whose status is not FAILED, so
 * leaving one ESCALATED lets it through as though it had finished — the exact
 * dead end this feature exists to remove. PARTIAL whenever any work survives,
 * because PARTIAL is what carries that work past T1's filter and is also the
 * honest description: something exists, it just is not finished.
 */
export function settledEscalationStatus(results: T3Result[]): T2Result['status'] {
  const hasWork = results.some((r) => r.status === 'COMPLETED' || !!r.output);
  return hasWork ? 'PARTIAL' : 'FAILED';
}

/**
 * The user-facing text for a root-T2 (Moderate complexity — no T1, one
 * section) run.
 *
 * A MIXED section is possible here too: one worker completes while a
 * sibling's escalation times out, and T2 reports the section FAILED (see
 * T2Manager.execute's 'timeout' branch) even though there is completed
 * output to show. Looking only at the completed workers' text — which is all
 * `cascade.ts` used to do — silently drops the one thing that explains why
 * the answer isn't the whole task: the recorded timeout reason lives in
 * `t2Result.issues`, and nothing rendered it.
 */
export function composeRootSectionOutput(
  t2Result: Pick<T2Result, 'sectionSummary' | 'status' | 'issues'>,
  completedOutputs: string[],
): string {
  let output = `${t2Result.sectionSummary}\n\n${completedOutputs.join('\n\n')}`;
  if (t2Result.status === 'FAILED' && t2Result.issues?.length) {
    output += `\n\n_(incomplete: ${t2Result.issues.join('; ')})_`;
  }
  return output;
}
