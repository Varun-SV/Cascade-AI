import { describe, it, expect } from 'vitest';
import { describeUndo } from './checkpoint-text.js';

const run = { n: 3, label: 'Refactor the parser', at: '2026-11-19T10:00:00Z', before: 'abc' };

describe('describeUndo', () => {
  it('a run never recorded to its end is not undone, and says how to force it (Codex on c194786)', () => {
    const text = describeUndo({ runs: [], restored: [], removed: [], skipped: [], incomplete: [run] });
    expect(text).toMatch(/^Not undone/);
    expect(text).toContain('#3 ("Refactor the parser")');
    expect(text).toContain('/undo --force');
  });
  it('lists files kept because .gitignore left them out of the checkpoint', () => {
    const text = describeUndo({ runs: [run], restored: ['a.ts'], removed: [], skipped: [], unrecorded: ['local.txt'] });
    expect(text).toContain('Undid run #3');
    expect(text).toMatch(/Kept, as they were there before the run[^\n]*\(1\):\n {2}local\.txt/);
  });
});
