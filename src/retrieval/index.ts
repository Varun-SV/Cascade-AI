// ─────────────────────────────────────────────
//  Cascade AI — Retrieval (Phase 1) public surface
// ─────────────────────────────────────────────

export type { Chunk, ScoredChunk, Embedder, VectorStore, SearchOptions } from './types.js';
export { chunkText, type ChunkOptions } from './chunk.js';
export { OpenAICompatibleEmbedder, embedderFromProviders, type OpenAIEmbedderOptions } from './embedder.js';
export { SqliteVectorStore } from './sqlite-store.js';
export { Retriever, reciprocalRankFusion, type RetrieverSearchOptions } from './retriever.js';
export {
  LLMReranker, chatCompleterFromProviders, parseRankOrder,
  type Reranker, type CompleteFn,
} from './rerank.js';
export { planRetrieval, type RetrievalMode, type RetrievalPlan, type RetrievalContext } from './plan.js';
export { chunkCode, heuristicCodeChunker, type CodeChunker, type CodeChunkOptions } from './code-chunk.js';
export {
  buildManifest, diffManifest, hashContent, type FileManifest, type ManifestDiff,
} from './manifest.js';
export {
  WorkspaceIndex, type WorkspaceIndexOptions, type RefreshResult,
} from './workspace-index.js';
export {
  GraphRetriever, type GraphFactSource, type GraphSearchOptions, type RankedFact,
} from './graph.js';
