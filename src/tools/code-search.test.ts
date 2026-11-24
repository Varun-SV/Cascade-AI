import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashContent } from '../retrieval/manifest.js';
import { CodeSearchTool } from './code-search.js';
import type { WorkspaceIndex } from '../retrieval/workspace-index.js';
import type { ScoredChunk } from '../retrieval/types.js';

// A stub WorkspaceIndex — the real one is covered in workspace-index.test.ts;
// here we just check the tool's contract (input handling + formatting).
function stubIndex(hits: ScoredChunk[], root = '/w', hashes: Record<string, string> = {}): WorkspaceIndex {
  // Honours `exclude` the way the real index does: before anything is ranked.
  return {
    search: async (_q: string, _k: number, exclude?: (sourceId: string) => boolean) =>
      hits.filter((h) => !exclude?.(h.sourceId)),
    getRoot: () => root,
    indexedHash: (rel: string) => hashes[rel],
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

  // Codex on 87aeac4 and 27f8481: the caller holds these snippets, and is told
  // if the files change; but not a file the index is behind on, whose snippet
  // is out of date already and is marked so.
  it('notes each file whose lines it returns as read, unless the index is behind on it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-cs-'));
    try {
      const big = 'x'.repeat(5_000);
      for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(root, f), `${f} ${big}`);
      // b.ts changed after it was indexed.
      const hashes = { 'a.ts': hashContent(`a.ts ${big}`), 'b.ts': hashContent('b.ts as indexed') };
      const noted: string[] = [];
      const tool = new CodeSearchTool(stubIndex([hit('a.ts', big), hit('b.ts', big), hit('c.ts', 'x'.repeat(5_000))], root, hashes));
      const out = await tool.execute({ query: 'fn' }, { noteRead: (abs: string) => noted.push(abs) } as never);
      expect(noted).toEqual([path.join(root, 'a.ts')]);
      expect(out).toContain('# a.ts\n');
      expect(out).toMatch(/# b\.ts \(indexed earlier: the file may have changed since/);
      // c.ts was cut off by the output cap: neither shown nor noted.
      expect(out).not.toContain('# c.ts');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
      indexedHash: () => undefined,
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
