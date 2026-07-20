// ─────────────────────────────────────────────
//  Cascade AI — Package Exports
// ─────────────────────────────────────────────

export { Cascade } from './core/cascade.js';
export { CascadeRouter } from './core/router/index.js';
export { T1Administrator } from './core/tiers/t1-administrator.js';
export { T2Manager } from './core/tiers/t2-manager.js';
export { T3Worker } from './core/tiers/t3-worker.js';

export { runCascade, createCascade, streamCascade } from './sdk/index.js';

export { ConfigManager } from './config/index.js';
export { Keystore } from './config/keystore.js';
export { CascadeIgnore } from './config/ignore.js';
export { MemoryStore } from './memory/store.js';
export { ToolRegistry } from './tools/registry.js';
export { DashboardServer } from './dashboard/server.js';
export { TaskScheduler } from './scheduler/index.js';
export { HooksRunner } from './hooks/index.js';
export { McpClient } from './mcp/client.js';
export {
  Retriever, reciprocalRankFusion, SqliteVectorStore, OpenAICompatibleEmbedder,
  embedderFromProviders, chunkText, LLMReranker, chatCompleterFromProviders,
  parseRankOrder, planRetrieval, chunkCode, heuristicCodeChunker,
  buildManifest, diffManifest, hashContent, WorkspaceIndex, GraphRetriever,
} from './retrieval/index.js';
export type {
  Chunk, ScoredChunk, Embedder, VectorStore, SearchOptions, ChunkOptions,
  RetrieverSearchOptions, OpenAIEmbedderOptions, Reranker, CompleteFn,
  RetrievalMode, RetrievalPlan, RetrievalContext, CodeChunker, CodeChunkOptions,
  FileManifest, ManifestDiff, WorkspaceIndexOptions, RefreshResult,
  GraphFactSource, GraphSearchOptions, RankedFact,
} from './retrieval/index.js';
export { CodeSearchTool } from './tools/code-search.js';
export { GraphSearchTool } from './tools/graph-search.js';
export { AuditLogger } from './audit/log.js';
export { Telemetry } from './telemetry/index.js';

export * from './types.js';
export * from './constants.js';
export { CascadeCancelledError, CascadeToolError } from './utils/retry.js';
export { nodeHttpFetch, preferIpv4Host } from './utils/net.js';

// Native cloud login (CLI + desktop reuse the same client).
export { CloudClient, DEFAULT_CLOUD_URL } from './cloud/client.js';
export type {
  CloudConversation, CloudMessage, DeviceStart, NativeProvider, CloudSessionStore,
} from './cloud/client.js';
export type { CloudSession, CloudUser } from './cloud/session-store.js';
// Key sync: E2E crypto (byte-compatible with the web KeyVault) + bundle helpers.
export { encryptJSON as encryptSyncBlob, decryptJSON as decryptSyncBlob } from './cloud/keysync-crypto.js';
export type { EncryptedBlob } from './cloud/keysync-crypto.js';
export { gatherSyncBundle, applySyncBundle } from './cloud/keysync.js';
export type { SyncBundle } from './cloud/keysync.js';
