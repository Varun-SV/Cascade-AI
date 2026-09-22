import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteVectorStore } from './sqlite-store.js';
import { Retriever, reciprocalRankFusion } from './retriever.js';
import { LLMReranker } from './rerank.js';
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

  // A 25M-character document is ~12,500 chunks; embedding them all and holding
  // every vector before the first write was ~150 MB of JS numbers at 1,536
  // dimensions, on top of the text and the rows. Survivable only while
  // ingestion truncated at 200,000 characters — which it no longer does.
  it('embeds and writes in slices, so one corpus is not held whole', async () => {
    const db = new Database(':memory:');
    // An embedder that records how many texts it was handed per call, and how
    // many records the store already held at that moment. If indexing still
    // did one pass, the second number would be 0 right up to the end.
    let calls: number[] = [];
    const storedWhenCalled: number[] = [];
    const store = new SqliteVectorStore(db);
    const counting: Embedder = {
      model: 'fake-embed',
      dims: 64,
      async embed(texts: string[]) {
        calls.push(texts.length);
        storedWhenCalled.push(store.lexicalSearch('chunk', { namespace: NS, k: 10_000 }).length);
        return texts.map(() => new Array(64).fill(0.01));
      },
    };
    const r = new Retriever(counting, store);

    const chunks = Array.from({ length: 1300 }, (_, i) => ({ text: `chunk ${i}`, ord: i }));
    const n = await r.index(NS, 'big', chunks);

    expect(n, 'every chunk is still indexed').toBe(1300);
    expect(calls.length, 'across several passes, not one').toBeGreaterThan(1);
    expect(Math.max(...calls), 'and no pass holds more than a slice').toBeLessThanOrEqual(512);
    // The point of the change: rows are written as it goes, so the vectors for
    // earlier slices are already released by the time later ones are embedded.
    expect(storedWhenCalled[storedWhenCalled.length - 1], 'earlier slices were written before the last')
      .toBeGreaterThan(0);
  });

  // Slicing made indexing partially durable, and `hasSource` answers "is there
  // ANY row" — so a slice that landed before a later one failed would mark the
  // source indexed forever and every later search would silently miss the rest.
  it('leaves nothing behind when a later slice fails, so a retry can work', async () => {
    const db = new Database(':memory:');
    const store = new SqliteVectorStore(db);
    let calls = 0;
    const flaky: Embedder = {
      model: 'fake-embed',
      dims: 64,
      async embed(texts: string[]) {
        calls++;
        if (calls > 1) throw new Error('embedding provider went away');
        return texts.map(() => new Array(64).fill(0.01));
      },
    };
    const r = new Retriever(flaky, store);
    const chunks = Array.from({ length: 1000 }, (_, i) => ({ text: `chunk ${i}`, ord: i }));

    await expect(r.index(NS, 'half', chunks)).rejects.toThrow(/went away/);

    expect(calls, 'the first slice did land before the second failed').toBeGreaterThan(1);
    expect(r.isIndexed(NS, 'half'), 'but the source is NOT marked indexed').toBe(false);
    expect(
      store.lexicalSearch('chunk', { namespace: NS, k: 10_000 }).length,
      'and no partial rows survive to be mistaken for the whole',
    ).toBe(0);
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

  it('applies a configured reranker to the fused candidates', async () => {
    const db = new Database(':memory:');
    // A reranker that always promotes the passage mentioning "taxes".
    const reranker = new LLMReranker({
      complete: async (prompt: string) => {
        const lines = prompt.split('\n').filter((l) => /^\[\d+\]/.test(l));
        const idx = lines.findIndex((l) => /taxes/i.test(l));
        return idx >= 0 ? String(idx + 1) : '1';
      },
    });
    const r = new Retriever(new FakeEmbedder(), new SqliteVectorStore(db), reranker);
    await r.index(NS, 'doc1', [
      { text: 'a note about cats and pets', ord: 0 },
      { text: 'a note about quarterly taxes and filings', ord: 1 },
      { text: 'a note about weather patterns', ord: 2 },
    ]);
    const hits = await r.search('anything', { namespace: NS, k: 3 });
    expect(hits[0]!.text).toContain('taxes');

    // rerank:false bypasses the reranker (fused order stands).
    const noRerank = await r.search('cats', { namespace: NS, k: 1, rerank: false });
    expect(noRerank[0]!.text).toContain('cats');
  });
});
