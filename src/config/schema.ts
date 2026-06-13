// ─────────────────────────────────────────────
//  Cascade AI — Config Schema (Zod)
// ─────────────────────────────────────────────

import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama']),
  label: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  deploymentName: z.string().optional(),
  apiVersion: z.string().optional(),
  model: z.string().optional(),
  authToken: z.string().optional(),
  credentialSource: z.string().optional(),
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
  mcpTrusted: z.array(z.string()).optional(),
  /** Web search backends — at least one should be configured for best results */
  webSearch: WebSearchConfigSchema.optional(),
});

export const HookDefinitionSchema = z.object({
  name: z.string().optional(),
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
  /**
   * Interface to bind the dashboard HTTP/WebSocket server to. Defaults to
   * loopback so the dashboard — which exposes /api/run (arbitrary task
   * execution) and config mutation — is never reachable from the network
   * unless the operator explicitly opts in (e.g. "0.0.0.0" for team mode).
   */
  host: z.string().default('127.0.0.1'),
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
  /**
   * Hard per-task token ceiling. A single `cascade run` is stopped once its
   * combined token usage crosses this, so a mis-routed trivial task can never
   * fan out into a runaway multi-agent burn. Resets every run. Raise it for
   * genuinely large jobs. Defaults to 200k.
   */
  maxTokensPerRun:  z.number().int().positive().default(200_000),
  /** Optional hard per-task cost ceiling (USD). Unset = only the token cap applies. */
  maxCostPerRunUsd: z.number().positive().optional(),
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
   * Cascade Auto trade-off bias when picking a model for a task:
   *   - 'balanced' (default): quality × cost-efficiency — cheap models win
   *     trivial tasks, strong models win hard ones.
   *   - 'quality': pick the highest-benchmark model; cost only breaks ties.
   *   - 'cost': pick the cheapest model that clears a per-task quality floor.
   */
  autoBias: z.enum(['balanced', 'quality', 'cost']).default('balanced'),
  /**
   * Public-benchmark data source for Cascade Auto. All fields have safe
   * defaults so zero config "just works" — live data is fetched in the
   * background and the bundled snapshot is used until it arrives (or offline).
   */
  benchmarks: z
    .object({
      /** Fetch current quality scores from a public source. Default: true. */
      live: z.boolean().default(true),
      /** How long a fetched snapshot stays fresh before re-fetching (hours). */
      refreshHours: z.number().min(0).default(24),
      /**
       * Override the quality-benchmark source URL (must return the snapshot
       * JSON shape). When unset, the maintained GitHub-raw snapshot is used.
       */
      sourceUrl: z.string().url().optional(),
      /** Fetch current per-token prices from OpenRouter (free, no key). */
      pricingLive: z.boolean().default(true),
    })
    .default({}),
  /**
   * Runtime Tool Creation: when true, T3 workers can generate and register new tools
   * at runtime via the ToolCreator when no existing tool can handle a required operation.
   * Generated tools are session-scoped and sandboxed in node:vm.
   * HTTP calls from generated tools require approval.
   */
  enableToolCreation: z.boolean().default(true),
  /**
   * External plugin paths or npm package names to load at startup.
   * Each entry must export a default ToolPlugin object.
   * Example: ["./plugins/my-tool.js", "cascade-plugin-slack"]
   */
  plugins: z.array(z.string()).default([]),
  /**
   * Maximum number of concurrent inference requests to any local model provider
   * (e.g. Ollama). Defaults to 1 to prevent GPU memory pressure when multiple
   * T3 workers run in parallel on a single-GPU machine.
   */
  localConcurrency: z.number().int().min(1).default(1),
  /**
   * Timeout in milliseconds for a single local model inference call.
   * Local models can take minutes for large parameter counts. Default: 5 minutes.
   */
  localInferenceTimeoutMs: z.number().int().min(1000).default(300_000),
  /**
   * Boardroom plan approval: when 'always', Complex tasks pause after T1
   * produces its plan so the user can approve the org chart (sections,
   * workers, estimated cost) before any T2 manager spawns. Headless/SDK
   * consumers without a listener auto-approve, so 'always' is still safe
   * outside the TUI. Default: 'never' (no behavior change).
   */
  planApproval: z.enum(['always', 'never']).default('never'),
  /**
   * Render the TUI in the terminal's alternate screen buffer (like vim).
   * Flicker-proof and restores the shell on exit, but native scrollback is
   * unavailable — history scrolls in-app with PgUp/PgDn. Also enabled per
   * session with the --alt-screen flag. Default: off.
   */
  altScreen: z.boolean().default(false),
});

export type CascadeConfigInput = z.input<typeof CascadeConfigSchema>;
