// ─────────────────────────────────────────────
//  Cascade AI — Config Schema (Zod)
// ─────────────────────────────────────────────

import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama']),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  deploymentName: z.string().optional(),
  apiVersion: z.string().optional(),
  model: z.string().optional(),
});

export const ModelOverridesSchema = z.object({
  t1: z.string().optional(),
  t2: z.string().optional(),
  t3: z.string().optional(),
  vision: z.string().optional(),
});

export const McpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

export const WebSearchConfigSchema = z.object({
  /** Base URL of your SearXNG instance (e.g. http://localhost:8080) */
  searxngUrl: z.string().optional(),
  /** Brave Search API key — get one at https://api.search.brave.com */
  braveApiKey: z.string().optional(),
  /** Tavily API key — get one at https://tavily.com */
  tavilyApiKey: z.string().optional(),
  /** Max results per search (default 5) */
  maxResults: z.number().default(5),
});

export const ToolsConfigSchema = z.object({
  shellAllowlist: z.array(z.string()).default([]),
  shellBlocklist: z.array(z.string()).default(['rm -rf', 'sudo rm', 'format', 'mkfs']),
  requireApprovalFor: z.array(z.string()).default([]),
  browserEnabled: z.boolean().default(false),
  mcpServers: z.array(McpServerConfigSchema).optional(),
  /** Web search backends — at least one should be configured for best results */
  webSearch: WebSearchConfigSchema.optional(),
});

export const HookDefinitionSchema = z.object({
  command: z.string(),
  tools: z.array(z.string()).optional(),
  timeout: z.number().optional(),
});

export const HooksConfigSchema = z.object({
  preToolUse: z.array(HookDefinitionSchema).optional(),
  postToolUse: z.array(HookDefinitionSchema).optional(),
  preTask: z.array(HookDefinitionSchema).optional(),
  postTask: z.array(HookDefinitionSchema).optional(),
});

export const DashboardConfigSchema = z.object({
  port: z.number().default(4891),
  auth: z.boolean().default(true),
  teamMode: z.enum(['single', 'multi']).default('single'),
  secret: z.string().optional(),
});

export const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  posthogApiKey: z.string().optional(),
  distinctId: z.string().optional(),
});

export const MemoryConfigSchema = z.object({
  maxSessionMessages: z.number().default(1000),
  autoSummarizeAt: z.number().default(150_000),
  retentionDays: z.number().default(90),
});

export const TierLimitsSchema = z.object({
  t1MaxTokens: z.number().optional(),
  t2MaxTokens: z.number().optional(),
  t3MaxTokens: z.number().optional(),
});

export const BudgetConfigSchema = z.object({
  dailyBudgetUsd:   z.number().optional(),
  sessionBudgetUsd: z.number().optional(),
  warnAtPct:        z.number().default(80),
});

export const WorkspaceConfigSchema = z.object({
  cascadeMdPath: z.string().default('CASCADE.md'),
  configPath: z.string().default('.cascade/config.json'),
  keystorePath: z.string().default('.cascade/keystore.enc'),
  auditLogPath: z.string().default('.cascade/audit.log'),
});

export const CascadeConfigSchema = z.object({
  version: z.literal('1.0').default('1.0'),
  defaultIdentityId: z.string().optional(),
  providers: z.array(ProviderConfigSchema).default([]),
  models: ModelOverridesSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  hooks: HooksConfigSchema.default({}),
  dashboard: DashboardConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  tierLimits: TierLimitsSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  theme: z.string().default('cascade'),
  workspace: WorkspaceConfigSchema.default({}),
  /**
   * Cascade Auto: when true, the TaskAnalyzer selects the optimal model for each
   * tier based on task type and complexity, overriding the static priority lists.
   * Heuristic-first with AI inference fallback (adds ~0–500ms per task).
   */
  cascadeAuto: z.boolean().default(false),
  /**
   * Runtime Tool Creation: when true, T3 workers can generate and register new tools
   * at runtime via the ToolCreator when no existing tool can handle a required operation.
   * Generated tools are session-scoped and sandboxed in node:vm.
   * HTTP calls from generated tools require approval.
   */
  enableToolCreation: z.boolean().default(false),
});

export type CascadeConfigInput = z.input<typeof CascadeConfigSchema>;
