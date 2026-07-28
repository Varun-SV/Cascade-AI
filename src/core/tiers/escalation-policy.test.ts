// ─────────────────────────────────────────────
//  Cascade AI — Section escalation policy
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { sectionNeedsDecision, settledEscalationStatus } from './escalation-policy.js';
import type { T3Result } from '../../types.js';

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
