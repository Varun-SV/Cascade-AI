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
   */
  async index(
    namespace: string,
    sourceId: string,
    chunks: Array<{ text: string; ord: number }>,
  ): Promise<number> {
    if (chunks.length === 0 || this.isIndexed(namespace, sourceId)) return 0;

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
        const slice = chunks.slice(i, i + INDEX_SLICE);
        const vectors = await this.embedder.embed(slice.map((c) => c.text));
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
    const candidates = opts.candidates ?? 30;
    const k = opts.k ?? 6;
    const base = { namespace: opts.namespace, k: candidates, sourceIds: opts.sourceIds };
    const lexical = this.store.lexicalSearch(query, base);
    let dense: ScoredChunk[] = [];
    try {
      const [qvec] = await this.embedder.embed([query]);
      if (qvec && qvec.length) dense = this.store.denseSearch(qvec, base);
    } catch {
      // Embedding the query failed (provider hiccup) — degrade to lexical-only.
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
