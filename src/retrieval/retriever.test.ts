import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteVectorStore } from './sqlite-store.js';
import { Retriever, reciprocalRankFusion } from './retriever.js';
import type { Embedder, ScoredChunk } from './types.js';

// Deterministic bag-of-words embedder: each lowercased token hashes to a
// dimension and increments it. Texts that share words get higher cosine, so
// dense retrieval is meaningful without a real model or network.
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

const sc = (id: string): ScoredChunk => ({ id, text: id, sourceId: 's', ord: 0, score: 0 });

describe('reciprocalRankFusion', () => {
  it('rewards items ranked highly across lists', () => {
    const a = [sc('x'), sc('y'), sc('z')];
    const b = [sc('y'), sc('x'), sc('w')];
    const fused = reciprocalRankFusion([a, b]);
    // y is #2,#1 and x is #1,#2 — both beat singletons; y edges ahead of x? both
    // symmetric here, so assert the singletons rank last.
    const ids = fused.map((f) => f.id);
    expect(ids.slice(0, 2).sort()).toEqual(['x', 'y']);
    expect(ids.slice(2)).toEqual(expect.arrayContaining(['z', 'w']));
  });

  it('deduplicates ids across lists', () => {
    const fused = reciprocalRankFusion([[sc('a'), sc('b')], [sc('a')]]);
    expect(fused.map((f) => f.id).filter((id) => id === 'a')).toHaveLength(1);
  });
});

describe('Retriever + SqliteVectorStore', () => {
  const build = () => {
    const db = new Database(':memory:');
    return new Retriever(new FakeEmbedder(), new SqliteVectorStore(db));
  };
  const NS = 'user1';

  it('indexes chunks and finds the relevant one (hybrid)', async () => {
    const r = build();
    await r.index(NS, 'doc1', [
      { text: 'The mitochondria is the powerhouse of the cell.', ord: 0 },
      { text: 'Photosynthesis converts sunlight into chemical energy in plants.', ord: 1 },
      { text: 'Interest rates influence bond prices and inflation.', ord: 2 },
    ]);
    const hits = await r.search('how do plants use sunlight', { namespace: NS, k: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain('Photosynthesis');
  });

  it('matches exact keywords via the lexical stage', async () => {
    const r = build();
    await r.index(NS, 'doc1', [
      { text: 'The function computeRRFScore fuses ranked lists.', ord: 0 },
      { text: 'A paragraph with no special identifiers at all here.', ord: 1 },
    ]);
    const hits = await r.search('computeRRFScore', { namespace: NS, k: 1 });
    expect(hits[0]!.text).toContain('computeRRFScore');
  });

  it('skips re-embedding an already-indexed source', async () => {
    const r = build();
    const first = await r.index(NS, 'doc1', [{ text: 'hello world', ord: 0 }]);
    expect(first).toBe(1);
    expect(r.isIndexed(NS, 'doc1')).toBe(true);
    const second = await r.index(NS, 'doc1', [{ text: 'hello world', ord: 0 }]);
    expect(second).toBe(0);
  });

  it('scopes results by namespace and sourceIds', async () => {
    const r = build();
    await r.index(NS, 'docA', [{ text: 'alpha content about retrieval', ord: 0 }]);
    await r.index(NS, 'docB', [{ text: 'beta content about retrieval', ord: 0 }]);
    await r.index('otherUser', 'docC', [{ text: 'gamma content about retrieval', ord: 0 }]);

    const scoped = await r.search('retrieval', { namespace: NS, sourceIds: ['docA'], k: 5 });
    expect(scoped.every((h) => h.sourceId === 'docA')).toBe(true);

    const nsHits = await r.search('retrieval', { namespace: NS, k: 5 });
    expect(nsHits.map((h) => h.sourceId).sort()).toEqual(['docA', 'docB']);
  });
});
