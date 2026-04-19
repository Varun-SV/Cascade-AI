import EventEmitter from 'node:events';
import { randomUUID } from 'node:crypto';
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
import { T1Administrator } from './tiers/t1-administrator.js';
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
import { ToolCreator } from '../tools/tool-creator.js';
import { CascadeCancelledError } from '../utils/retry.js';

export class Cascade extends EventEmitter {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private mcpClient: McpClient;
  private config: CascadeConfig;
  private initialized = false;
  private initPromise?: Promise<void>;
  private store?: MemoryStore;
  private audit?: AuditLogger;
  private telemetry: Pick<Telemetry, 'capture' | 'shutdown'>;
  private taskAnalyzer?: TaskAnalyzer;
  private toolCreator?: ToolCreator;

  constructor(config: CascadeConfig, workspacePath: string, store?: MemoryStore) {
    super();
    // Validate config eagerly so users get a clear error at startup, not at run time
    this.config = validateConfig(config) as CascadeConfig;
    this.store = store;
    this.router = new CascadeRouter();
    this.mcpClient = new McpClient({
      trustedServers: this.config.tools.mcpTrusted,
      approvalCallback: async (server) => {
        // Surface as a generic permission event so REPL / dashboard / SDK
        // consumers can all plug the same approval dialog in.
        return await this.requestMcpApproval(server);
      },
    });
    this.toolRegistry = new ToolRegistry(this.config.tools, workspacePath);
    this.telemetry = config.telemetry?.enabled
      ? new Telemetry(config.telemetry, config.telemetry.distinctId ?? 'anonymous')
      : noopTelemetry;
  }

  private initOptionalFeatures(): void {
    const cfg = this.config as unknown as Record<string, unknown>;
    if (cfg['cascadeAuto'] === true) {
      this.taskAnalyzer = new TaskAnalyzer(this.router);
    }
    if (cfg['enableToolCreation'] === true) {
      this.toolCreator = new ToolCreator(this.router, this.toolRegistry);
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

  /** Resolve a pending MCP server approval from a REPL / dashboard listener. */
  resolveMcpApproval(serverName: string, approved: boolean): void {
    const resolver = this.pendingMcpApprovals.get(serverName);
    if (resolver) {
      this.pendingMcpApprovals.delete(serverName);
      resolver(approved);
    }
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

      this.initOptionalFeatures();
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

  private looksLikeSimpleArtifactTask(prompt: string): boolean {
    return /create .*\.(txt|md|json|csv)\b/i.test(prompt)
      && !/(research|compare|thorough|pdf|report|analy[sz]e|architecture|multi-agent)/i.test(prompt);
  }

  private async determineComplexity(
    prompt: string,
    conversationHistory: ConversationMessage[] = [],
  ): Promise<TaskComplexity> {
    if (this.looksLikeSimpleArtifactTask(prompt)) {
      return 'Simple';
    }

    const sysPrompt = `You are a routing classifier for a hierarchical AI system. Determine task complexity using BOTH the latest user message and the recent conversation context.

Classification:
- "Simple": basic conversation, direct single-step work, or small troubleshooting
- "Moderate": requires a few steps, some tool use, or a manager coordinating workers
- "Complex": requires planning, multiple agents/sections, file artifact production, verification, research, or substantial implementation

Important rules:
- Treat short follow-ups like "proceed", "continue", "do it", "yes" as referring to the recent context.
- If the earlier context is complex, keep the inherited complexity unless the user clearly narrows scope.
- If the task asks for a simple single-file artifact like hello.txt, it is usually Moderate.
- If the task asks for a saved report, PDF, implementation, or deeper verification workflow, it is at least Moderate and often Complex.

Respond with exactly one word: Simple, Moderate, or Complex.`;

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
        maxTokens: 8,
        temperature: 0,
      });
      const content = result.content.trim().toLowerCase();
      if (content.includes('simple')) return 'Simple';
      if (content.includes('moderate')) return 'Moderate';
      return 'Complex';
    } catch {
      const followUpPrompt = /^(proceed|continue|go ahead|do it|yes|yep|ok|okay|carry on)$/i.test(prompt.trim());
      if (followUpPrompt && recentHistory.length > 0) return 'Complex';
      return 'Complex';
    }
  }

  async run(options: CascadeRunOptions): Promise<CascadeRunResult> {
    await this.init();
    const startMs = Date.now();
    const taskId = randomUUID();

    // Create a fresh permission escalator for this task run
    const escalator = new PermissionEscalator();

    // Wire escalator's user-required event → approvalCallback or direct event
    escalator.on('permission:user-required', async (req: PermissionRequest) => {
      this.emit('permission:user-required', req);

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
    const complexity = await this.determineComplexity(options.prompt, options.conversationHistory);

    this.telemetry.capture('cascade:session_start', {
      complexity,
      providerCount: this.config.providers.length,
      cascadeAutoEnabled: (this.config as unknown as Record<string, unknown>)['cascadeAuto'] === true,
      toolCreationEnabled: (this.config as unknown as Record<string, unknown>)['enableToolCreation'] === true,
    });

    this.emit('tier:root', { role: complexity === 'Simple' ? 'T3' : complexity === 'Moderate' ? 'T2' : 'T1' });

    // Cascade Auto: select optimal models for each tier based on task analysis
    if (this.taskAnalyzer) {
      const tiers: TierRole[] = complexity === 'Simple' ? ['T3'] : complexity === 'Moderate' ? ['T2', 'T3'] : ['T1', 'T2', 'T3'];
      await Promise.all(tiers.map(async (tier) => {
        try {
          const model = await this.taskAnalyzer!.selectModel(options.prompt, tier, this.router.getSelector());
          if (model) this.router.overrideTierModel(tier, model);
        } catch { /* non-critical — fall back to priority list */ }
      }));
    }

    // Register ToolCreator with the T3 instances (done below, passed via closure)
    const toolCreator = this.toolCreator;

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
      bindTierEvents(t2);
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
      bindTierEvents(t1);
      t1.on('plan', (e) => this.emit('plan', e));
      
      const result = await t1.execute(options.prompt, options.images, undefined, options.signal);
      finalOutput = result.output;
      t2Results = result.t2Results;
    }
    } catch (err) {
      // ── Graceful cancellation handling ──────────────────────────────
      // When aborted, don't re-throw — resolve with what we have so far.
      if (err instanceof CascadeCancelledError) {
        this.emit('run:cancelled', {
          taskId,
          reason: err.message,
          partialOutput: finalOutput || '',
        });
        runError = null; // suppress telemetry error flag for intentional cancels
      } else {
        runError = err;
        throw err;
      }
    } finally {
      // Always release pending permission escalations so they don't leak
      // across runs — even on error paths. cancelAllPending is safe to call
      // when there are no pending requests.
      try { escalator.cancelAllPending(); } catch { /* non-critical */ }

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
