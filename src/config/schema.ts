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
  /**
   * Sandbox runtime for LLM-authored dynamic tools:
   * - 'isolate': hard V8 isolate (isolated-vm) — no Node globals, true capability
   *   confinement. Requires the optional native `isolated-vm` dependency.
   * - 'worker': node:worker_threads (resource/kill limits, but not capability-confined).
   * - 'auto' (default): use the isolate when `isolated-vm` loads, else fall back to worker.
   */
  dynamicToolSandbox: z.enum(['isolate', 'worker', 'auto']).default('auto'),
  /**
   * When set, ONLY these tool names are registered — the sole way to omit a
   * built-in tool (shell/file/git/…) from existing at all, rather than just
   * gating it behind approval. Omitted = full default set (unchanged).
   */
  enabledTools: z.array(z.string()).optional(),
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
  // Per-tier sampling temperature (0–2). Applied only to calls that don't set
  // their own temperature — internal deterministic calls (classification,
  // routing) pin temperature: 0 explicitly and are never overridden.
  t1Temperature: z.number().min(0).max(2).optional(),
  t2Temperature: z.number().min(0).max(2).optional(),
  t3Temperature: z.number().min(0).max(2).optional(),
});

export const ExtendedContextConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // 1 = no headroom past the window (compact-to-fit only); 2–3 = allow chunking
  // an input up to N× the window before truncating. Bounded to keep cost sane.
  maxMultiplier: z.number().min(1).max(5).default(2),
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
  debugWorldState: z.boolean().default(false),
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
  extendedContext: ExtendedContextConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  theme: z.string().default('cascade'),
  workspace: WorkspaceConfigSchema.default({}),
  /**
   * Cascade Auto: when true, the TaskAnalyzer selects the optimal model for each
   * tier based on task type and complexity, overriding the static priority lists.
   * Heuristic-first with AI inference fallback (adds ~0–500ms per task).
   * ON by default since v0.19.0 — "Auto" without it was just a static priority
   * list, not the benchmark-value routing the docs describe. Explicit per-tier
   * model pins are unaffected; disable via config/Settings → Advanced.
   */
  cascadeAuto: z.boolean().default(true),
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
   * Generated tools are session-scoped and sandboxed (see tools.dynamicToolSandbox).
   * HTTP calls from generated tools require approval.
   */
  enableToolCreation: z.boolean().default(true),
  /**
   * Project knowledge (world state). `factsExtraction`: after each worker
   * completes, run a cheap extraction pass that distills its output into
   * queryable entity/relation/value facts (superseding older facts), which T1
   * queries during planning instead of replaying the whole linear log. Best-effort
   * and non-blocking; set false to keep only the raw linear log.
   */
  knowledge: z.object({
    factsExtraction: z.boolean().default(true),
  }).default({}),
  /**
   * Persist runtime-generated tools to .cascade/dynamic-tools.json and reload them
   * on startup for cross-run dedup. Reloaded (and peer-received) tools are always
   * treated as UNTRUSTED — their dangerous actions re-escalate. Set false to disable
   * persistence entirely.
   */
  persistDynamicTools: z.boolean().default(true),
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
   * Timeout (ms) for a single cloud LLM call (streaming or not). Guards against
   * a stalled provider stream hanging the whole run with no output. On timeout
   * the call errors and the worker escalates. Default: 2 minutes.
   */
  cloudInferenceTimeoutMs: z.number().int().min(1000).default(120_000),
  /**
   * Timeout (ms) for a tool-approval decision. If no decision arrives in time the
   * request is DENIED (never auto-approved) so the run continues rather than
   * hanging on an unanswered prompt. Default: 10 minutes.
   */
  approvalTimeoutMs: z.number().int().min(1000).default(600_000),
  /**
   * Boardroom plan approval: pause after the plan is produced so the user can
   * review the org chart (sections, workers, estimated cost) before any worker
   * spawns. Scope:
   *   'never'   — never pause (default; no behavior change).
   *   'complex' — pause Complex runs only ('always' is kept as an alias).
   *   'all'     — pause Moderate and Complex runs.
   * Headless/SDK consumers without a listener auto-approve, so pausing is safe
   * outside the TUI.
   */
  planApproval: z.enum(['never', 'complex', 'all', 'always']).default('never'),
  /**
   * Plan-review behaviour for the boardroom gate:
   *   autoReviewer      — a reviewer model critiques the plan (gaps/risks/cost)
   *                       before you see it, and the critique is shown in the dialog.
   *   editable          — allow editing the plan (drop sections) in the dialog.
   *   maxRevisionRounds — how many steering-note → re-plan → re-ask rounds the
   *                       boardroom allows before proceeding with the last plan.
   */
  planReview: z
    .object({
      autoReviewer: z.boolean().default(false),
      editable: z.boolean().default(true),
      maxRevisionRounds: z.number().int().min(1).max(20).default(5),
    })
    .default({}),
  /**
   * Autonomy level. 'manual' (default): plan + tool approvals prompt as usual.
   * 'auto': hands-off — the plan gate auto-approves and the escalator
   * auto-approves NON-dangerous tools, while dangerous tools still escalate and
   * budget caps remain the hard stop. Toggle at runtime with /auto.
   */
  autonomy: z.enum(['manual', 'auto']).default('manual'),
  /**
   * Max corrective re-plan passes T1's reviewer runs before returning the best
   * partial result. The run also stops early when a pass makes no net progress.
   */
  maxReplanPasses: z.number().int().min(0).max(10).default(2),
  /**
   * Reflection / self-critique. When enabled, after a worker's pass/fail self-test
   * succeeds it runs a goal-alignment critique and revises once if the output is
   * weak against the broader goal (not just the subtask spec). Off by default — it
   * adds an LLM call per worker.
   */
  reflection: z
    .object({
      enabled: z.boolean().default(false),
      maxRounds: z.number().int().min(1).max(3).default(1),
    })
    .default({}),
  /**
   * T3 worker execution within a dependency wave:
   *   'auto' (default) — sequential when the T3 tier is a LOCAL model (a single
   *     GPU serializes anyway, so parallel just thrashes the queue), parallel for
   *     cloud models.
   *   'parallel' / 'sequential' — force it.
   */
  t3Execution: z.enum(['auto', 'parallel', 'sequential']).default('auto'),
  /**
   * Per-path privacy tiers. A subtask touching a `local-only` path is forced
   * onto LOCAL models (never cloud) and its raw output is withheld from the
   * tiers above. Patterns use .gitignore syntax, like .cascadeignore.
   */
  privacy: z
    .object({
      paths: z
        .array(z.object({ pattern: z.string().min(1), policy: z.enum(['local-only']) }))
        .default([]),
    })
    .optional(),
  /** Routing controls — forceTier pins the root tier, bypassing the classifier. */
  routing: z
    .object({ forceTier: z.enum(['auto', 'T1', 'T2', 'T3']).default('auto') })
    .optional(),
  /**
   * T3→T2 reinforcement: when enabled, a worker that discovers its subtask should
   * fan out can call the `request_workers` tool to have its T2 manager spawn
   * sibling workers for the new pieces (no 4th tier; bounded). Off by default.
   */
  reinforcements: z
    .object({
      enabled: z.boolean().default(false),
      maxPerSection: z.number().int().min(1).max(20).default(4),
    })
    .default({}),
  /**
   * Render the TUI in the terminal's alternate screen buffer (like vim).
   * Flicker-proof and restores the shell on exit, but native scrollback is
   * unavailable — history scrolls in-app with PgUp/PgDn. Also enabled per
   * session with the --alt-screen flag. Default: off.
   */
  altScreen: z.boolean().default(false),
});

export type CascadeConfigInput = z.input<typeof CascadeConfigSchema>;
