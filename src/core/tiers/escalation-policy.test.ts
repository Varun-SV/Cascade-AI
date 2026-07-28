// ─────────────────────────────────────────────
//  Cascade AI — Section escalation policy
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { sectionNeedsDecision, settledEscalationStatus, composeRootSectionOutput } from './escalation-policy.js';
import type { T3Result, T2Result } from '../../types.js';

function result(status: T3Result['status'], output = ''): T3Result {
  return {
    subtaskId: `s-${status}-${output.length}`,
    subtaskTitle: 'sub',
    status,
    output,
    issues: [],
  } as T3Result;
}

describe('sectionNeedsDecision', () => {
  it('asks when the only worker escalated', () => {
    expect(sectionNeedsDecision([result('ESCALATED', 'half a thing')])).toBe(true);
  });

  it('asks when SOME workers escalated and others finished', () => {
    // The regression this exists for: determineStatus checks `some(COMPLETED)`
    // before it checks ESCALATED, so this section reports PARTIAL. Gating the
    // prompt on that aggregate status skipped the question entirely — the
    // worker asked, and nobody was ever shown it.
    expect(sectionNeedsDecision([result('COMPLETED', 'done'), result('ESCALATED', 'stuck')])).toBe(true);
  });

  it('asks even when the rest failed rather than completed', () => {
    expect(sectionNeedsDecision([result('FAILED'), result('ESCALATED', 'stuck')])).toBe(true);
  });

  it('does not ask when nothing escalated', () => {
    expect(sectionNeedsDecision([result('COMPLETED', 'a'), result('FAILED')])).toBe(false);
    expect(sectionNeedsDecision([])).toBe(false);
  });
});

describe('settledEscalationStatus', () => {
  it('never returns ESCALATED', () => {
    // T1 compiles every section whose status is not FAILED, so a section left
    // ESCALATED passes through as if it had finished — the dead end this whole
    // feature removes. Whatever the outcome, the status must be terminal.
    const cases: T3Result[][] = [
      [result('ESCALATED', 'work')],
      [result('ESCALATED')],
      [result('COMPLETED', 'done'), result('ESCALATED', 'stuck')],
      [],
    ];
    for (const c of cases) {
      expect(['PARTIAL', 'FAILED']).toContain(settledEscalationStatus(c));
    }
  });

  it('keeps a section alive when an escalated worker produced something', () => {
    // "Skip" means keep what the section produced. FAILED would drop it from
    // the compile entirely — discarding exactly the work the user chose to
    // keep, which is what the one-worker case used to do.
    expect(settledEscalationStatus([result('ESCALATED', 'a partial answer')])).toBe('PARTIAL');
  });

  it('keeps a section alive when another worker completed', () => {
    expect(settledEscalationStatus([result('COMPLETED', 'done'), result('ESCALATED')])).toBe('PARTIAL');
  });

  it('fails only when there is genuinely nothing to keep', () => {
    expect(settledEscalationStatus([result('ESCALATED')])).toBe('FAILED');
    expect(settledEscalationStatus([result('FAILED'), result('ESCALATED')])).toBe('FAILED');
    expect(settledEscalationStatus([])).toBe('FAILED');
  });
});

describe('composeRootSectionOutput', () => {
  function t2(over: Partial<T2Result> = {}): Pick<T2Result, 'sectionSummary' | 'status' | 'issues'> {
    return { sectionSummary: 'Summary of the section', status: 'COMPLETED', issues: [], ...over };
  }

  it('joins the summary with the completed workers\' output, unchanged, on an ordinary success', () => {
    const out = composeRootSectionOutput(t2({ status: 'COMPLETED' }), ['worker output']);
    expect(out).toBe('Summary of the section\n\nworker output');
  });

  it('appends the timeout reason when a sibling worker completed but T2 still reports FAILED', () => {
    // The regression: a Moderate section with one completed worker and one
    // whose escalation timed out reports T2 status FAILED (T2Manager's
    // 'timeout' branch), but `completed.length > 0` used to mean only the
    // COMPLETED output was ever shown — the timeout reason vanished and the
    // user saw what looked like a finished answer.
    const out = composeRootSectionOutput(
      t2({ status: 'FAILED', issues: ['Escalated, but no decision was received in time.'] }),
      ['the other worker\'s finished output'],
    );
    expect(out).toContain('the other worker\'s finished output');
    expect(out).toContain('Escalated, but no decision was received in time.');
    expect(out).toContain('(incomplete:');
  });

  it('does not append anything when FAILED carries no issues', () => {
    const out = composeRootSectionOutput(t2({ status: 'FAILED', issues: [] }), ['output']);
    expect(out).toBe('Summary of the section\n\noutput');
  });

  it('does not append the failure note for a PARTIAL or COMPLETED status even with issues present', () => {
    // Only FAILED means the section didn't finish; PARTIAL/COMPLETED already
    // carry their own explanation through the normal summary text.
    const out = composeRootSectionOutput(t2({ status: 'PARTIAL', issues: ['a minor note'] }), ['output']);
    expect(out).not.toContain('(incomplete:');
  });
});
