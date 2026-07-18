// ─────────────────────────────────────────────
//  Cascade AI — Retrieval (Phase 1) public surface
// ─────────────────────────────────────────────

export type { Chunk, ScoredChunk, Embedder, VectorStore, SearchOptions } from './types.js';
export { chunkText, type ChunkOptions } from './chunk.js';
export { OpenAICompatibleEmbedder, embedderFromProviders, type OpenAIEmbedderOptions } from './embedder.js';
export { SqliteVectorStore } from './sqlite-store.js';
export { Retriever, reciprocalRankFusion, type RetrieverSearchOptions } from './retriever.js';
