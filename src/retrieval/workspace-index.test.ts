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

  // CascadeIgnore judged a file by its name, so `src/config.ts` hard-linked
  // to `.env` was read and sent to the embedder as ordinary source.
  it('keeps a hard link to a protected file out, under the predicate Cascade indexes with', async () => {
    const { CascadeIgnore } = await import('../config/ignore.js');
    const SECRET = 'sk-live-HARDLINKED-0123456789';
    await fs.writeFile(path.join(root, '.env'), `export const KEY = "${SECRET}";\n`);
    await fs.mkdir(path.join(root, 'src'));
    await fs.link(path.join(root, '.env'), path.join(root, 'src', 'config.ts'));
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const app = 1;\n');
    const ignore = new CascadeIgnore();
    await ignore.load(root);
    const embedded: string[] = [];
    const embedder = new FakeEmbedder();
    const idx = new WorkspaceIndex({
      root, db,
      embedder: { model: embedder.model, dims: embedder.dims, embed: async (t: string[]) => { embedded.push(...t); return embedder.embed(t); } },
      isIgnored: (abs) => ignore.isIgnored(abs, root),
    });
    await idx.refresh();
    expect(embedded.join('\n')).toContain('export const app');
    expect(embedded.join('\n')).not.toContain(SECRET);
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

  // An index built before a file was protected still holds its text. The
  // reranker sends each candidate's text to a model, so leaving the file out
  // of what is returned was not enough: it had to be gone before reranking.
  describe('a file protected after it was indexed', () => {
    const SECRET = 'sk-live-0123456789';
    const seed = async () => {
      await fs.mkdir(path.join(root, '.cascade'), { recursive: true });
      await fs.writeFile(path.join(root, '.cascade', 'config.json'), `{ "apiKey": "${SECRET}" }`);
      await fs.writeFile(path.join(root, 'keys.ts'), 'export function loadApiKey() { return process.env.KEY; }');
      await fs.writeFile(path.join(root, 'rotate.ts'), 'export function rotateApiKey(key: string) { return key; }');
      await make().refresh(); // indexed while nothing protected it
    };
    const isIgnored = (abs: string) => abs.endsWith(path.join('.cascade', 'config.json'));

    it('never reaches the reranker when the caller excludes it', async () => {
      await seed();
      const seen: string[] = [];
      const idx = new WorkspaceIndex({
        root, db, embedder: new FakeEmbedder(), isIgnored,
        reranker: { rerank: async (_q, candidates, k) => { seen.push(...candidates.map((c) => c.text)); return candidates.slice(0, k); } },
      });
      const hits = await idx.search('api key', 5, (sourceId) => sourceId === '.cascade/config.json');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.join('\n')).not.toContain(SECRET);
      expect(hits.map((h) => h.sourceId)).not.toContain('.cascade/config.json');
    });

    it('is dropped by prune(), without a refresh', async () => {
      await seed();
      const idx = new WorkspaceIndex({ root, db, embedder: new FakeEmbedder(), isIgnored });
      expect((await idx.search('apiKey sk live', 5)).some((h) => h.text.includes(SECRET))).toBe(true);
      expect(idx.prune()).toBe(1);
      expect((await idx.search('apiKey sk live', 5)).some((h) => h.text.includes(SECRET))).toBe(false);
      expect(idx.prune()).toBe(0);
      // …and a later refresh does not bring it back.
      expect((await idx.refresh()).filesIndexed).toBe(0);
    });
  });
});
