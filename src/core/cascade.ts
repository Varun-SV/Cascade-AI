import EventEmitter from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { glob } from 'glob';
import type {
  ApprovalRequest,
  ApprovalResponse,
  CascadeConfig,
  CascadeRunOptions,
  CascadeRunResult,
  ConversationMessage,
  ImageAttachment,
  PermissionRequest,
  StreamChunk,
  TaskComplexity,
  TierRole,
  T3Result
} from '../types.js';
import { CascadeRouter } from './router/index.js';
import { T1Administrator, type PlanApprovalDecision, type TaskPlan } from './tiers/t1-administrator.js';
import { calculateCost } from '../utils/cost.js';
import { T2Manager } from './tiers/t2-manager.js';
import { T3Worker } from './tiers/t3-worker.js';
import { ToolRegistry } from '../tools/registry.js';
import { McpClient } from '../mcp/client.js';
import { AuditLogger } from '../audit/log.js';
import { MemoryStore } from '../memory/store.js';
import { PermissionEscalator } from './permissions/escalator.js';
import { validateConfig } from '../config/validate.js';
import { Telemetry, noopTelemetry } from '../telemetry/index.js';
import { TaskAnalyzer } from './router/task-analyzer.js';
import { ModelPerformanceTracker } from './router/model-performance-tracker.js';
import { benchmarkScore01 } from './router/benchmarks.js';
import { ToolCreator } from '../tools/tool-creator.js';
import { CascadeCancelledError } from '../utils/retry.js';

/** One entry in the per-run orchestration decision trail (see /why). */
export interface DecisionLogEntry {
  at: string;
  kind: 'complexity' | 'model' | 'failover' | 'escalation';
  detail: string;
}

export class Cascade extends EventEmitter {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private mcpClient: McpClient;
  private config: CascadeConfig;
  /** Orchestration decisions for the CURRENT run — cleared on each run(). */
  private decisionLog: DecisionLogEntry[] = [];
  private initialized = false;
  /** Last task that stopped at the budget cap — powers /continue (resumeRun). */
  private lastInterruptedRun?: { prompt: string; partialOutput: string; taskId: string };
  private initPromise?: Promise<void>;
  private store?: MemoryStore;
  private audit?: AuditLogger;
  private telemetry: Pick<Telemetry, 'capture' | 'shutdown'>;
  private taskAnalyzer?: TaskAnalyzer;
  private perfTracker?: ModelPerformanceTracker;
  private toolCreator?: ToolCreator;
  private workspacePath: string;

  constructor(config: CascadeConfig, workspacePath: string, store?: MemoryStore) {
    super();
    // Validate config eagerly so users get a clear error at startup, not at run time
    this.config = validateConfig(config) as CascadeConfig;
    this.workspacePath = workspacePath;
    this.store = store;
    this.router = new CascadeRouter();
    this.mcpClient = new McpClient({
      trustedServers: this.config.tools.mcpTrusted,
      approvalCallback: async (server) => {
        // Surface as a generic permission event so REPL / dashboard / SDK
        // consumers can all plug the same approval dialog in.
        return await this.requestMcpApproval(server);
      },
      // Route warnings through the event stream when anyone is listening —
      // a raw console write while the TUI is live corrupts Ink's frame.
      onWarn: (message) => {
        if (this.listenerCount('log') > 0) this.emit('log', { level: 'warn', message });
        else console.warn(message);
      },
    });
    this.toolRegistry = new ToolRegistry(this.config.tools, workspacePath);
    this.telemetry = config.telemetry?.enabled
      ? new Telemetry(config.telemetry, config.telemetry.distinctId ?? 'anonymous')
      : noopTelemetry;
  }

  private initOptionalFeatures(): void {
    if (this.config.cascadeAuto === true) {
      this.perfTracker = new ModelPerformanceTracker();
      void this.perfTracker.load(); // non-blocking; stats available before first run completes
      this.taskAnalyzer = new TaskAnalyzer(this.perfTracker, this.config.autoBias ?? 'balanced');
      // Share the analyzer with the router so workers can route each subtask to
      // the benchmark-best model for its type.
      this.router.setTaskAnalyzer(this.taskAnalyzer);
    }
    const cfg = this.config as unknown as Record<string, unknown>;
    if (cfg['enableToolCreation'] === true) {
      this.toolCreator = new ToolCreator(this.router, this.toolRegistry, this.workspacePath);
      this.toolCreator.setLogger((m) => {
        if (this.listenerCount('log') > 0) this.emit('log', { level: 'info', message: m });
      });
    }
  }

  setStore(store: MemoryStore): void {
    this.store = store;
  }

  /**
   * Emit an `mcp:approval-required` event and wait up to 30 s for a listener
   * to resolve it via `cascade.resolveMcpApproval(serverName, approved)`.
   *
   * If no listener is attached (e.g. a non-interactive SDK run), the default
   * is to reject — safer than silently spawning an arbitrary subprocess.
   */
  private pendingMcpApprovals: Map<string, (approved: boolean) => void> = new Map();

  private async requestMcpApproval(server: { name: string; command: string; args?: string[] }): Promise<boolean> {
    // No listeners → reject. Callers can add a listener BEFORE init() runs
    // when they need to approve servers programmatically.
    if (this.listenerCount('mcp:approval-required') === 0) {
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      this.pendingMcpApprovals.set(server.name, resolve);
      const timeout = setTimeout(() => {
        if (this.pendingMcpApprovals.delete(server.name)) resolve(false);
      }, 30_000);
      // If the caller resolves, also clear the timeout.
      const wrap = (approved: boolean) => {
        clearTimeout(timeout);
        resolve(approved);
      };
      this.pendingMcpApprovals.set(server.name, wrap);
      this.emit('mcp:approval-required', { server });
    });
  }

  private recordDecision(kind: DecisionLogEntry['kind'], detail: string): void {
    this.decisionLog.push({ at: new Date().toISOString(), kind, detail });
  }

  /**
   * The orchestration decision trail for the most recent run: complexity
   * verdict (and why), which model served each tier, failovers, and
   * escalations. Powers the /why command.
   */
  getDecisionLog(): DecisionLogEntry[] {
    return [...this.decisionLog];
  }

  /** Resolve a pending MCP server approval from a REPL / dashboard listener. */
  resolveMcpApproval(serverName: string, approved: boolean): void {
    const resolver = this.pendingMcpApprovals.get(serverName);
    if (resolver) {
      this.pendingMcpApprovals.delete(serverName);
      resolver(approved);
    }
  }

  // ── Boardroom plan approval ─────────────────────────────────────────
  // Same gate pattern as MCP approvals, with the opposite default: plans
  // are work the user asked for, so no listener (SDK/headless) or a
  // timeout means PROCEED, not reject.

  private pendingPlanApproval?: (decision: PlanApprovalDecision) => void;

  private async requestPlanApproval(plan: TaskPlan, taskId: string, critique?: string, summary?: string): Promise<PlanApprovalDecision> {
    // Autonomous mode: skip the boardroom wait and proceed.
    if (this.config.autonomy === 'auto') {
      return { approved: true };
    }
    if (this.listenerCount('plan:approval-required') === 0) {
      return { approved: true };
    }
    const t2Count = plan.sections.length;
    const t3Count = plan.sections.reduce((sum, s) => sum + (s.t3Subtasks?.length ?? 0), 0);
    return await new Promise<PlanApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pendingPlanApproval) {
          this.pendingPlanApproval = undefined;
          resolve({ approved: true });
        }
      }, 120_000);
      this.pendingPlanApproval = (decision) => {
        clearTimeout(timeout);
        this.pendingPlanApproval = undefined;
        resolve(decision);
      };
      this.emit('plan:approval-required', {
        taskId,
        plan,
        t2Count,
        t3Count,
        estCostUsd: this.estimatePlanCost(plan),
        critique,
        summary,
      });
    });
  }

  /**
   * Resolve a pending boardroom plan approval from a REPL / dashboard listener.
   * An optional `note` re-plans and re-asks; an optional `editedPlan` is applied
   * directly (no re-decompose).
   */
  resolvePlanApproval(approved: boolean, note?: string, editedPlan?: TaskPlan): void {
    this.pendingPlanApproval?.({ approved, note, editedPlan });
  }

  /**
   * Autonomy control (used by the /auto command). 'auto' makes the next run
   * hands-off: the plan gate auto-approves and non-dangerous tools auto-approve,
   * while dangerous tools still escalate and budget caps remain the hard stop.
   */
  setAutonomy(mode: 'manual' | 'auto'): void {
    this.config = { ...this.config, autonomy: mode };
  }

  getAutonomy(): 'manual' | 'auto' {
    return this.config.autonomy === 'auto' ? 'auto' : 'manual';
  }

  /**
   * Preview T1's decomposition for a prompt WITHOUT executing it (powers /plan).
   * Idempotent init guard, so it works before the first run.
   */
  async previewPlan(prompt: string): Promise<TaskPlan> {
    await this.init();
    const t1 = new T1Administrator(this.router, this.toolRegistry, this.config);
    if (this.store) t1.setStore(this.store);
    return t1.previewPlan(prompt);
  }

  /** True when a task stopped at the budget cap and can be resumed via /continue. */
  hasResumableRun(): boolean {
    return this.lastInterruptedRun != null;
  }

  /**
   * Raise the per-run token budget for a resume and return the continuation
   * prompt (or null when nothing is resumable). Consumes the interrupted-run
   * state. The REPL submits the returned prompt through its normal flow so the
   * resumed run renders like any other; `resumeRun` wraps this for SDK callers.
   */
  prepareResume(opts: { maxTokens?: number } = {}): string | null {
    const last = this.lastInterruptedRun;
    if (!last) return null;
    this.lastInterruptedRun = undefined; // consume it

    const raised = opts.maxTokens ?? Math.round((this.config.budget?.maxTokensPerRun ?? 200_000) * 2);
    this.config = { ...this.config, budget: { ...this.config.budget, maxTokensPerRun: raised } };
    this.router.setMaxTokensPerRun(raised);

    return (
      'Continue and FINISH this task. A previous attempt was interrupted before completion; ' +
      'any files already created are on disk — build on them, do NOT recreate them. Complete only the remaining work.\n\n' +
      `Original task: ${last.prompt}` +
      (last.partialOutput ? `\n\nPartial result so far:\n${last.partialOutput}` : '')
    );
  }

  /**
   * Resume the last budget-capped task with a raised budget (SDK/headless).
   * Returns null when there is nothing to resume.
   */
  async resumeRun(opts: { maxTokens?: number } = {}): Promise<CascadeRunResult | null> {
    const prompt = this.prepareResume(opts);
    if (!prompt) return null;
    return this.run({ prompt });
  }

  /**
   * Rough pre-execution cost estimate for a plan: ~3 T2 calls per section
   * plus ~4 T3 calls per subtask at typical token volumes. A ballpark for
   * the approval dialog, not an invoice — always label it "est."
   */
  private estimatePlanCost(plan: TaskPlan): number {
    const T2_CALLS_PER_SECTION = 3;
    const T3_CALLS_PER_SUBTASK = 4;
    const IN_TOKENS = 1500;
    const OUT_TOKENS = 700;
    const t2Model = this.router.getTierModel('T2');
    const t3Model = this.router.getTierModel('T3');
    let est = 0;
    for (const section of plan.sections) {
      if (t2Model) est += T2_CALLS_PER_SECTION * calculateCost(IN_TOKENS, OUT_TOKENS, t2Model);
      const subtasks = section.t3Subtasks?.length ?? 1;
      if (t3Model) est += subtasks * T3_CALLS_PER_SUBTASK * calculateCost(IN_TOKENS, OUT_TOKENS, t3Model);
    }
    return est;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    // Concurrent callers (e.g. the REPL eagerly calls init() and the first
    // run() also awaits init()) must share the SAME init promise. Otherwise
    // the MCP client would open duplicate connections and budget:warning
    // would be registered twice, causing double-emission.
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.router.init(this.config);

      // Bubble budget:warning events from the router up to Cascade consumers
      this.router.on('budget:warning', (payload: {
        spentUsd: number;
        capUsd: number;
        spendPct: number;
        warnAtPct: number;
        remainingUsd: number;
      }) => {
        this.emit('budget:warning', payload);
      });

      // Record provider failovers in the per-run decision trail (/why).
      this.router.on('failover', (e: { tier: string; from: string; to: string; reason: string }) => {
        this.recordDecision('failover', `${e.tier} ${e.from} → ${e.to} (${e.reason})`);
      });

      // Budget hard-kill: cancel any pending user approvals and notify
      // consumers so the REPL/dashboard can tear down gracefully instead
      // of waiting for an approval that will never resolve.
      this.router.on('budget:exceeded', (payload: { reason: string; spentUsd: number }) => {
        this.emit('budget:exceeded', payload);
        for (const [name, resolver] of this.pendingMcpApprovals) {
          resolver(false);
          this.pendingMcpApprovals.delete(name);
        }
      });

      // Initialize MCP servers
      if (this.config.tools.mcpServers?.length) {
        for (const server of this.config.tools.mcpServers) {
          try {
            await this.mcpClient.connect(server);
            this.toolRegistry.registerMcpTools(this.mcpClient);
          } catch (err) {
            console.error(`Failed to connect to MCP server "${server.name}":`, err);
          }
        }
      }

      // Load external plugins declared in config.plugins
      const pluginPaths = (this.config as unknown as Record<string, unknown>)['plugins'] as string[] | undefined;
      if (pluginPaths?.length) {
        for (const pluginPath of pluginPaths) {
          try {
            const mod = await import(pluginPath);
            const plugin = (mod.default ?? mod) as import('../tools/registry.js').ToolPlugin;
            if (plugin && Array.isArray(plugin.tools)) {
              this.toolRegistry.registerPlugin(plugin);
            } else {
              console.warn(`[cascade] Plugin "${pluginPath}" does not export a valid ToolPlugin.`);
            }
          } catch (err) {
            console.warn(`[cascade] Failed to load plugin "${pluginPath}":`, err);
          }
        }
      }

      // Model specialization profiling (cascadeAuto mode) — non-blocking
      if (this.config.cascadeAuto && this.store) {
        this.router.profileModels(this.store).catch(() => { /* non-fatal */ });
      }

      // Cascade Auto live data: validate model ids against each provider and
      // fetch current public benchmark scores + prices. Background, non-blocking
      // — the bundled catalog/benchmarks are used until (or unless) it lands.
      if (this.config.cascadeAuto) {
        this.router.refreshLiveData().catch(() => { /* non-fatal */ });
      }

      this.initOptionalFeatures();
      // Re-register tools created in previous runs so identical capabilities
      // aren't generated again from scratch.
      if (this.toolCreator) await this.toolCreator.loadPersistedTools();
      this.initialized = true;
    })();

    try {
      await this.initPromise;
    } catch (err) {
      // Allow a retry after a failed init.
      this.initPromise = undefined;
      throw err;
    }
  }

  private isCasualGreeting(prompt: string): boolean {
    const casual = /^(hi|hello|hey|greetings|thanks|thank you|thx|bye|goodbye|cya)$/i.test(prompt.trim().replace(/[!?.]+$/, ''));
    return casual;
  }

  private looksLikeSimpleArtifactTask(prompt: string): boolean {
    return /create .*\.(txt|md|json|csv)\b/i.test(prompt)
      && !/(research|compare|thorough|pdf|report|analy[sz]e|architecture|multi-agent)/i.test(prompt);
  }

  private looksLikeConversational(prompt: string): boolean {
    const LOW_COMPLEXITY = [
      /^(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|sounds good)\b/i,
      /^(?:what is|what are|list|show me|tell me|who is|where is|when is|how do i)\b/i,
      /\b(?:simple|quick|brief|small|single|one-line|typo|rename)\b/i,
    ];
    const wordCount = prompt.trim().split(/\s+/).length;
    return wordCount <= 12 && LOW_COMPLEXITY.some(re => re.test(prompt.trim()));
  }

  /**
   * Read-only inquiries about existing content ("read / review / explain /
   * summarize / analyze this file or codebase and tell me …") are single-agent
   * work — one worker with file/grep tools answers directly, no T1→T2→T3 fan-out.
   * They must NOT ask to create, build, implement, refactor, or save an artifact;
   * those stay on the heavier classifier path. This keeps trivial "what does this
   * do?" requests from being mis-routed into a multi-agent, multi-thousand-token run.
   */
  private looksLikeReadOnlyInquiry(prompt: string): boolean {
    const p = prompt.trim();
    const inquiry = /\b(?:read|review|explain|describe|summari[sz]e|analy[sz]e|assess|evaluate|inspect|examine|explore|go through|look at|tell me about|what (?:is|are|does|do)|is it|understand|novelty|novel idea)\b/i.test(p);
    const producesArtifact = /\b(?:create|build|implement|generate|write|refactor|rewrite|add|fix|deploy|install|migrate|scaffold|set up|save (?:a|the)|report|\.(?:pdf|md|txt|json|csv|py|js|ts|tsx|jsx|html|docx?))\b/i.test(p);
    return inquiry && !producesArtifact;
  }

  // Cache glob scan results per workspace path to avoid repeated I/O.
  private static globCache = new Map<string, { count: number; expiresAt: number }>();

  private async countWorkspaceFiles(workspacePath: string): Promise<number> {
    const now = Date.now();
    const cached = Cascade.globCache.get(workspacePath);
    if (cached && cached.expiresAt > now) return cached.count;
    try {
      const files = await glob('**/*.*', {
        cwd: workspacePath,
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
        nodir: true,
      });
      Cascade.globCache.set(workspacePath, { count: files.length, expiresAt: now + 30_000 });
      return files.length;
    } catch {
      return 0;
    }
  }

  private async determineComplexity(
    prompt: string,
    workspacePath: string,
    conversationHistory: ConversationMessage[] = [],
  ): Promise<TaskComplexity> {
    if (this.isCasualGreeting(prompt)) {
      this.recordDecision('complexity', 'Simple — heuristic: casual greeting (no classifier call)');
      return 'Simple';
    }
    if (this.looksLikeSimpleArtifactTask(prompt)) {
      this.recordDecision('complexity', 'Simple — heuristic: single-file artifact task (no classifier call)');
      return 'Simple';
    }
    if (this.looksLikeConversational(prompt)) {
      this.recordDecision('complexity', 'Simple — heuristic: short conversational message (no classifier call)');
      return 'Simple';
    }
    if (this.looksLikeReadOnlyInquiry(prompt)) {
      this.recordDecision('complexity', 'Simple — heuristic: read-only inquiry over existing content (single agent, no classifier call)');
      return 'Simple';
    }

    // Quick workspace scout (cached for 30s)
    let workspaceContext = '';
    try {
      const count = await this.countWorkspaceFiles(workspacePath);
      workspaceContext = `Workspace Scout: Found ~${count} source files in the project.`;
    } catch {
      workspaceContext = 'Workspace Scout: Could not scan workspace.';
    }

    const sysPrompt = `You are a routing classifier for a hierarchical AI system. Determine task complexity using BOTH the latest user message and the recent conversation context.

${workspaceContext}

Classification:
- "Simple": basic conversation, direct single-step work, or small troubleshooting
- "Moderate": requires a few steps, some tool use, or a manager coordinating workers
- "Complex": requires planning, multiple agents/sections, file artifact production, verification, research, or substantial implementation

Important rules:
- Treat short follow-ups like "proceed", "continue", "do it", "yes" as referring to the recent context.
- If the earlier context is complex, keep the inherited complexity unless the user clearly narrows scope.
- Reading, explaining, summarizing, or analyzing existing files/code and answering a question — WITHOUT creating files or implementing changes — is "Simple" (single agent), never "Complex".
- If the task asks for a simple single-file artifact like hello.txt, it is usually Moderate.
- If the task asks for a saved report, PDF, implementation, or deeper verification workflow, it is at least Moderate and often Complex.

Respond with the verdict word first, then a dash and a short reason (under 12 words).
Format: <Simple|Moderate|Complex> — <reason>`;

    const recentHistory = conversationHistory.slice(-6);
    const contextBlock = recentHistory.map((message, index) => {
      const content = typeof message.content === 'string'
        ? message.content
        : message.content.map((block) => block.type === 'text' ? block.text : '[non-text]').join(' ');
      return `${index + 1}. ${message.role}: ${content}`;
    }).join('\n');

    const routedPrompt = contextBlock
      ? `Recent conversation:
${contextBlock}\n\nLatest user message:
${prompt}`
      : prompt;

    try {
      const result = await this.router.generate('T1', {
        messages: [{ role: 'user', content: routedPrompt }],
        systemPrompt: sysPrompt,
        maxTokens: 40,
        temperature: 0,
      });
      const content = result.content.trim();
      // Verdict is the FIRST word only — the reason text after the dash may
      // legitimately mention other levels ("not complex enough for ...").
      const firstWord = (content.split(/[\s—–-]+/)[0] ?? '').toLowerCase();
      const reason = content.replace(/^\S+\s*[—–-]*\s*/, '').trim();
      const verdict: TaskComplexity = firstWord.includes('simple')
        ? 'Simple'
        : firstWord.includes('moderate') ? 'Moderate' : 'Complex';
      this.recordDecision('complexity', `${verdict} — classifier: ${reason || 'no reason given'}`);
      return verdict;
    } catch {
      const followUpPrompt = /^(proceed|continue|go ahead|do it|yes|yep|ok|okay|carry on)$/i.test(prompt.trim());
      if (followUpPrompt && recentHistory.length > 0) {
        this.recordDecision('complexity', 'Complex — classifier unavailable; short follow-up inherits prior context');
        return 'Complex';
      }
      // A transient classifier failure must not silently route every task into
      // the most expensive full-hierarchy path — default to Moderate instead.
      this.recordDecision('complexity', 'Moderate — classifier unavailable; defaulting to the mid-cost route');
      return 'Moderate';
    }
  }

  async run(options: CascadeRunOptions): Promise<CascadeRunResult> {
    await this.init();
    // Reset the per-task budget allowance so this run starts with a fresh ceiling.
    this.router.beginRun();
    // Wire the abort signal into the router so a cancel aborts in-flight LLM
    // calls (not just the checkpoints between them) — i.e. near-instant cancel.
    this.router.setRunSignal(options.signal);
    const startMs = Date.now();
    const taskId = randomUUID();
    this.decisionLog = [];

    // Create a fresh permission escalator for this task run
    const escalator = new PermissionEscalator(this.config.approvalTimeoutMs ?? 600_000, this.config.autonomy === 'auto');

    // Wire escalator's user-required event → approvalCallback or direct event
    escalator.on('permission:user-required', async (req: PermissionRequest) => {
      this.emit('permission:user-required', req);
      this.recordDecision('escalation', `"${req.toolName}" by ${req.requestedBy} — T2 and T1 both unsure, escalated to user`);

      // Build enriched context for the approval callback / REPL
      const enrichedRequest: ApprovalRequest & { escalationContext?: unknown } = {
        id: req.id,
        tierId: req.requestedBy,
        toolName: req.toolName,
        input: req.input,
        description: `T3 Worker "${req.subtaskContext}" wants to run "${req.toolName}". T2 and T1 could not determine if this is safe.`,
        isDangerous: req.isDangerous,
        escalationContext: {
          requestedBy: req.requestedBy,
          parentT2Id: req.parentT2Id,
          subtaskContext: req.subtaskContext,
          sectionContext: req.sectionContext,
          taskContext: req.taskContext,
        },
      };

      let approved = false;
      let always = false;

      if (options.approvalCallback) {
        const result = await options.approvalCallback(enrichedRequest);
        if (typeof result === 'boolean') {
          approved = result;
        } else {
          approved = result.approved;
          always = result.always;
        }
      }

      escalator.resolveUserDecision(req.id, approved, always);
    });

    // 1. Determine complexity
    const complexity = await this.determineComplexity(options.prompt, options.workspacePath || process.cwd(), options.conversationHistory);

    this.telemetry.capture('cascade:session_start', {
      complexity,
      providerCount: this.config.providers.length,
      cascadeAutoEnabled: this.config.cascadeAuto === true,
      toolCreationEnabled: (this.config as unknown as Record<string, unknown>)['enableToolCreation'] === true,
    });

    this.emit('tier:root', { role: complexity === 'Simple' ? 'T3' : complexity === 'Moderate' ? 'T2' : 'T1' });

    const tiersInPlay: TierRole[] = complexity === 'Simple' ? ['T3'] : complexity === 'Moderate' ? ['T2', 'T3'] : ['T1', 'T2', 'T3'];

    // Cascade Auto: select optimal models for each tier based on task analysis
    if (this.taskAnalyzer) {
      await Promise.all(tiersInPlay.map(async (tier) => {
        // Respect an explicitly-configured model — Cascade Auto only routes
        // tiers the user left on 'auto' (otherwise it would silently switch the
        // configured model, which /why then surfaces).
        const tierKey = tier.toLowerCase() as 't1' | 't2' | 't3';
        if (this.config.models?.[tierKey]) return;
        try {
          const model = await this.taskAnalyzer!.selectModel(options.prompt, tier, this.router.getSelector());
          if (model) {
            this.router.overrideTierModel(tier, model);
            const taskType = this.taskAnalyzer!.getLastProfile()?.type ?? 'mixed';
            const bench = Math.round(benchmarkScore01(model, taskType) * 100);
            const price = model.inputCostPer1kTokens === 0 && model.outputCostPer1kTokens === 0
              ? 'free'
              : `$${model.outputCostPer1kTokens.toFixed(4)}/1K out`;
            const dataSrc = this.router.getLiveData()?.getDataSource() ?? 'bundled';
            this.recordDecision(
              'model',
              `${tier} → ${model.provider}:${model.id} — Cascade Auto: best value for ${taskType} ` +
              `(bench ${bench}/100, ${price}, data: ${dataSrc})`,
            );
          }
        } catch { /* non-critical — fall back to priority list */ }
      }));
    }

    // Record what model actually serves each tier in play.
    this.recordDecision('model', tiersInPlay.map((tier) => {
      const m = this.router.getTierModel(tier);
      return m ? `${tier} ${m.provider}:${m.id}${m.isLocal ? ' ⌂local' : ''}` : `${tier} (none)`;
    }).join('  ·  '));

    // Register ToolCreator with the T3 instances (done below, passed via closure)
    const toolCreator = this.toolCreator;
    if (toolCreator) toolCreator.setPermissionEscalator(escalator);

    let finalOutput = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let t2Results: any[] = [];
    let runError: unknown = null;

    // ── Fetch Identity System Prompt ────────────
    let identityPrompt = '';
    if (this.store) {
      const identityId = options.identityId || this.config.defaultIdentityId;
      if (identityId) {
        const identities = this.store.listIdentities();
        const identity = identities.find(i => i.id === identityId);
        if (identity?.systemPrompt) {
          identityPrompt = identity.systemPrompt + '\n\n';
        }
      }
    }

    // Helper to bind standard events to any tier
    type TierEventSource = EventEmitter & {
      on(event: 'stream:token', listener: (event: { text: string }) => void): TierEventSource;
      on(event: 'log', listener: (event: unknown) => void): TierEventSource;
      on(event: 'tier:status', listener: (event: unknown) => void): TierEventSource;
      on(
        event: 'tool:approval-request',
        listener: (
          request: ApprovalRequest & {
            __cascadeResponder?: (decision: { approved: boolean; always?: boolean }) => void;
          },
        ) => void,
      ): TierEventSource;
    };

    const bindTierEvents = (tier: TierEventSource) => {
      tier.on('stream:token', (e) => {
        this.emit('stream:token', e);
        options.streamCallback?.({ text: e.text, finishReason: null });
      });
      tier.on('log', (e) => this.emit('log', e));
      tier.on('tier:status', (e) => this.emit('tier:status', e));
      tier.on('tool:call', (e) => this.emit('tool:call', e));
      tier.on('tool:result', (e) => this.emit('tool:result', e));
      // Legacy approval events (for tiers not yet wired to escalator)
      tier.on('tool:approval-request', async (request: ApprovalRequest & { __cascadeResponder?: (decision: { approved: boolean; always?: boolean }) => void }) => {
        this.emit('tool:approval-request', request);
        let decision: { approved: boolean; always?: boolean } = { approved: false };
        if (options.approvalCallback) {
          const result = await options.approvalCallback(request);
          if (typeof result === 'boolean') {
            decision = { approved: result };
          } else {
            decision = result;
          }
        }
        if (typeof request.__cascadeResponder === 'function') {
          request.__cascadeResponder(decision);
        } else {
          tier.emit(`tool:approval-response:${request.id}`, { id: request.id, ...decision } as ApprovalResponse);
        }
      });
    };

    try {
    if (complexity === 'Simple') {
      const t3 = new T3Worker(this.router, this.toolRegistry, 'root');
      t3.setHierarchyContext('You are the DIRECT worker for this task. There is no T1 Administrator or T2 Manager involved in this run.');
      if (identityPrompt) {
        t3.setSystemPromptOverride(identityPrompt);
      }
      if (this.store) {
        t3.setStore(this.store, taskId);
      }
      t3.setPermissionEscalator(escalator);
      if (toolCreator) t3.setToolCreator(toolCreator);
      bindTierEvents(t3);
      const assignment = {
        subtaskId: taskId,
        subtaskTitle: 'Direct Request',
        description: options.prompt,
        expectedOutput: 'A complete and direct answer.',
        constraints: [],
        peerT3Ids: [],
        parentT2: 'root'
      };
      const t3Result = await t3.execute(assignment, taskId, options.signal);
      finalOutput = typeof t3Result.output === 'string' ? t3Result.output : JSON.stringify(t3Result.output);
      this.emit('tier:status', { tierId: 't3-root', status: 'COMPLETED', role: 'T3' });
    } else if (complexity === 'Moderate') {
      const t2 = new T2Manager(this.router, this.toolRegistry, 'root');
      t2.setHierarchyContext('You are the ROOT Manager for this task. There is no T1 Administrator involved in this run. You are responsible for decomposing the task and managing T3 workers directly.');
      if (identityPrompt) {
        t2.setSystemPromptOverride(identityPrompt);
      }
      if (this.store) {
        t2.setStore(this.store);
      }
      t2.setPermissionEscalator(escalator);
      if (toolCreator) t2.setToolCreator(toolCreator);
      t2.setPeerMessageCallback((e) => this.emit('peer:message', e), options.sessionId ?? '');
      bindTierEvents(t2);
      // Boardroom gate for Moderate (root-T2) runs when planApproval is 'all':
      // review the decomposed subtasks before any worker spawns.
      if (this.config.planApproval === 'all') {
        t2.setPlanApprovalCallback(async (subtasks) => {
          const pseudoPlan = {
            complexity: 'Moderate',
            reasoning: '',
            sections: subtasks.map((st) => ({
              sectionId: st.subtaskId,
              sectionTitle: st.subtaskTitle,
              description: st.description,
              t3Subtasks: [],
            })),
          } as unknown as TaskPlan;
          const n = subtasks.length;
          const summary = `${n} worker${n !== 1 ? 's' : ''} · 1 root manager · est. $${this.estimatePlanCost(pseudoPlan).toFixed(4)}`;
          const decision = await this.requestPlanApproval(pseudoPlan, taskId, undefined, summary);
          const keepSubtaskIds = decision.editedPlan?.sections
            ?.map((s) => (s as { sectionId?: string }).sectionId)
            .filter((id): id is string => Boolean(id));
          return { approved: decision.approved, note: decision.note, keepSubtaskIds };
        });
      }
      const assignment = {
        sectionId: taskId,
        sectionTitle: 'Direct Task',
        description: options.prompt,
        expectedOutput: 'A complete resolution of the task.',
        constraints: [],
        t3Subtasks: []
      };
      const t2Result = await t2.execute(assignment, taskId, options.signal);
      this.emit('tier:status', { tierId: 't2-root', status: 'COMPLETED', role: 'T2' });
      t2Results = [t2Result];
      const completed = t2Result.t3Results.filter((r: T3Result) => r.status === 'COMPLETED');
      if (completed.length > 0) {
        finalOutput = t2Result.sectionSummary + '\n\n' + completed.map((r: T3Result) => r.output).join('\n\n');
      } else {
        finalOutput = 'Task failed to complete successfully.';
      }
    } else {
      const t1 = new T1Administrator(this.router, this.toolRegistry, this.config);
      t1.setHierarchyContext('You are the top-level Administrator. You are responsible for the overall plan and supervising multiple T2 Managers.');
      if (identityPrompt) {
        t1.setSystemPromptOverride(identityPrompt);
      }
      if (this.store) {
        t1.setStore(this.store);
      }
      t1.setPermissionEscalator(escalator);
      if (toolCreator) t1.setToolCreator(toolCreator);
      t1.setPeerMessageCallback((e) => this.emit('peer:message', e), options.sessionId ?? '');
      bindTierEvents(t1);
      t1.on('plan', (e) => this.emit('plan', e));
      // Gate Complex runs for 'complex' | 'all' | 'always' (anything but 'never').
      if (this.config.planApproval != null && this.config.planApproval !== 'never') {
        t1.setPlanApprovalCallback(async (plan, meta) => {
          const decision = await this.requestPlanApproval(plan, taskId, meta?.critique);
          this.recordDecision('escalation', decision.approved
            ? `Boardroom: plan approved (${plan.sections.length} sections)${decision.note ? ' with a steering note' : ''}${decision.editedPlan ? ' (edited)' : ''}`
            : 'Boardroom: plan rejected — run stopped before any T2 spawned');
          return decision;
        });
      }
      
      const result = await t1.execute(options.prompt, options.images, undefined, options.signal);
      finalOutput = result.output;
      t2Results = result.t2Results;
    }
    } catch (err) {
      // ── Graceful cancellation handling ──────────────────────────────
      // When aborted, don't re-throw — resolve with what we have so far. This
      // covers both the checkpoint-based CascadeCancelledError and the
      // AbortError thrown by a provider whose in-flight request was aborted
      // (instant cancel), plus any error surfacing while the signal is aborted.
      if (err instanceof CascadeCancelledError
        || (err instanceof Error && err.name === 'AbortError')
        || options.signal?.aborted) {
        this.emit('run:cancelled', {
          taskId,
          reason: err instanceof Error ? err.message : 'Task cancelled',
          partialOutput: finalOutput || '',
        });
        runError = null; // suppress telemetry error flag for intentional cancels
      } else if (err instanceof Error && err.name === 'BudgetExceededError') {
        // Per-task (or session) budget ceiling hit — stop gracefully with a
        // clear message instead of letting a runaway task throw to the user.
        this.emit('run:budget-exceeded', {
          taskId,
          reason: err.message,
          partialOutput: finalOutput || '',
        });
        // Remember the interrupted task so /continue can resume it with a raised
        // budget (files already created persist on disk via snapshots).
        this.lastInterruptedRun = { prompt: options.prompt, partialOutput: finalOutput || '', taskId };
        if (!finalOutput) finalOutput = `⚠ Stopped to avoid runaway cost: ${err.message}`;
        runError = null;
      } else {
        runError = err;
        throw err;
      }
    } finally {
      // Always release pending permission escalations so they don't leak
      // across runs — even on error paths. cancelAllPending is safe to call
      // when there are no pending requests.
      try { escalator.cancelAllPending(); } catch { /* non-critical */ }

      // Restore tier models to the configured baseline so Cascade Auto's
      // per-task picks don't leak into /why, the status bar, or the next run.
      this.router.restoreTierModels();
      this.router.setRunSignal(undefined);

      // Record model performance for future auto-selection
      if (this.taskAnalyzer) {
        try {
          const stats = this.router.getStats();
          this.taskAnalyzer.recordRunOutcome(runError ? 'failure' : 'success', stats.costByTier);
        } catch { /* non-critical */ }
      }

      // Always emit telemetry for completion (or failure) so dashboards
      // don't silently drop failed runs.
      try {
        const stats = this.router.getStats();
        const durationMs = Date.now() - startMs;
        this.telemetry.capture(runError ? 'cascade:task_failed' : 'cascade:task_complete', {
          complexity,
          tier: complexity === 'Simple' ? 'simple' : complexity === 'Moderate' ? 'T2' : 'T1',
          durationMs,
          tokenCount: stats.totalTokens,
          costUsd: stats.totalCostUsd,
          t2Count: t2Results.length,
          t3Count: t2Results.reduce((sum: number, r: { t3Results?: unknown[] }) => sum + (r.t3Results?.length ?? 0), 0),
          errored: runError ? true : false,
          errorMessage: runError instanceof Error ? runError.message : undefined,
        });
      } catch { /* telemetry must never block task results */ }
    }

    const stats = this.router.getStats();
    const durationMs = Date.now() - startMs;

    return {
      output: finalOutput,
      sessionId: options.sessionId ?? '',
      taskId,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: stats.totalTokens,
        estimatedCostUsd: stats.totalCostUsd,
      },
      t2Results,
      durationMs,
      costByTier: stats.costByTier,
      tokensByTier: stats.tokensByTier,
      costPercentByTier: this.router.getTierCostPercentages(),
    };
  }

  getRouter(): CascadeRouter {
    return this.router;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Tear down MCP connections and flush any pending telemetry so long-lived
   * hosts (REPL, SDK embedders) don't leak child processes. Safe to call
   * multiple times.
   */
  async close(): Promise<void> {
    try { await this.mcpClient.disconnectAll(); } catch { /* non-critical */ }
    try {
      const maybeShutdown = (this.telemetry as Pick<Telemetry, 'shutdown'>)?.shutdown;
      if (typeof maybeShutdown === 'function') await maybeShutdown.call(this.telemetry);
    } catch { /* non-critical */ }
  }
}
