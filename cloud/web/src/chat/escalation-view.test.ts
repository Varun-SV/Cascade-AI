import { describe, it, expect } from 'vitest';
import { clock, draftPreview, readIssues, wordCount } from './escalation-view.js';

describe('escalation view', () => {
  it('reads failed checks out of where it stopped, and keeps the rest as notes', () => {
    expect(readIssues(['Initial check failed: completeness, compliance', 'Review checks failed - tests and lint.', 'Ran out of time', 'Ran out of time', ' ']))
      .toEqual({ checks: ['completeness', 'compliance', 'tests', 'lint'], notes: ['Ran out of time'] });
  });

  it('gives the draft in one line, with its size', () => {
    expect(draftPreview('First line.\nSecond line.')).toEqual({ line: 'First line.', words: 4 });
    expect(draftPreview('x'.repeat(200), 20).line).toHaveLength(20);
    expect(draftPreview('   ')).toEqual({ line: '', words: 0 });
    expect(wordCount(1)).toBe('1 word');
    expect(wordCount(1234)).toBe('1.2k words');
    expect(wordCount(12_345)).toBe('12k words');
  });

  it('counts down in m:ss', () => {
    expect(clock(77)).toBe('1:17');
    expect(clock(-3)).toBe('0:00');
  });
});
