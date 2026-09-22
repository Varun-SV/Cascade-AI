// ─────────────────────────────────────────────
//  Cascade AI — Retriever (Phase 1)
// ─────────────────────────────────────────────
//
// Ties an Embedder to a VectorStore and performs hybrid retrieval: a lexical
// (BM25) and a dense (cosine) first stage, fused with Reciprocal Rank Fusion.
// RRF operates on ranks, so it sidesteps BM25/cosine's incompatible score
// scales and needs no per-corpus tuning.

import type { Embedder, ScoredChunk, VectorStore } from './types.js';
import type { Reranker } from './rerank.js';

export interface RetrieverSearchOptions {
  namespace: string;
  /** Final number of chunks to return. */
  k?: number;
  /** Restrict to these source ids (e.g. only this run's attached docs). */
  sourceIds?: string[];
  /** Candidates to pull from each first stage before fusion. */
  candidates?: number;
  /** RRF damping constant (higher = flatter). Standard default is 60. */
  rrfK?: number;
  /** Rerank the fused candidates when a reranker is configured (default true). */
  rerank?: boolean;
  /** Abort the query embedding when the run is cancelled. */
  signal?: AbortSignal;
}

/**
 * Fuse several ranked lists into one by Reciprocal Rank Fusion. Each list
 * contributes 1/(rrfK + rank) to an item's score; identical items across lists
 * accumulate. Returns items best-first.
 */
export function reciprocalRankFusion(lists: ScoredChunk[][], rrfK = 60): ScoredChunk[] {
  const scores = new Map<string, number>();
  const items = new Map<string, ScoredChunk>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (rrfK + rank));
      if (!items.has(item.id)) items.set(item.id, item);
    });
  }
  return [...items.values()]
    .map((item) => ({ ...item, score: scores.get(item.id) ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Chunks embedded and written per pass in {@link Retriever.index}.
 *
 * Bounds what indexing RETAINS at once: at 1,536 dimensions, 512 vectors are
 * roughly 6 MB of JS numbers, against ~150 MB for a 25M-character document
 * embedded in one go.
 */
const INDEX_SLICE = 512;

/**
 * One indexing attempt per source at a time.
 *
 * Two runs can attach the same not-yet-indexed document at once — the same
 * user in two tabs, or a Pro account with concurrent runs. Both pass
 * `isIndexed`, both write slices, and then a failure in one triggers a
 * rollback that deletes rows belonging to BOTH: `deleteSource` is the only
 * removal the store offers and it is unscoped. The survivor then writes its
 * remaining slices and finishes, leaving `hasSource` true over an index that
 * is permanently missing whatever the loser had already written. Worse than
 * the partial-index bug the rollback was added to fix, because it looks
 * complete.
 *
 * Deleting only "our" rows would not help: both attempts chunk the same
 * document, so they write the same ids, and by rollback time those rows are
 * the other writer's content under our keys.
 *
 * So attempts are serialized per source instead. The second caller waits, then
 * re-checks — and normally finds the work already done and returns without
 * embedding anything, which also stops the duplicate spend that racing
 * attempts were quietly paying for.
 *
 * Keyed by SOURCE ALONE, deliberately not by source-and-embed-model. Adding
 * the model to the key handed two models separate locks over one source, and
 * everything underneath is model-blind: chunk ids are `namespace:source:ord`
 * with no model in them, `chunk_id` is the PRIMARY KEY, and `upsert` is
 * INSERT OR REPLACE. So the second model does not sit alongside the first, it
 * overwrites it row by row — and `deleteSource` is unscoped, so either
 * attempt's rollback takes the other's rows with it. Because `hasSource` is
 * asked per model, the wreckage reads as a complete index while search mixes
 * two models' vectors, at two different dimensionalities, through a cosine
 * stage that will not complain. One writer per source keeps it coherent: the
 * loser waits, re-checks under ITS OWN model, and either finds nothing to do
 * or replaces the source whole.
 *
 * Per PROCESS. Two server processes over one database would still race, and
 * closing that needs staging rows and an atomic publish rather than a lock.
 * The cloud server is a single process against its own SQLite file today, so
 * this is the bound that matches the deployment; the note is here so the next
 * person to add a second process knows what they inherit.
 */
const indexLocks = new Map<string, Promise<unknown>>();

/**
 * The chunks to index, or a thunk producing them. See {@link Retriever.index}
 * for why the lazy form is offered.
 */
export type IndexChunks =
  | Array<{ text: string; ord: number }>
  | (() => Array<{ text: string; ord: number }>);

export class Retriever {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    /** Optional second-stage reranker (Phase 2). When set, search reranks the
     *  fused candidates before returning the top-k. */
    private readonly reranker?: Reranker,
  ) {}

  /** Chunk model this retriever embeds with (for cache/version keys). */
  get embedModel(): string {
    return this.embedder.model;
  }

  /** True when this source is already indexed under the current embed model. */
  isIndexed(namespace: string, sourceId: string): boolean {
    return this.store.hasSource(namespace, sourceId, this.embedder.model);
  }

  /**
   * Embed and store a source's chunks. Skips work when the source is already
   * indexed under the current embed model (so re-runs don't re-embed). Returns
   * the number of chunks newly indexed.
   *
   * `chunks` may be a function, resolved only once this call holds the lock AND
   * has found the source unindexed — so the ordinary "already indexed" path
   * costs nothing to re-chunk a 25M-character document. That option exists
   * because the alternative is the caller deciding whether to chunk by asking
   * `isIndexed` itself, and a caller that asks `isIndexed` is a caller that can
   * skip `index()` altogether: it then searches whatever slices the current
   * writer happens to have committed, and answers from rows the writer is about
   * to roll back. The check belongs on this side of the lock, and only here.
   */
  async index(
    namespace: string,
    sourceId: string,
    chunks: IndexChunks,
    opts: { signal?: AbortSignal } = {},
  ): Promise<number> {
    opts.signal?.throwIfAborted();

    // Wait out any attempt already running on this source, then re-check. The
    // loop matters: several callers can be waiting on the same promise, and
    // whichever resumes first takes the lock — the others must see it and wait
    // again rather than barge in.
    const lockKey = `${namespace}\u0000${sourceId}`;
    for (;;) {
      const inFlight = indexLocks.get(lockKey);
      if (!inFlight) break;
      // A failed attempt is not our failure; it just means the source is still
      // unindexed and this attempt may try.
      try { await inFlight; } catch { /* fall through and re-check */ }
    }
    // The wait above can be long — a whole other document's indexing — so the
    // caller may have given up in the meantime.
    opts.signal?.throwIfAborted();
    if (this.isIndexed(namespace, sourceId)) return 0;

    // No await between the check above and the claim below, so the claim is
    // atomic with respect to every other caller.
    let release!: () => void;
    const claim = new Promise<void>((resolve) => { release = resolve; });
    indexLocks.set(lockKey, claim);
    try {
      const pieces = typeof chunks === 'function' ? chunks() : chunks;
      if (pieces.length === 0) return 0;
      return await this.indexSlices(namespace, sourceId, pieces, opts.signal);
    } finally {
      indexLocks.delete(lockKey);
      release();
    }
  }

  /** The slice-and-write loop, run under the per-source lock above. */
  private async indexSlices(
    namespace: string,
    sourceId: string,
    chunks: Array<{ text: string; ord: number }>,
    signal?: AbortSignal,
  ): Promise<number> {

    // Embedded and written in slices, so peak memory is one slice rather than
    // the whole corpus.
    //
    // This used to embed every chunk and hold every vector before writing a
    // single record. That was survivable while ingestion truncated documents at
    // 200,000 characters; once a document may be 25M characters it is about
    // 12,500 chunks, and at 1,536 dimensions the vectors ALONE are ~150 MB of
    // JS numbers before counting the text, the response objects or the rows.
    // Two tenants indexing at once was then enough to exhaust a server that had
    // just been taught not to run out of memory during extraction.
    //
    // The slice is deliberately larger than the embedder's own request batch:
    // it bounds what is RETAINED, while the embedder bounds what is asked for
    // in one call, and conflating the two would make either hard to tune.
    //
    // All of it or none of it. Slicing made indexing partially durable, and
    // `hasSource` answers "is there ANY row for this source" — so a slice that
    // succeeded before a later one failed would mark the source indexed
    // FOREVER, and every search from then on would quietly miss every chunk
    // after the failure. A caller that falls back for one turn expects to
    // retry; the rows have to let it. Unwinding on failure costs the work
    // already done and keeps the source eligible, which is the trade that
    // makes a retry mean something.
    let indexed = 0;
    try {
      for (let i = 0; i < chunks.length; i += INDEX_SLICE) {
        // Between slices as well as inside the embedder, so a cancelled run
        // stops here and the rollback below takes the partial index with it —
        // a half-written index that reports itself complete is exactly what
        // the unwind exists to prevent, and a Stop must not create one.
        signal?.throwIfAborted();
        const slice = chunks.slice(i, i + INDEX_SLICE);
        const vectors = await this.embedder.embed(slice.map((c) => c.text), { signal });
        const records = slice.map((c, j) => ({
          chunk: { id: `${namespace}:${sourceId}:${c.ord}`, text: c.text, sourceId, ord: c.ord, meta: { namespace } },
          vector: vectors[j] ?? [],
        })).filter((r) => r.vector.length > 0);
        this.store.upsert(records, this.embedder.model);
        indexed += records.length;
      }
    } catch (err) {
      // Best-effort: if the unwind itself fails there is nothing further to be
      // done here, and the original failure is the one worth reporting.
      try { this.store.deleteSource(namespace, sourceId); } catch { /* ignore */ }
      throw err;
    }
    return indexed;
  }

  /** Hybrid search: lexical ∪ dense, fused with RRF, then optionally reranked. */
  async search(query: string, opts: RetrieverSearchOptions): Promise<ScoredChunk[]> {
    opts.signal?.throwIfAborted();
    const candidates = opts.candidates ?? 30;
    const k = opts.k ?? 6;
    const base = { namespace: opts.namespace, k: candidates, sourceIds: opts.sourceIds };
    const lexical = this.store.lexicalSearch(query, base);
    let dense: ScoredChunk[] = [];
    try {
      const [qvec] = await this.embedder.embed([query], { signal: opts.signal });
      // Named, so this query cannot score vectors another model has written
      // over the rows underneath it. Serializing writers does not cover this:
      // the writer's lock is released when `index()` returns, and the next
      // model may begin replacing rows while this search is still running.
      if (qvec && qvec.length) {
        dense = this.store.denseSearch(qvec, { ...base, embedModel: this.embedder.model });
      }
    } catch {
      // Embedding the query failed (provider hiccup) — degrade to lexical-only.
      // An abort is not a hiccup: the caller asked to stop, so it propagates.
      opts.signal?.throwIfAborted();
    }
    const fused = reciprocalRankFusion([lexical, dense], opts.rrfK ?? 60);

    // Second stage: rerank the fused survivors when a reranker is configured.
    // The reranker itself falls back to input order on any failure, so this
    // never returns worse-than-fused results.
    if (this.reranker && opts.rerank !== false && fused.length > 1) {
      return this.reranker.rerank(query, fused, k);
    }
    return fused.slice(0, k);
  }
}
