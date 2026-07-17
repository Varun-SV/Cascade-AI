// ─────────────────────────────────────────────
//  Cascade AI — Retriever (Phase 1)
// ─────────────────────────────────────────────
//
// Ties an Embedder to a VectorStore and performs hybrid retrieval: a lexical
// (BM25) and a dense (cosine) first stage, fused with Reciprocal Rank Fusion.
// RRF operates on ranks, so it sidesteps BM25/cosine's incompatible score
// scales and needs no per-corpus tuning.

import type { Embedder, ScoredChunk, VectorStore } from './types.js';

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

export class Retriever {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
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
    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    const records = chunks.map((c, i) => ({
      chunk: { id: `${namespace}:${sourceId}:${c.ord}`, text: c.text, sourceId, ord: c.ord, meta: { namespace } },
      vector: vectors[i] ?? [],
    })).filter((r) => r.vector.length > 0);
    this.store.upsert(records, this.embedder.model);
    return records.length;
  }

  /** Hybrid search: lexical ∪ dense, fused with RRF. */
  async search(query: string, opts: RetrieverSearchOptions): Promise<ScoredChunk[]> {
    const candidates = opts.candidates ?? 30;
    const base = { namespace: opts.namespace, k: candidates, sourceIds: opts.sourceIds };
    const lexical = this.store.lexicalSearch(query, base);
    let dense: ScoredChunk[] = [];
    try {
      const [qvec] = await this.embedder.embed([query]);
      if (qvec && qvec.length) dense = this.store.denseSearch(qvec, base);
    } catch {
      // Embedding the query failed (provider hiccup) — degrade to lexical-only.
    }
    return reciprocalRankFusion([lexical, dense], opts.rrfK ?? 60).slice(0, opts.k ?? 6);
  }
}
