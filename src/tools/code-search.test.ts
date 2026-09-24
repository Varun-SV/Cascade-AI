import { describe, it, expect } from 'vitest';
import { CodeSearchTool } from './code-search.js';
import type { WorkspaceIndex } from '../retrieval/workspace-index.js';
import type { ScoredChunk } from '../retrieval/types.js';

// A stub WorkspaceIndex — the real one is covered in workspace-index.test.ts;
// here we just check the tool's contract (input handling + formatting).
function stubIndex(hits: ScoredChunk[]): WorkspaceIndex {
  // Honours `exclude` the way the real index does: before anything is ranked.
  return {
    search: async (_q: string, _k: number, exclude?: (sourceId: string) => boolean) =>
      hits.filter((h) => !exclude?.(h.sourceId)),
    getRoot: () => '/w',
  } as unknown as WorkspaceIndex;
}
const hit = (sourceId: string, text: string): ScoredChunk => ({ id: sourceId, sourceId, text, ord: 0, score: 1 });
const opts = {} as never;

describe('CodeSearchTool', () => {
  it('asks for a query when none is given', async () => {
    const tool = new CodeSearchTool(stubIndex([]));
    expect(await tool.execute({}, opts)).toMatch(/query/i);
  });

  it('reports when nothing is found', async () => {
    const tool = new CodeSearchTool(stubIndex([]));
    expect(await tool.execute({ query: 'anything' }, opts)).toMatch(/no relevant code/i);
  });

  it('formats hits with their file paths', async () => {
    const tool = new CodeSearchTool(stubIndex([hit('src/a.ts', 'function a() {}'), hit('src/b.ts', 'function b() {}')]));
    const out = await tool.execute({ query: 'fn' }, opts);
    expect(out).toContain('# src/a.ts');
    expect(out).toContain('# src/b.ts');
    expect(out).toContain('function a()');
  });

  it('surfaces a search error instead of throwing', async () => {
    const bad = { search: async () => { throw new Error('index locked'); }, getRoot: () => '/w' } as unknown as WorkspaceIndex;
    const tool = new CodeSearchTool(bad);
    expect(await tool.execute({ query: 'x' }, opts)).toMatch(/search failed/i);
  });

  // The index leaves these files out now, but one built before it did — or
  // not refreshed since — still holds them: `.cascade/config.json` is JSON,
  // and JSON is indexed.
  it('leaves out a protected or local-only file before the index ranks anything', async () => {
    let excluded: ((sourceId: string) => boolean) | undefined;
    const index = {
      search: async (_q: string, _k: number, exclude?: (sourceId: string) => boolean) => {
        excluded = exclude;
        return [hit('.cascade/config.json', '"apiKey": "sk-live"'), hit('secret/plan.md', 'the launch plan'), hit('src/a.ts', 'function a() {}')]
          .filter((h) => !exclude?.(h.sourceId));
      },
      getRoot: () => '/w',
    } as unknown as WorkspaceIndex;
    const tool = new CodeSearchTool(index);
    tool.setPathGuard((abs) => abs === '/w/.cascade/config.json');
    const asked: Array<[string, string]> = [];
    const out = await tool.execute({ query: 'key' }, {
      mayRead: (abs: string, to: 'model' | 'service') => { asked.push([abs, to]); return abs !== '/w/secret/plan.md'; },
    } as never);
    // The reranker is an outside service: the question asked is that one.
    expect(excluded?.('.cascade/config.json')).toBe(true);
    expect(excluded?.('secret/plan.md')).toBe(true);
    expect(excluded?.('src/a.ts')).toBe(false);
    expect(asked).toContainEqual(['/w/secret/plan.md', 'service']);
    expect(out).toContain('function a()');
    expect(out).not.toContain('sk-live');
    expect(out).not.toContain('launch plan');
  });
});
