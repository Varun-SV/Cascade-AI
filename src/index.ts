// ─────────────────────────────────────────────
//  Cascade AI — Package Exports
// ─────────────────────────────────────────────

export { Cascade } from './core/cascade.js';
export { CascadeRouter } from './core/router/index.js';
export { T1Administrator } from './core/tiers/t1-administrator.js';
export { T2Manager } from './core/tiers/t2-manager.js';
export { T3Worker } from './core/tiers/t3-worker.js';
export * from './core/orchestration/index.js';
export * from './core/verification/index.js';

export { runCascade, createCascade, streamCascade } from './sdk/index.js';

export { ConfigManager, hasUsableProvider, hasProviderCredential, applyProviderApiKey } from './config/index.js';
export {
  applyProviderCredential, applyEndpointEdit, applySettingsCredentials,
  credentialDispositionForEdit, endpointFromSettingsPayload,
  type CredentialEndpoint, type CredentialDisposition,
} from './config/credential-write.js';
// The desktop settings save has to ask "is this the same endpoint?" to decide
// whether a stored key may be kept across an edit. Exported rather than
// reimplemented in app/: a second copy of this rule is how the answer starts
// differing between the surfaces that share the config.
export { sameEndpoint, normalizeEndpoint } from './utils/net.js';
// Provider-aware: absence of a baseUrl means the provider's own public host,
// not "any host". The desktop decides credential scope with this, not with the
// generic string compare above.
export { sameCredentialEndpoint, credentialEndpointIdentity, hasDefaultEndpoint } from './config/endpoint-identity.js';
export { sameAzureEndpoint } from './config/azure-endpoint.js';
export { Keystore } from './config/keystore.js';
export { CascadeIgnore } from './config/ignore.js';
export { MemoryStore } from './memory/store.js';
export { ToolRegistry } from './tools/registry.js';
export { DashboardServer } from './dashboard/server.js';
export { TaskScheduler } from './scheduler/index.js';
export { HooksRunner } from './hooks/index.js';
export { McpClient } from './mcp/client.js';
export {
  McpOAuthProvider, connectMcpWithLoopbackOAuth, FileMcpOAuthStore, fileOAuthProvider,
  beginMcpOAuth, completeMcpOAuth, discoverMcpAuthServer, refreshMcpToken,
} from './mcp/oauth.js';
export type { McpOAuthStore, McpOAuthState, OAuthTokens, OAuthClientInformationMixed } from './mcp/oauth.js';
export { discoverMcpTools } from './mcp/discover.js';
export {
  mcpToolName, mcpServerPrefix, isMcpToolName, MCP_TOOL_PREFIX,
  uniqueMcpServerName, disambiguateMcpServerNames, removeMcpServerDenials,
} from './tools/tool-name.js';
export type { McpServerRename } from './tools/tool-name.js';
export { CurrentPageTool, MAX_PAGE_TEXT_CHARS } from './tools/current-page.js';
export type { CurrentPageProvider, CurrentPageSnapshot } from './tools/current-page.js';
export type { DiscoveredMcpTool, McpDiscoveryResult } from './mcp/discover.js';
export {
  Retriever, reciprocalRankFusion, SqliteVectorStore, OpenAICompatibleEmbedder,
  embedderFromProviders, chunkText, LLMReranker, chatCompleterFromProviders,
  parseRankOrder, planRetrieval, cagCharBudget, CHARS_PER_TOKEN, chunkCode, heuristicCodeChunker,
  buildManifest, diffManifest, hashContent, WorkspaceIndex, GraphRetriever,
} from './retrieval/index.js';
export type {
  Chunk, ScoredChunk, Embedder, VectorStore, SearchOptions, ChunkOptions,
  RetrieverSearchOptions, OpenAIEmbedderOptions, Reranker, CompleteFn,
  RetrievalMode, RetrievalPlan, RetrievalContext, CodeChunker, CodeChunkOptions,
  FileManifest, ManifestDiff, WorkspaceIndexOptions, RefreshResult,
  GraphFactSource, GraphSearchOptions, RankedFact,
} from './retrieval/index.js';
// Document generation. The parser + OOXML renderers are deliberately part of
// the public surface: cloud/web imports the SAME module for its browser-side
// export path, so there is exactly one implementation of "model text → real
// Office binary" rather than two copies free to drift apart.
export {
  parseBlocks, parseDelimited, fileExt, chartKind, parseChartSpec, chartToTableRows,
  matchImageLine, sniffImage, bytesToBase64, stripInline, inlineRuns,
  splitSlides, parseSlide, extractCharts,
  DOCUMENT_MIME, isDocumentFormat, renderDocument, renderDocx, renderPptx, renderXlsx,
} from './core/documents/index.js';
export type {
  Block, ChartKind as DocumentChartKind, ChartSeries, ChartSpec, ImageInfo, ImageRef,
  InlineRun, LoadedImage, Slide, DocumentFormat, ImageByteLoader, RenderOptions,
} from './core/documents/index.js';
export { GenerateDocumentTool, buildDocumentTools } from './tools/generate-document.js';
export type { WorkspaceFileReader } from './tools/generate-document.js';
export { CodeSearchTool } from './tools/code-search.js';
export { GraphSearchTool } from './tools/graph-search.js';
export {
  distillSessionFacts, buildSessionTranscript, sessionWorthRemembering,
  type DistilledFact,
} from './core/knowledge/session-memory.js';
export { AuditLogger } from './audit/log.js';
export { Telemetry } from './telemetry/index.js';

export * from './types.js';
export * from './constants.js';
export { CascadeCancelledError, CascadeToolError } from './utils/retry.js';
export { nodeHttpFetch, preferIpv4Host } from './utils/net.js';

// Azure deployment → ModelInfo (deployment name is the model; carries the
// resolved base model's real context window + economics). Reused by the cloud
// to size the document context budget from the user's actual window.
export { AZURE_BASE_MODELS, azureModelForDeployment, inferAzureBaseModel } from './providers/azure.js';

// Native cloud login (CLI + desktop reuse the same client).
export { CloudClient, DEFAULT_CLOUD_URL } from './cloud/client.js';
export type {
  CloudConversation, CloudMessage, CloudTurnInput, DeviceStart, NativeProvider, CloudSessionStore,
} from './cloud/client.js';
export type { CloudSession, CloudUser } from './cloud/session-store.js';
// Key sync: E2E crypto (byte-compatible with the web KeyVault) + bundle helpers.
export { encryptJSON as encryptSyncBlob, decryptJSON as decryptSyncBlob } from './cloud/keysync-crypto.js';
export type { EncryptedBlob } from './cloud/keysync-crypto.js';
export { gatherSyncBundle, applySyncBundle } from './cloud/keysync.js';
export type { SyncBundle } from './cloud/keysync.js';
