// ─────────────────────────────────────────────
//  Cascade AI — Retrieval types (Phase 1)
// ─────────────────────────────────────────────
//
// The retrieval core is deliberately provider- and store-agnostic: an Embedder
// turns text into vectors, a VectorStore holds them and answers lexical + dense
// queries, and a Retriever fuses the two into a ranked result. Cloud, desktop,
// and CLI inject different Embedders into the same core.

/** A unit of indexed text. `sourceId` groups chunks from one document/file. */
export interface Chunk {
  id: string;
  text: string;
  sourceId: string;
  /** Order of this chunk within its source (0-based). */
  ord: number;
  meta?: Record<string, unknown>;
}

/** A chunk with a relevance score (higher = more relevant). */
export interface ScoredChunk extends Chunk {
  score: number;
}

/** Turns text into embedding vectors. Implementations wrap a provider API or a
 *  local model. `model` + `dims` are recorded with every vector so a future
 *  model change forces a clean re-index rather than silent quality rot. */
export interface Embedder {
  readonly model: string;
  /** Vector dimension. 0 until the first embed call resolves it. */
  readonly dims: number;
  /** Embed a batch of texts → one vector per input (same order). */
  embed(texts: string[]): Promise<number[][]>;
}

export interface SearchOptions {
  namespace: string;
  k?: number;
  /** Restrict results to these source ids (e.g. the docs attached to a run). */
  sourceIds?: string[];
}

/** Persists chunk vectors and answers the two first-stage queries of hybrid
 *  retrieval. The Phase-1 implementation is SQLite-backed (BLOB vectors +
 *  FTS5), swappable later for a dedicated ANN index behind this interface. */
export interface VectorStore {
  upsert(records: Array<{ chunk: Chunk; vector: number[] }>, embedModel: string): void;
  /** True once this source has chunks for the given embed model (skip re-embed). */
  hasSource(namespace: string, sourceId: string, embedModel: string): boolean;
  lexicalSearch(query: string, opts: SearchOptions): ScoredChunk[];
  denseSearch(queryVector: number[], opts: SearchOptions): ScoredChunk[];
  deleteSource(namespace: string, sourceId: string): void;
}
