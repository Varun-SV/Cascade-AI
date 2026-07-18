import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { WorkspaceIndex } from './workspace-index.js';
import type { Embedder } from './types.js';

// Bag-of-words embedder (shared idea with the retriever test) so dense search
// is meaningful offline.
class FakeEmbedder implements Embedder {
  readonly model = 'fake-embed';
  readonly dims = 64;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(this.dims).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0;
        for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
        v[h % this.dims] += 1;
      }
      return v;
    });
  }
}

describe('WorkspaceIndex', () => {
  let root: string;
  let db: Database.Database;
  const make = () => new WorkspaceIndex({ root, db, embedder: new FakeEmbedder() });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-ws-'));
    db = new Database(':memory:');
  });
  afterEach(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('indexes source files and finds relevant code', async () => {
    await fs.writeFile(path.join(root, 'auth.ts'), 'export function validateToken(token: string) {\n  return token.length > 0;\n}');
    await fs.writeFile(path.join(root, 'math.ts'), 'export function addNumbers(a: number, b: number) {\n  return a + b;\n}');
    const idx = make();
    const res = await idx.refresh();
    expect(res.filesIndexed).toBe(2);
    expect(res.chunks).toBeGreaterThanOrEqual(2);

    const hits = await idx.search('validate an auth token', 1);
    expect(hits[0]!.sourceId).toBe('auth.ts');
    expect(hits[0]!.text).toContain('validateToken');
  });

  it('re-indexes only changed files on refresh (incremental)', async () => {
    const a = path.join(root, 'a.ts');
    const b = path.join(root, 'b.ts');
    await fs.writeFile(a, 'function alpha() { return 1; }');
    await fs.writeFile(b, 'function beta() { return 2; }');
    const idx = make();
    await idx.refresh();

    // No changes → nothing re-indexed.
    const noop = await idx.refresh();
    expect(noop.filesIndexed).toBe(0);
    expect(noop.filesUnchanged).toBe(2);

    // Edit one file → exactly one re-indexed.
    await fs.writeFile(a, 'function alpha() { return 42; }');
    const after = await idx.refresh();
    expect(after.filesIndexed).toBe(1);
    expect(after.filesUnchanged).toBe(1);
  });

  it('drops removed files from the index', async () => {
    const a = path.join(root, 'gone.ts');
    await fs.writeFile(a, 'function willBeDeleted() { return 0; }');
    const idx = make();
    await idx.refresh();
    expect((await idx.search('willBeDeleted', 5)).length).toBeGreaterThan(0);

    await fs.rm(a);
    const res = await idx.refresh();
    expect(res.filesRemoved).toBe(1);
    expect(await idx.search('willBeDeleted', 5)).toHaveLength(0);
  });

  it('respects an isIgnored predicate and skips non-code files', async () => {
    await fs.writeFile(path.join(root, 'keep.ts'), 'function keep() { return 1; }');
    await fs.writeFile(path.join(root, 'secret.ts'), 'function secret() { return 2; }');
    await fs.writeFile(path.join(root, 'image.png'), Buffer.from([0, 1, 2, 3]));
    const idx = new WorkspaceIndex({
      root, db, embedder: new FakeEmbedder(),
      isIgnored: (abs) => abs.endsWith('secret.ts'),
    });
    const res = await idx.refresh();
    expect(res.filesIndexed).toBe(1); // only keep.ts (secret ignored, png non-code)
    const hits = await idx.search('secret', 5);
    expect(hits.some((h) => h.sourceId === 'secret.ts')).toBe(false);
    expect(hits.every((h) => h.sourceId === 'keep.ts')).toBe(true);
  });
});
