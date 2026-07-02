// ─────────────────────────────────────────────
//  Cascade AI — Core Type Definitions
// ─────────────────────────────────────────────

// ── Provider ──────────────────────────────────

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'azure'
  | 'openai-compatible'
  | 'ollama';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
  contextWindow: number;
  isVisionCapable: boolean;
  inputCostPer1kTokens: number;   // USD
  outputCostPer1kTokens: number;  // USD
  maxOutputTokens: number;
  supportsStreaming: boolean;
  isLocal: boolean;
  minSizeB?: number;              // For local models: param count in billions
  /** Tool-use capability. False for Ollama; true for all cloud providers. */
  supportsToolUse?: boolean;
  /** Self-declared or API-sourced specialization categories. */
  specializations?: string[];
}

export interface ProviderConfig {
  type: ProviderType;
  label?: string;                 // User-defined label
  apiKey?: string;
  baseUrl?: string;
  deploymentName?: string;        // Azure
  apiVersion?: string;            // Azure
  model?: string;
  /**
   * OAuth bearer token (e.g. a Claude Code subscription token) used instead
   * of an API key. When set on an Anthropic provider, the request uses
   * `Authorization: Bearer` + the oauth beta header rather than `x-api-key`.
   */
  authToken?: string;
  /** Where an adopted credential came from, e.g. "Claude Code". Informational. */
  credentialSource?: string;
}

export interface StreamChunk {
  text: string;
  finishReason?: 'stop' | 'length' | 'tool_use' | null;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface GenerateOptions {
  messages: ConversationMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  images?: ImageAttachment[];
  stream?: boolean;
  /** Abort signal — when it fires, the provider aborts the in-flight request (instant cancel). */
  signal?: AbortSignal;
  /**
   * Per-call model override. When set, this exact model is used for the call
   * instead of the tier's default — lets Cascade Auto route each subtask to the
   * best model for its type without disturbing the shared per-tier model that
   * concurrent workers rely on. Ignored when a vision model is required.
   */
  model?: ModelInfo;
  /** Name/tag of the current sub-feature (e.g. T2 section title) for cost accounting. */
  featureTag?: string;
  /**
   * Privacy-tier constraint: when set, the call must resolve to a LOCAL model
   * (never a cloud provider). The router errors if no local model is available
   * rather than silently falling back to cloud.
   */
  forceLocal?: boolean;
}

export interface GenerateResult {
  content: string;
  usage: TokenUsage;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'length' | 'tool_use';
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | MessageContent[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
  name?: string;
}

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; image: ImageAttachment }
  | { type: 'tool_result'; toolCallId: string; content: string };

export interface ImageAttachment {
  type: 'base64' | 'url';
  data: string;         // base64 string or URL
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

// ── Tools ─────────────────────────────────────

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface WebSearchConfig {
  searxngUrl?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
  maxResults?: number;
}
// ... (omitted lines for brevity, but I will provide full replacement in a moment)

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system';
  content: string;
  timestamp: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError: boolean;
}

export interface ToolExecuteOptions {
  tierId: string;
  sessionId: string;
  requireApproval: boolean;
  saveSnapshot?: (filePath: string, content: string) => Promise<void>;
  sendPeerSync?: (
    to: string,
    syncType: PeerSyncType,
    content: string | Record<string, unknown>,
  ) => void;
  getPeerMessages?: () => Array<{ fromId: string; content: unknown; timestamp: string }>;
}

// ── Tier System ───────────────────────────────

export type TierRole = 'T1' | 'T2' | 'T3';
export type TierStatus = 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';

export type TaskComplexity = 'Simple' | 'Moderate' | 'Complex' | 'Highly Complex';

export interface TierConfig {
  role: TierRole;
  id: string;
  model: ModelInfo;
  parentId?: string;
}

// ── Inter-tier Messages (JSON Schema v1.0) ────

export type MessageType =
  | 'TASK_ASSIGNMENT'
  | 'STATUS_UPDATE'
  | 'RESULT'
  | 'ESCALATION'
  | 'PEER_SYNC';

export type MessageStatus =
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'ESCALATING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'ESCALATED';

export interface CascadeMessage {
  version: '1.0';
  from: string;
  to: string;
  type: MessageType;
  taskId: string;
  timestamp: string;  // ISO 8601
  payload: MessagePayload;
}

export type MessagePayload =
  | T1ToT2Assignment
  | T2ToT3Assignment
  | StatusUpdate
  | T2Result
  | T3Result
  | EscalationPayload
  | PeerSyncPayload;

export interface T1ToT2Assignment {
  sectionId: string;
  sectionTitle: string;
  description: string;
  expectedOutput: string;
  constraints: string[];
  t3Subtasks: T3SubtaskSpec[];
  executionMode?: 'parallel' | 'sequential';
  dependsOn?: string[];
  peerT2Ids?: string[];
}

export interface T3SubtaskSpec {
  subtaskId: string;
  subtaskTitle: string;
  description: string;
  expectedOutput: string;
  constraints: string[];
  peerT3Ids: string[];
  dependsOn?: string[];
  executionMode?: 'parallel' | 'sequential';
}

export interface T2ToT3Assignment {
  subtaskId: string;
  subtaskTitle: string;
  description: string;
  expectedOutput: string;
  constraints: string[];
  peerT3Ids: string[];
  parentT2: string;
  sectionTitle?: string;
  dependsOn?: string[];
  executionMode?: 'parallel' | 'sequential';
}

export interface StatusUpdate {
  progressPct: number;
  currentAction: string;
  status: 'IN_PROGRESS' | 'BLOCKED' | 'ESCALATING';
  output?: string;
}

export interface T2Result {
  sectionId: string;
  sectionTitle: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'ESCALATED';
  t3Results: T3Result[];
  sectionSummary: string;
  issues: string[];
}

export interface T3ResultPayload {
  subtaskId: string;
  status: 'COMPLETED' | 'FAILED' | 'ESCALATED';
  output: string | Record<string, unknown>;
  testResults: {
    checksRun: string[];
    passed: string[];
    failed: string[];
  };
  issues: string[];
  peerSyncsUsed: string[];
  correctionAttempts: number;
  /** True when the subtask matched a privacy.paths local-only pattern — its raw output must be withheld from upper tiers. */
  localOnly?: boolean;
  /** Sibling workers this T3 asked its T2 to spawn (T3→T2 reinforcement request). */
  reinforcements?: T2ToT3Assignment[];
}

export interface T3Result extends T3ResultPayload { }

export interface EscalationPayload {
  raisedBy: string;
  sectionId?: string;
  subtaskId?: string;
  attempted: string[];
  blocker: string;
  needs: string;
}

export interface PeerSyncPayload {
  senderT3Id: string;
  recipientT3Id: string;
  syncType: PeerSyncType;
  content: string | Record<string, unknown>;
  subtaskId?: string;
}

export type PeerSyncType =
  | 'SHARE_OUTPUT'
  | 'RESOLVE_CONFLICT'
  | 'DIVIDE_WORK'
  | 'CHECK_ASSUMPTION'
  | 'SIGNAL_READY'
  // Broadcast when a worker generates a new runtime tool, so peers register it
  // instead of re-creating the same capability.
  | 'TOOL_CREATED'
  // File-lock and barrier traffic — surfaced so UIs can visualize how the
  // agents coordinate, not just what they hand each other.
  | 'COORDINATION';

export interface PeerMessage {
  fromId: string;
  toId: string;             // '*' = broadcast to all peers
  type: 'SYNC_DATA' | 'BARRIER';
  subtaskId: string;
  syncType?: PeerSyncType;
  payload: unknown;
  timestamp: string;
}

export interface PeerMessageEvent {
  fromId: string;
  toId?: string;          // undefined = broadcast to all peers
  syncType: PeerSyncType;
  payload?: string;
  timestamp: string;
  sessionId: string;
}

// ── Session & Memory ──────────────────────────

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  identityId: string;
  workspacePath: string;
  messages: StoredMessage[];
  metadata: SessionMetadata;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  tokens?: TokenUsage;
  agentMessages?: CascadeMessage[];
}

export interface SessionMetadata {
  totalTokens: number;
  totalCostUsd: number;
  modelsUsed: string[];
  toolsUsed: string[];
  taskCount: number;
  branch?: string;
  checkpoint?: SessionCheckpoint;
}

export interface RuntimeSession {
  sessionId: string;
  title: string;
  workspacePath: string;
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  updatedAt: string;
  latestPrompt?: string;
  isGlobal?: boolean;
}

export interface RuntimeNode {
  tierId: string;
  sessionId: string;
  parentId?: string;
  role: TierRole;
  label: string;
  status: TierStatus;
  currentAction?: string;
  progressPct?: number;
  updatedAt: string;
  workspacePath?: string;
  isGlobal?: boolean;
  output?: string;
}

export interface RuntimeNodeLog {
  id: string;
  sessionId: string;
  tierId: string;
  role: TierRole;
  label: string;
  status: TierStatus;
  currentAction?: string;
  progressPct?: number;
  timestamp: string;
  workspacePath?: string;
  isGlobal?: boolean;
  output?: string;
}

export type RuntimeScope = 'workspace' | 'global';

export interface RuntimeSnapshotPayload {
  scope?: RuntimeScope;
  source?: string;
  fetchedAt?: string;
  sessions: RuntimeSession[];
  nodes: RuntimeNode[];
  logs: RuntimeNodeLog[];
}

export interface RuntimeRefreshPayload {
  scope: RuntimeScope;
}

export interface SessionSubscriptionPayload {
  sessionId: string;
}

export interface PermissionDecisionPayload extends PermissionDecision {}

export interface SessionCheckpoint {
  taskId: string;
  timestamp: string;
  state: Record<string, unknown>;
}

export interface Identity {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  createdAt: string;
  defaultModel?: string;
  systemPrompt?: string;
  isDefault: boolean;
}

// ── Config ────────────────────────────────────

export interface CascadeConfig {
  version: '1.0';
  defaultIdentityId?: string;
  providers: ProviderConfig[];
  models: ModelOverrides;
  tools: ToolsConfig;
  hooks: HooksConfig;
  dashboard: DashboardConfig;
  telemetry: TelemetryConfig;
  memory: MemoryConfig;
  tierLimits: TierLimits;
  budget: BudgetConfig;
  theme: string;
  workspace: WorkspaceConfig;
  cascadeAuto?: boolean;
  /** Cascade Auto trade-off bias when picking a model. Default: 'balanced'. */
  autoBias?: 'balanced' | 'quality' | 'cost';
  /** Public-benchmark data source settings for Cascade Auto. */
  benchmarks?: BenchmarksConfig;
  enableToolCreation?: boolean;
  /** Persist runtime-generated tools and reload them on startup (untrusted). Default: true. */
  persistDynamicTools?: boolean;
  plugins?: string[];
  localConcurrency?: number;
  localInferenceTimeoutMs?: number;
  /** Timeout (ms) for a single cloud LLM call (streaming or not). Default: 120000. */
  cloudInferenceTimeoutMs?: number;
  /** Timeout (ms) for a tool-approval decision; denies (never auto-approves) on timeout. Default: 600000. */
  approvalTimeoutMs?: number;
  /**
   * Pause for user approval of the plan. 'never' (default), 'complex' (Complex
   * runs only; 'always' is an alias), or 'all' (Moderate + Complex).
   */
  planApproval?: 'never' | 'complex' | 'all' | 'always';
  /** Plan-review behaviour for the boardroom gate. */
  planReview?: PlanReviewConfig;
  /** Autonomy level: 'manual' (default, prompts) or 'auto' (hands-off within guardrails). */
  autonomy?: 'manual' | 'auto';
  /** Max corrective re-plan passes before T1 returns the best partial. Default: 2. */
  maxReplanPasses?: number;
  /** Reflection / self-critique: goal-alignment critique + revise after self-test. Off by default. */
  reflection?: { enabled?: boolean; maxRounds?: number };
  /** T3 wave execution: 'auto' (sequential for local, parallel for cloud), or force one. Default: 'auto'. */
  t3Execution?: 'auto' | 'parallel' | 'sequential';
  /** T3→T2 reinforcement: let a worker ask its manager to spawn sibling workers. Off by default. */
  reinforcements?: { enabled?: boolean; maxPerSection?: number };
  /**
   * Per-path privacy tiers. Paths matching a `local-only` pattern force the
   * subtask onto LOCAL models and withhold raw output from the tiers above
   * (T1/T2 see only success/fail). Patterns use .gitignore syntax, like
   * .cascadeignore.
   */
  privacy?: { paths?: Array<{ pattern: string; policy: 'local-only' }> };
  /** Render the TUI in the alternate screen buffer (vim-style). Default: false. */
  altScreen?: boolean;
}

export interface PlanReviewConfig {
  /** A reviewer model critiques the plan (gaps/risks/cost) before you see it. Default: false. */
  autoReviewer?: boolean;
  /** Allow editing the plan (drop sections) in the approval dialog. Default: true. */
  editable?: boolean;
  /** Steering-note → re-plan → re-ask rounds allowed before proceeding. Default: 5. */
  maxRevisionRounds?: number;
}

export interface ModelOverrides {
  t1?: string;
  t2?: string;
  t3?: string;
  vision?: string;
}

export interface BenchmarksConfig {
  /** Fetch current quality scores from a public source. Default: true. */
  live?: boolean;
  /** How long a fetched snapshot stays fresh before re-fetching (hours). Default: 24. */
  refreshHours?: number;
  /** Override the quality-benchmark source URL. When unset, the bundled GitHub-raw snapshot is used. */
  sourceUrl?: string;
  /** Fetch current per-token prices from OpenRouter (free, no key). Default: true. */
  pricingLive?: boolean;
}

export interface ToolsConfig {
  shellAllowlist: string[];
  shellBlocklist: string[];
  requireApprovalFor: string[];
  browserEnabled: boolean;
  mcpServers?: McpServerConfig[];
  /**
   * Names of MCP servers (matching McpServerConfig.name) that the user has
   * explicitly trusted. Servers not in this list require interactive
   * approval before they are spawned.
   */
  mcpTrusted?: string[];
  /** Web search backends — at least one should be configured for best results */
  webSearch?: WebSearchConfig;
}

export interface HooksConfig {
  preToolUse?: HookDefinition[];
  postToolUse?: HookDefinition[];
  preTask?: HookDefinition[];
  postTask?: HookDefinition[];
}

export interface HookDefinition {
  name?: string;
  command: string;
  tools?: string[];   // Only run for these tools (empty = all)
  timeout?: number;   // ms
}

export interface DashboardConfig {
  port: number;
  host: string;       // interface to bind to; defaults to 127.0.0.1 (loopback)
  auth: boolean;
  teamMode: 'single' | 'multi';
  secret?: string;    // JWT secret
}

export interface TelemetryConfig {
  enabled: boolean;
  posthogApiKey?: string;
  distinctId?: string;
}

export interface MemoryConfig {
  maxSessionMessages: number;
  autoSummarizeAt: number;   // token threshold
  retentionDays: number;
}

export interface TierLimits {
  t1MaxTokens?: number;
  t2MaxTokens?: number;
  t3MaxTokens?: number;
}

export interface BudgetConfig {
  dailyBudgetUsd?: number;
  sessionBudgetUsd?: number;
  /** Hard per-task token ceiling. Resets each run. Default 200k. */
  maxTokensPerRun?: number;
  /** Optional hard per-task cost ceiling (USD). */
  maxCostPerRunUsd?: number;
  warnAtPct: number; // 0-100, default 80
}

export interface WorkspaceConfig {
  cascadeMdPath: string;
  configPath: string;
  keystorePath: string;
  auditLogPath: string;
  debugWorldState?: boolean;
}

// ── CLI / UI ──────────────────────────────────

export type CascadeThemeName = 'midnight' | 'aurora' | 'ember' | 'tide' | 'bloom' | 'daybreak';
export type LegacyThemeName = 'cascade' | 'dark' | 'light' | 'dracula' | 'nord' | 'solarized';
export type ThemeName = CascadeThemeName | LegacyThemeName;

export interface Theme {
  name: ThemeName;
  colors: ThemeColors;
}

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  muted: string;
  background: string;
  foreground: string;
  border: string;
  t1Color: string;
  t2Color: string;
  t3Color: string;
}

// ── Events ────────────────────────────────────

export type CascadeEventType =
  | 'task:start'
  | 'task:complete'
  | 'task:error'
  | 'tier:status'
  | 'tier:result'
  | 'tier:root'
  | 'stream:token'
  | 'stream:done'
  | 'tool:approval-request'
  | 'tool:approval-response'
  | 'tool:execute'
  | 'tool:result'
  | 'tool:call'
  | 'cost:update'
  | 'session:save'
  | 'escalation'
  | 'peer:sync'
  | 'peer:message'
  | 'plan'
  | 'log'
  | 'run:cancelled'
  | 'budget:warning'
  | 'budget:exceeded'
  | 'permission:user-required'
  | 'mcp:approval-required'
  | 'plan:approval-required';

export interface CascadeEvent<T = unknown> {
  type: CascadeEventType;
  taskId?: string;
  tierId?: string;
  data: T;
  timestamp: string;
}

export interface ApprovalRequest {
  id: string;
  tierId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  isDangerous: boolean;
}

export interface ApprovalResponse {
  id: string;
  approved: boolean;
  always?: boolean;
}

// ── Hierarchical Permission Escalation ────────

/**
 * A permission request raised by a T3 worker that must be evaluated
 * by T2, then T1, and finally the user if neither tier can decide.
 */
export interface PermissionRequest {
  /** Unique request ID */
  id: string;
  /** T3 worker that requires the permission */
  requestedBy: string;
  /** T2 manager that owns this T3 worker */
  parentT2Id: string;
  /** Tool being requested */
  toolName: string;
  /** Tool input arguments */
  input: Record<string, unknown>;
  /** Whether the tool is flagged as dangerous */
  isDangerous: boolean;
  /** What the T3 subtask is trying to accomplish */
  subtaskContext: string;
  /** What the parent T2 section's goal is */
  sectionContext: string;
  /** What T1's overall task goal is (injected when escalated to T1) */
  taskContext?: string;
  /**
   * When true, bypass the session approval cache so this request always reaches
   * a fresh decision. Set for UNTRUSTED runtime tools (loaded from disk or
   * received from a peer) so a prior `always` approval cannot silently
   * auto-approve a later dangerous action.
   */
  forceReprompt?: boolean;
}

/**
 * A decision made at any tier (T2, T1, or USER) about a PermissionRequest.
 */
export interface PermissionDecision {
  /** ID of the PermissionRequest this responds to */
  requestId: string;
  /** Whether the tool call is approved */
  approved: boolean;
  /**
   * If true, cache this decision for the session so the same tool
   * is not asked about again (section-wide scope for T2, task-wide for T1).
   */
  always?: boolean;
  /** Which tier made the decision */
  decidedBy: 'T2' | 'T1' | 'USER';
  /** Optional explanation from the evaluating tier */
  reasoning?: string;
}

// ── Audit ─────────────────────────────────────

export interface AuditEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  tierId: string;
  action: 'tool_call' | 'file_change' | 'agent_decision' | 'approval' | 'escalation' | 'error';
  details: Record<string, unknown>;
}

// ── Scheduler ─────────────────────────────────

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string;
  prompt: string;
  identityId?: string;
  workspacePath?: string;
  createdAt: string;
  lastRun?: string;
  nextRun?: string;
  enabled: boolean;
}

// ── Notifications ─────────────────────────────

export interface WebhookConfig {
  url: string;
  events: CascadeEventType[];
  secret?: string;
  headers?: Record<string, string>;
}

// ── SDK ───────────────────────────────────────

export interface CascadeRunOptions {
  prompt: string;
  images?: ImageAttachment[];
  workspacePath?: string;
  identityId?: string;
  sessionId?: string;
  conversationHistory?: ConversationMessage[];
  streamCallback?: (chunk: StreamChunk) => void;
  approvalCallback?: (request: ApprovalRequest) => Promise<boolean | { approved: boolean; always: boolean }>;
  /**
   * An optional `AbortSignal` to cancel the run mid-execution.
   * When aborted, all tiers (T1 → T2 → T3) stop at the next safe checkpoint
   * and a `run:cancelled` event is emitted on the Cascade instance.
   * The `run()` call resolves (not rejects) with a partial result.
   *
   * @example
   * const controller = new AbortController();
   * cascade.run({ prompt: '...', signal: controller.signal });
   * // later:
   * controller.abort();
   */
  signal?: AbortSignal;
}

export interface CascadeRunResult {
  output: string;
  sessionId: string;
  taskId: string;
  usage: TokenUsage;
  t2Results: T2Result[];
  durationMs: number;
  /** Per-tier cost breakdown (USD). Available when the router tracked stats. */
  costByTier?: Record<string, number>;
  /** Per-tier total token counts. Available when the router tracked stats. */
  tokensByTier?: Record<string, number>;
  /** Per-feature (T2 section) cost breakdown (USD) — "what did this feature cost?". */
  costByFeature?: Record<string, number>;
  /** Per-tier cost as a percentage of total spend (0–100). */
  costPercentByTier?: Record<string, number>;
}
