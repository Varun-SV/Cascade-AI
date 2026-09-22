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

  // The rollback added for the partial-index bug is unscoped — `deleteSource`
  // is the only removal the store offers. Two runs attaching the same document
  // at once both pass `isIndexed`, both write, and a failure in one then wipes
  // the other's rows; the survivor finishes its remaining slices and leaves
  // `hasSource` TRUE over an index missing everything the loser wrote. Worse
  // than the bug it was fixing, because it looks complete.
  it('serializes two attempts on one source, so a failure cannot eat the other', async () => {
    const db = new Database(':memory:');
    const store = new SqliteVectorStore(db);
    const chunks = Array.from({ length: 1000 }, (_, i) => ({ text: `chunk ${i}`, ord: i }));

    let failerCalls = 0;
    const failing: Embedder = {
      model: 'fake-embed', dims: 64,
      async embed(texts: string[]) {
        failerCalls++;
        await new Promise((r) => setTimeout(r, 0));
        if (failerCalls > 1) throw new Error('provider went away');
        return texts.map(() => new Array(64).fill(0.01));
      },
    };
    const working: Embedder = {
      model: 'fake-embed', dims: 64,
      async embed(texts: string[]) {
        await new Promise((r) => setTimeout(r, 0));
        return texts.map(() => new Array(64).fill(0.02));
      },
    };

    // Both start against the same unindexed source, at the same time.
    const a = new Retriever(failing, store).index(NS, 'shared', chunks);
    const b = new Retriever(working, store).index(NS, 'shared', chunks);
    const [ra, rb] = await Promise.allSettled([a, b]);

    // One of them failed; whichever did must not have left the other holding a
    // half-index that reports itself complete.
    const outcomes = [ra.status, rb.status].sort();
    expect(outcomes, 'one attempt failed and one did not').toEqual(['fulfilled', 'rejected']);

    const rows = store.lexicalSearch('chunk', { namespace: NS, k: 10_000 }).length;
    if (store.hasSource(NS, 'shared', 'fake-embed')) {
      expect(rows, 'a source that reports itself indexed holds every chunk').toBe(1000);
    } else {
      expect(rows, 'and one that does not holds nothing to be mistaken for the whole').toBe(0);
    }
  });

  it('does not embed twice when two runs attach the same document at once', async () => {
    // The lock is also a cost fix: the second attempt finds the work done and
    // returns without asking the provider for anything.
    const db = new Database(':memory:');
    const store = new SqliteVectorStore(db);
    let embedCalls = 0;
    const counting: Embedder = {
      model: 'fake-embed', dims: 64,
      async embed(texts: string[]) {
        embedCalls++;
        await new Promise((r) => setTimeout(r, 0));
        return texts.map(() => new Array(64).fill(0.01));
      },
    };
    const chunks = Array.from({ length: 600 }, (_, i) => ({ text: `chunk ${i}`, ord: i }));

    const [first, second] = await Promise.all([
      new Retriever(counting, store).index(NS, 'once', chunks),
      new Retriever(counting, store).index(NS, 'once', chunks),
    ]);

    expect(first + second, 'indexed once between them').toBe(600);
    expect(Math.min(first, second), 'the loser did no work at all').toBe(0);
    // 600 chunks is two slices; a second attempt would have made it four.
    expect(embedCalls, 'and the provider was asked once per slice, not twice').toBe(2);
  });

  it('serializes attempts on one source across different embedding models', async () => {
    // The lock used to be keyed by model as well as source, which handed a run
    // on the hosted default and a run on a local model separate locks over the
    // same source. Nothing underneath is model-aware: chunk ids carry no model,
    // `chunk_id` is the primary key so one model's rows REPLACE the other's,
    // and rollback is `deleteSource`, which is unscoped. So the failing attempt
    // takes the survivor's slices with it and the survivor finishes over the
    // hole, reporting itself complete under its own model.
    const db = new Database(':memory:');
    const store = new SqliteVectorStore(db);
    const chunks = Array.from({ length: 1000 }, (_, i) => ({ text: `chunk ${i}`, ord: i }));

    let failerCalls = 0;
    const failing: Embedder = {
      model: 'embed-hosted', dims: 64,
      async embed(texts: string[]) {
        failerCalls++;
        await new Promise((r) => setTimeout(r, 0));
        if (failerCalls > 1) throw new Error('provider went away');
        return texts.map(() => new Array(64).fill(0.01));
      },
    };
    const working: Embedder = {
      model: 'embed-local', dims: 64,
      async embed(texts: string[]) {
        await new Promise((r) => setTimeout(r, 0));
        return texts.map(() => new Array(64).fill(0.02));
      },
    };

    const a = new Retriever(failing, store).index(NS, 'shared', chunks);
    const b = new Retriever(working, store).index(NS, 'shared', chunks);
    await Promise.allSettled([a, b]);

    const rows = store.lexicalSearch('chunk', { namespace: NS, k: 10_000 }).length;
    const claimed = ['embed-hosted', 'embed-local'].filter((m) => store.hasSource(NS, 'shared', m));
    if (claimed.length > 0) {
      expect(rows, 'a source indexed under ANY model holds every chunk').toBe(1000);
    } else {
      expect(rows, 'and one indexed under none holds nothing to be mistaken for the whole').toBe(0);
    }
  });

  it('resolves a lazy chunk source only when it is about to do the work', async () => {
    // Callers must not ask `isIndexed` themselves to decide whether to chunk:
    // a caller that asks outside the lock is a caller that can skip `index()`
    // altogether and read a half-written index. So the question is asked here,
    // under the lock, and the chunking waits until the answer is no — which is
    // what makes dropping the caller-side check free rather than a re-chunking
    // tax on every run that attaches an already-indexed document.
    const r = build();
    let chunked = 0;
    const lazily = () => { chunked++; return [{ text: 'hello world', ord: 0 }]; };

    expect(await r.index(NS, 'lazy', lazily), 'the first attempt indexes').toBe(1);
    expect(chunked, 'chunking the document exactly once').toBe(1);

    expect(await r.index(NS, 'lazy', lazily), 'the second finds the work done').toBe(0);
    expect(chunked, 'without re-chunking what it was never going to embed').toBe(1);
  });

  it('names the model whose vectors it means when it searches', async () => {
    // Serializing WRITERS does not cover this: the writer's lock is released
    // when `index()` returns, so the next model may start replacing rows while
    // this caller is still searching. The read has to carry the model too.
    const db = new Database(':memory:');
    const real = new SqliteVectorStore(db);
    let askedFor: string | undefined;
    const spying = {
      upsert: real.upsert.bind(real),
      hasSource: real.hasSource.bind(real),
      deleteSource: real.deleteSource.bind(real),
      lexicalSearch: real.lexicalSearch.bind(real),
      denseSearch: (v: number[], o: { embedModel: string }) => {
        askedFor = o.embedModel;
        return [];
      },
    };
    const r = new Retriever(new FakeEmbedder(), spying as never);
    await r.index(NS, 'doc', [{ text: 'photosynthesis in green plants', ord: 0 }]);
    await r.search('photosynthesis', { namespace: NS });
    expect(askedFor, 'the search says which model embedded its query').toBe('fake-embed');
  });

  it('does not score a query against vectors a second model wrote over the rows', async () => {
    // Chunk ids are `namespace:source:ord` with no model in them and `chunk_id`
    // is the primary key, so a second model does not sit beside the first — it
    // REPLACES it, slice by slice. A reader that does not filter by model then
    // scores its own query against those rows, and because the cosine loop
    // walks `Math.min(a.length, b.length)` it truncates to the shorter vector
    // and returns a perfectly plausible number.
    const db = new Database(':memory:');
    const store = new SqliteVectorStore(db);
    const text = 'photosynthesis in green plants';

    const hosted = new FakeEmbedder();
    await new Retriever(hosted, store).index(NS, 'doc', [{ text, ord: 0 }]);
    expect(store.hasSource(NS, 'doc', 'fake-embed'), 'the first model owns the row').toBe(true);

    // A local model, at a different dimensionality, indexes the same source.
    const local: Embedder = {
      model: 'other-embed', dims: 8,
      async embed(texts: string[]) { return texts.map(() => new Array(8).fill(0.3)); },
    };
    await new Retriever(local, store).index(NS, 'doc', [{ text, ord: 0 }]);
    expect(store.hasSource(NS, 'doc', 'fake-embed'), 'and then it does not').toBe(false);

    const [qvec] = await hosted.embed([text]);
    expect(
      store.denseSearch(qvec!, { namespace: NS, k: 5, embedModel: 'fake-embed' }),
      'the first model finds none of the second model\u2019s vectors',
    ).toHaveLength(0);
    expect(
      store.denseSearch([...new Array(8).fill(0.3)], { namespace: NS, k: 5, embedModel: 'other-embed' }),
      'while the model that wrote them still finds its own',
    ).toHaveLength(1);
  });

  it('stops indexing when the run is cancelled, and leaves no partial index', async () => {
    // Near the 25M-character ceiling a document is ~12,500 chunks and well over
    // a hundred paid embedding requests. Stop used to buy none of them back.
    const db = new Database(':memory:');
    const store = new SqliteVectorStore(db);
    const controller = new AbortController();
    let embedCalls = 0;
    const cancelling: Embedder = {
      model: 'fake-embed', dims: 64,
      async embed(texts: string[]) {
        embedCalls++;
        // The user presses Stop while the first slice is in flight.
        controller.abort();
        return texts.map(() => new Array(64).fill(0.01));
      },
    };
    const chunks = Array.from({ length: 2048 }, (_, i) => ({ text: `chunk ${i}`, ord: i }));

    await expect(
      new Retriever(cancelling, store).index(NS, 'stopped', chunks, { signal: controller.signal }),
    ).rejects.toThrow();

    expect(embedCalls, 'it stopped at the next slice, not after all four').toBe(1);
    expect(
      store.hasSource(NS, 'stopped', 'fake-embed'),
      'and the unwind took the partial index with it, so a retry still means something',
    ).toBe(false);
  });

  it('gives up on a cancelled run instead of embedding after the wait', async () => {
    // The wait for another attempt on the same source can be a whole other
    // document's indexing, which is exactly long enough for the user to give
    // up. Coming out of it and starting to embed anyway is the waste the
    // signal exists to stop.
    const db = new Database(':memory:');
    const store = new SqliteVectorStore(db);
    const chunks = [{ text: 'hello world', ord: 0 }];

    let releaseWriter!: () => void;
    const holding = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writerEmbedder: Embedder = {
      model: 'fake-embed', dims: 64,
      async embed() { await holding; throw new Error('provider went away'); },
    };
    // Takes the lock synchronously, then stalls inside the embedder.
    const writer = new Retriever(writerEmbedder, store).index(NS, 'shared', chunks)
      .catch((e: unknown) => e);

    const controller = new AbortController();
    let embedCalls = 0;
    const waiting: Embedder = {
      model: 'fake-embed', dims: 64,
      async embed(texts: string[]) { embedCalls++; return texts.map(() => new Array(64).fill(0.1)); },
    };
    // Queued behind the writer, not aborted yet.
    let chunked = 0;
    const lazily = () => { chunked++; return chunks; };
    const second = new Retriever(waiting, store).index(NS, 'shared', lazily, { signal: controller.signal });

    controller.abort();
    releaseWriter();
    await writer;

    await expect(second, 'the queued attempt ends in the stop').rejects.toThrow();
    expect(embedCalls, 'and the wait ended in a stop, not in an embed').toBe(0);
    // The check has to be on THIS side of the wait. One taken only inside the
    // slice loop still stops the embedding, but not before the document has
    // been chunked — which near the ceiling is 25M characters of work for a
    // run nobody is waiting on any more.
    expect(chunked, 'not even chunking a document it was never going to embed').toBe(0);
    expect(store.hasSource(NS, 'shared', 'fake-embed'), 'with nothing left behind by either').toBe(false);
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
