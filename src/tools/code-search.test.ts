import { describe, it, expect } from 'vitest';
import { CodeSearchTool } from './code-search.js';
import type { WorkspaceIndex } from '../retrieval/workspace-index.js';
import type { ScoredChunk } from '../retrieval/types.js';

// A stub WorkspaceIndex — the real one is covered in workspace-index.test.ts;
// here we just check the tool's contract (input handling + formatting).
function stubIndex(hits: ScoredChunk[]): WorkspaceIndex {
  return { search: async () => hits } as unknown as WorkspaceIndex;
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
    const bad = { search: async () => { throw new Error('index locked'); } } as unknown as WorkspaceIndex;
    const tool = new CodeSearchTool(bad);
    expect(await tool.execute({ query: 'x' }, opts)).toMatch(/search failed/i);
  });
});
