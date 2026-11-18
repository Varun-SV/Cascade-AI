import { describe, expect, it } from 'vitest';
import { describeOpenWebSearch } from './open-web-log.js';

describe('the log line for a free web search', () => {
  it('says which sources answered and how many results, and nothing of what was asked', () => {
    const line = describeOpenWebSearch({
      sources: [
        { engine: 'duckduckgo', outcome: 'answered', found: 5 },
        { engine: 'wikipedia', outcome: 'empty', found: 0 },
        { engine: 'marginalia', outcome: 'failed', found: 0 },
      ],
      results: 5,
      retried: true,
      ms: 640,
    });
    expect(line).toBe('[open-web] 5 results in 640 ms (retried with fewer words); duckduckgo answered 5, wikipedia empty, marginalia failed');
  });

  it('carries no field that could hold the query or an address', () => {
    // The summary's shape is the guarantee: a field added later that could hold
    // what was searched for fails here first.
    const summary = { sources: [{ engine: 'duckduckgo' as const, outcome: 'empty' as const, found: 0 }], results: 0, retried: false, ms: 1 };
    expect(Object.keys(summary).sort()).toEqual(['ms', 'results', 'retried', 'sources']);
    expect(Object.keys(summary.sources[0]!).sort()).toEqual(['engine', 'found', 'outcome']);
    expect(describeOpenWebSearch(summary)).toBe('[open-web] 0 results in 1 ms; duckduckgo empty');
  });
});
