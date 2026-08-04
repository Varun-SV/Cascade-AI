import { describe, expect, it } from 'vitest';
import { evaluateAcceptance, failures, undecided, type AcceptanceProbe } from './acceptance.js';

/** In-memory workspace: path → contents. A missing key means the file is absent. */
const probeOf = (files: Record<string, string | null>): AcceptanceProbe => ({
  stat: async (path) => (path in files ? { size: (files[path] ?? '').length } : null),
  read: async (path) => (path in files ? files[path] : null),
});

describe('evaluateAcceptance', () => {
  it('decides existence from the filesystem instead of asking a model', async () => {
    const results = await evaluateAcceptance(
      ['docs/report.md exists'],
      ['docs/report.md'],
      probeOf({ 'docs/report.md': '# Report' }),
    );
    expect(results[0]).toMatchObject({ verdict: 'passed' });
    expect(results[0]?.detail).toContain('docs/report.md exists');
  });

  it('fails a criterion whose file was never written', async () => {
    // The case the LLM grader gets wrong: it reads a confident summary saying
    // the report was produced and marks the criterion satisfied.
    const results = await evaluateAcceptance(
      ['docs/report.md exists'],
      ['docs/report.md'],
      probeOf({}),
    );
    expect(results[0]).toMatchObject({ verdict: 'failed', detail: 'docs/report.md does not exist' });
    expect(failures(results)).toEqual([
      'Acceptance not met — docs/report.md exists (docs/report.md does not exist)',
    ]);
  });

  it('checks a quoted needle against the file contents', async () => {
    const files = { 'out.txt': 'alpha beta gamma' };
    const hit = await evaluateAcceptance(['out.txt contains "beta"'], ['out.txt'], probeOf(files));
    const miss = await evaluateAcceptance(['out.txt contains "delta"'], ['out.txt'], probeOf(files));
    expect(hit[0]?.verdict).toBe('passed');
    expect(miss[0]?.verdict).toBe('failed');
    expect(miss[0]?.detail).toContain('does not contain "delta"');
  });

  it('resolves the file from a single owned file when the criterion names none', async () => {
    const results = await evaluateAcceptance(
      ['the file is non-empty'],
      ['notes.md'],
      probeOf({ 'notes.md': '' }),
    );
    expect(results[0]).toMatchObject({ verdict: 'failed', detail: 'notes.md is empty' });
  });

  it('defers rather than guessing — the property that makes this safe', async () => {
    // Each of these could be decided WRONG by a looser parser, so none of them
    // may be decided at all. They must reach the model exactly as today.
    const criteria = [
      'the tone is appropriate for executives',       // not mechanical
      'npm test exits 0',                             // shell: never executed here
      'report.md does not contain TODO',              // negated
      'a.md and b.md both exist',                     // ambiguous target
      '',                                             // empty
    ];
    const results = await evaluateAcceptance(criteria, ['a.md', 'b.md'], probeOf({ 'a.md': 'x' }));
    expect(results.map((r) => r.verdict)).toEqual(Array(criteria.length).fill('undecidable'));
    expect(undecided(results)).toEqual(criteria);
  });

  it('does not claim a binary artifact contains anything', async () => {
    // The file exists, but `read` returns null (unreadable as text). Existence
    // is proven; "contains" is not something this rung can answer.
    const results = await evaluateAcceptance(
      ['deck.pptx contains "Q3"'],
      ['deck.pptx'],
      probeOf({ 'deck.pptx': null }),
    );
    expect(results[0]?.verdict).toBe('undecidable');
  });

  it('returns one result per criterion, in order', async () => {
    const criteria = ['a.md exists', 'subjective judgement', 'b.md exists'];
    const results = await evaluateAcceptance(criteria, ['a.md', 'b.md'], probeOf({ 'a.md': 'x' }));
    expect(results.map((r) => r.criterion)).toEqual(criteria);
    expect(results.map((r) => r.verdict)).toEqual(['passed', 'undecidable', 'failed']);
  });
});
