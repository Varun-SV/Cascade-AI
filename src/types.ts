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
}

export interface ProviderConfig {
  type: ProviderType;
  label?: string;                 // User-defined label
  apiKey?: string;
  baseUrl?: string;
  deploymentName?: string;        // Azure
  apiVersion?: string;            // Azure
  model?: string;
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
  dependsOn?: string[];
  executionMode?: 'parallel' | 'sequential';
}

export interface StatusUpdate {
  progressPct: number;
  currentAction: string;
  status: 'IN_PROGRESS' | 'BLOCKED' | 'ESCALATING';
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
  | 'SIGNAL_READY';

export interface PeerMessage {
  fromId: string;
  toId: string;             // '*' = broadcast to all peers
  type: 'SYNC_DATA' | 'BARRIER';
  subtaskId: string;
  syncType?: PeerSyncType;
  payload: unknown;
  timestamp: string;
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
}

export interface ModelOverrides {
  t1?: string;
  t2?: string;
  t3?: string;
  vision?: string;
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
  command: string;
  tools?: string[];   // Only run for these tools (empty = all)
  timeout?: number;   // ms
}

export interface DashboardConfig {
  port: number;
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
  warnAtPct: number; // 0-100, default 80
}

export interface WorkspaceConfig {
  cascadeMdPath: string;
  configPath: string;
  keystorePath: string;
  auditLogPath: string;
}

// ── CLI / UI ──────────────────────────────────

export type ThemeName = 'cascade' | 'dark' | 'light' | 'dracula' | 'nord' | 'solarized';

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
  | 'stream:token'
  | 'stream:done'
  | 'tool:approval-request'
  | 'tool:approval-response'
  | 'tool:execute'
  | 'tool:result'
  | 'cost:update'
  | 'session:save'
  | 'escalation'
  | 'peer:sync';

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
  /** Per-tier cost as a percentage of total spend (0–100). */
  costPercentByTier?: Record<string, number>;
}
