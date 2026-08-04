import EventEmitter, { setMaxListeners } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { glob } from 'glob';
import type { EscalationDecision,
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
import { composeRootSectionOutput } from './tiers/escalation-policy.js';
import { MultimodalRegistry } from './multimodal/registry.js';
import type { FeedbackSource } from './router/feedback-prior.js';
import { DeadModelStore, fileDeadModelPersistence } from './router/dead-models.js';

/**
 * How long an escalation waits for an answer. Long enough that someone who
 * stepped away for a coffee still gets to decide; short enough that a hosted
 * run doesn't hold a worker slot all afternoon.
 */
const ESCALATION_DECISION_TIMEOUT_MS = 5 * 60_000;
import { buildMediaTools, type AssetSink } from '../tools/generate-media.js';
import { buildDocumentTools } from '../tools/generate-document.js';
import { RunBreaker } from './run-breaker.js';
import { T3Worker } from './tiers/t3-worker.js';
import { ToolRegistry } from '../tools/registry.js';
import { McpClient } from '../mcp/client.js';
import { fileOAuthProvider, withOAuthStoreLock } from '../mcp/oauth.js';
import { distillSessionFacts, buildSessionTranscript, sessionWorthRemembering } from './knowledge/session-memory.js';
import { AuditLogger } from '../audit/log.js';
import { AuditLogger as EncryptedAuditLogger } from './audit/audit-logger.js';
import { MemoryStore } from '../memory/store.js';
import { PermissionEscalator } from './permissions/escalator.js';
import { validateConfig } from '../config/validate.js';
import { Telemetry, noopTelemetry } from '../telemetry/index.js';
import { TaskAnalyzer } from './router/task-analyzer.js';
import { ModelPerformanceTracker } from './router/model-performance-tracker.js';
import { benchmarkScore01 } from './router/benchmarks.js';
import { ToolCreator } from '../tools/tool-creator.js';
import { CascadeCancelledError } from '../utils/retry.js';
import { WorldStateDB } from './knowledge/world-state.js';
import { ResumeStore, summarizeCompleted, type CompletedNode, type ResumeReason } from './orchestration/resume-store.js';
import { PrivacyPaths } from './privacy/paths.js';
import { CascadeIgnore } from '../config/ignore.js';
import { WorkspaceIndex } from '../retrieval/workspace-index.js';
import { embedderFromProviders } from '../retrieval/embedder.js';
import { LLMReranker, chatCompleterFromProviders } from '../retrieval/rerank.js';
import { CodeSearchTool } from '../tools/code-search.js';
import { GraphSearchTool } from '../tools/graph-search.js';
import {
  estimateTokens, messagesTokens, needsCompaction, rollingSummary, mapReduceCompact, type Summarize,
} from './context/compaction.js';
import { GuidanceQueue } from './steering/guidance.js';
import { CurrentPageTool, type CurrentPageProvider } from '../tools/current-page.js';

/** One entry in the per-run orchestration decision trail (see /why). */
export interface DecisionLogEntry {
  at: string;
  kind: 'complexity' | 'model' | 'failover' | 'escalation' | 'context';
  detail: string;
}

/**
 * Prefixes the latest user message with a compact block of recent conversation
 * so the executing tier resolves a follow-up IN CONTEXT. `determineComplexity`
 * already receives history for routing, but the execution tiers only ever saw
 * the bare latest message — which is why short follow-ups ("1", "yes", "make it
 * shorter") were run as standalone tasks with no memory of the prior turn.
 * Returns the prompt unchanged when there's no history (a conversation's first
 * message), so it's a no-op for single-shot runs and the desktop path (which
 * already stitches context in via buildContinuationPrompt and passes none here).
 */
export function buildContextualPrompt(prompt: string, history: ConversationMessage[] = []): string {
  const recent = history.slice(-6);
  if (recent.length === 0) return prompt;
  const asText = (content: ConversationMessage['content']): string =>
    typeof content === 'string'
      ? content
      : content.map((b) => (b.type === 'text' ? b.text : '[non-text]')).join(' ');
  const block = recent
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${asText(m.content).slice(0, 2000)}`)
    .join('\n');
  return `Recent conversation (for context — the user is continuing it; resolve their latest message with this in mind):
${block}

Latest user message:
${prompt}`;
}

export class Cascade extends EventEmitter {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private multimodal: MultimodalRegistry;
  private mediaSink?: AssetSink;
  private mcpClient: McpClient;
  private codeIndex?: WorkspaceIndex;
  private config: CascadeConfig;
  /** Orchestration decisions for the CURRENT run — cleared on each run(). */
  private decisionLog: DecisionLogEntry[] = [];
  private initialized = false;
  /**
   * Last interrupted task — powers /continue (resumeRun). Kept in memory as a
   * fast path for the same-process case; the durable copy lives in `resumeStore`
   * so a crash or an exit no longer throws away everything already finished.
   */
  private lastInterruptedRun?: { prompt: string; partialOutput: string; taskId: string };
  /** Durable resume checkpoints. See core/orchestration/resume-store.ts. */
  private resumeStore?: ResumeStore;
  /** Claim held by an in-flight resume, settled once the run owns the work. */
  private claimedResumeId?: string;
  /**
   * Facts inherited from the checkpoint this run is resuming, so its own
   * checkpoint is cumulative rather than only covering this attempt.
   */
  private resumedFrom?: { prompt: string; completed: CompletedNode[] };
  /** Whether THIS run persisted a checkpoint of its own. Drives settle-vs-release. */
  private wroteCheckpointThisRun = false;
  /**
   * Whether the run reached the end of its normal path.
   *
   * NOT the same as `runError == null`: the cancellation and budget handlers
   * both null `runError` deliberately (an intentional stop is not a telemetry
   * error) and the breaker path never sets it at all. Treating that as success
   * meant an immediate cancel — no output, no replacement checkpoint — deleted
   * the original claim and the finished sections with it.
   */
  private completedNormally = false;
  /** Section results of the CURRENT run, so an interruption can checkpoint them. */
  private currentRunCompleted: CompletedNode[] = [];
  private initPromise?: Promise<void>;
  private store?: MemoryStore;
  private audit?: AuditLogger;
  private telemetry: Pick<Telemetry, 'capture' | 'shutdown'>;
  private taskAnalyzer?: TaskAnalyzer;
  private perfTracker?: ModelPerformanceTracker;
  private toolCreator?: ToolCreator;
  private worldStateDB?: WorldStateDB;
  private encryptedAuditLogger?: EncryptedAuditLogger;
  private guidanceQueue!: GuidanceQueue;
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
    // Generation models (image / speech / transcription) were filtered out of
    // the CHAT pool because a text turn routed to them fails — but that left
    // them unreachable entirely, even with the key already configured. The
    // registry turns them back into callable tools, and only for the providers
    // this config actually has, so a tool never exists that cannot run.
    // Dead-model verdicts persist across runs. Without this the router
    // rediscovers a 404'd id every session — and because a T3 wave fires
    // concurrently, "rediscovers" means one wasted call per worker.
    //
    // Scoped to the WORKSPACE, never the machine-global config dir. On a hosted
    // server the workspace is the per-user scratch dir, so one tenant's dead
    // model cannot suppress another's — which matters because the verdict is
    // key-specific: a model that 404s for one account is often perfectly live
    // for another whose key has access to it. A shared file would let one user
    // silently poison everyone else's routing. (The global dir is single-tenant
    // by design and a hosted server must never write it — see cloud db.ts.)
    // On desktop this makes verdicts per-project, which is also right: provider
    // config is per-project too.
    try {
      this.router.setDeadModelStore(new DeadModelStore(
        fileDeadModelPersistence(path.join(workspacePath, '.cascade', 'dead-models.json')),
      ));
    } catch { /* memory-only fallback; the router already has a default store */ }

    // Durable resume checkpoints live beside the other per-project state. Same
    // reasoning as dead-models above: this is a property of THIS workspace's
    // run history, not of the machine.
    try {
      this.resumeStore = new ResumeStore({
        dir: path.join(workspacePath, '.cascade', 'resume'),
      });
    } catch { /* resume is a convenience; never block construction on it */ }

    this.multimodal = new MultimodalRegistry(
      (this.config.providers ?? []).map((p) => p.type),
    );
    this.registerMediaTools(workspacePath);
    this.registerDocumentTools(workspacePath);
    this.telemetry = config.telemetry?.enabled
      ? new Telemetry(config.telemetry, config.telemetry.distinctId ?? 'anonymous')
      : noopTelemetry;
    
    // Phase 4: Project World State
    this.worldStateDB = new WorldStateDB(this.workspacePath, this.config.workspace?.debugWorldState ?? false);
    this.router.setWorldStateDB(this.worldStateDB);

    // Phase 3: Privacy & Governance - AuditLogger
    this.encryptedAuditLogger = new EncryptedAuditLogger(this.workspacePath, this.config.workspace?.debugWorldState ?? false);

    // Per-path privacy tiers: subtasks touching local-only paths are forced
    // onto private models and their raw output is withheld from upper tiers.
    const privacyPolicies = this.config.privacy?.paths ?? [];
    if (privacyPolicies.length) this.router.setPrivacyPaths(new PrivacyPaths(privacyPolicies));

    // Live steering: user guidance injected mid-run reaches T3 agent loops
    // through this queue (carried on the router like the world-state DB).
    this.guidanceQueue = new GuidanceQueue();
    this.router.setGuidanceQueue(this.guidanceQueue);
  }

  /**
   * Live intervention: inject a user correction into the running hierarchy.
   * Every active T3 worker (or only the one matching `nodeId`) picks it up at
   * the top of its next agent-loop iteration as a USER INTERVENTION message.
   */
  injectGuidance(text: string, nodeId?: string): void {
    const entry = this.guidanceQueue.push(text, nodeId);
    this.encryptedAuditLogger?.logEvent('user_guidance', nodeId ?? '*', { text });
    this.emit('guidance:injected', entry);
  }

  private initOptionalFeatures(): void {
    if (this.config.cascadeAuto === true) {
      // Stats file + consent come from routing config: the cloud points the path
      // at its persistent volume (shared, survives redeploys) and sets
      // learnFromOutcomes=false for users who opted out (read scores, don't record).
      this.perfTracker = new ModelPerformanceTracker(
        this.config.routing?.perfStatsPath,
        { readOnly: this.config.routing?.learnFromOutcomes === false },
      );
      void this.perfTracker.load(); // non-blocking; stats available before first run completes
      this.taskAnalyzer = new TaskAnalyzer(this.perfTracker, this.config.autoBias ?? 'balanced');
      // Share the analyzer with the router so workers can route each subtask to
      // the benchmark-best model for its type.
      this.router.setTaskAnalyzer(this.taskAnalyzer);
    }
    const cfg = this.config as unknown as Record<string, unknown>;
    if (cfg['enableToolCreation'] === true) {
      const sandboxMode = (this.config.tools?.dynamicToolSandbox ?? 'auto');
      this.toolCreator = new ToolCreator(this.router, this.toolRegistry, this.workspacePath, cfg['persistDynamicTools'] !== false, sandboxMode);
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

  private async requestMcpApproval(server: { name: string; command?: string; args?: string[]; url?: string }): Promise<boolean> {
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

  /**
   * Build the workspace code index and register the `code_search` tool. Uses the
   * user's own provider key for embeddings (and, if chat-capable, reranking).
   * The index persists to a per-workspace SQLite file; `autoRefresh` brings it
   * up to date at init (incremental — only changed files re-embed).
   */
  private async initCodeIndex(): Promise<void> {
    const ci = this.config.codeIndex!;
    const embedder = embedderFromProviders(this.config.providers);
    if (!embedder) {
      this.emit('log', { level: 'warn', message: 'Code index enabled but no embeddings-capable provider is configured — skipping.' });
      return;
    }
    const dbPath = ci.dbPath || path.join(this.workspacePath, '.cascade', 'code-index.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    const complete = chatCompleterFromProviders(this.config.providers);
    const reranker = complete ? new LLMReranker({ complete }) : undefined;

    const ignore = new CascadeIgnore();
    await ignore.load(this.workspacePath);

    const index = new WorkspaceIndex({
      root: this.workspacePath,
      db,
      embedder,
      reranker,
      isIgnored: (abs) => ignore.isIgnored(abs, this.workspacePath),
    });

    if (ci.autoRefresh) {
      const res = await index.refresh();
      this.emit('log', { level: 'info', message: `Code index refreshed: ${res.filesIndexed} indexed, ${res.filesUnchanged} unchanged, ${res.chunks} chunks.` });
    }
    this.codeIndex = index;
    this.toolRegistry.register(new CodeSearchTool(index));
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

  // ── Escalation decisions ────────────────────────────────────────────
  //
  // A section that ends ESCALATED used to be a dead end: the Cockpit showed
  // "Section escalated — needs a decision" and no decision was ever requested,
  // so the run stopped there having spent a full orchestration. This is the
  // same round-trip shape as plan approval, with one deliberate difference —
  // an unanswered escalation FAILS the section instead of proceeding.
  //
  // That direction is the safe one here. Plan approval defaults to "yes" on
  // timeout because the plan is already the model's considered proposal;
  // an escalation exists precisely BECAUSE the worker was not confident, so
  // acting unattended is the option most likely to be wrong. And in cloud a
  // waiting run holds server resources, so hanging is not free either.

  // Keyed by request id, NOT a single slot. A Complex run dispatches each wave
  // of ready sections with `Promise.all` (t1-administrator.ts), so two sections
  // can be waiting on a decision at the same moment. A single field made that
  // case fail hard rather than merely confusingly: the second escalation
  // overwrote the first's resolver, the user's answer resolved only the second,
  // and then the FIRST section's timer found the slot already empty and
  // returned without resolving anything — parking the run forever, past its own
  // timeout. Same class of bug as the twelve-failover dead-model race: a wave
  // is concurrent, so per-run singletons are never safe inside it.
  private pendingEscalations = new Map<string, (decision: EscalationDecision) => void>();

  private async requestEscalationDecision(
    ctx: { sectionId: string; sectionTitle: string; issues: string[]; summary: string },
    taskId: string,
    signal?: AbortSignal,
  ): Promise<EscalationDecision> {
    // Autonomous runs have nobody to ask; skipping keeps whatever the section
    // did produce rather than discarding it over an unanswerable question.
    // `automatic: true` marks these as the SYSTEM's choice, not a person's —
    // T2 must not read this as the user having reviewed and accepted the
    // section (see EscalationDecision.automatic).
    if (this.config.autonomy === 'auto') return { action: 'skip', automatic: true };
    if (this.listenerCount('escalation:decision-required') === 0) return { action: 'skip', automatic: true };
    if (signal?.aborted) return { action: 'skip', automatic: true };

    const requestId = randomUUID();

    return await new Promise<EscalationDecision>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;

      // One settle path for every outcome, guarded by the map delete so the
      // first of {answer, timeout, abort} wins and the losers are no-ops.
      const settle = (decision: EscalationDecision) => {
        if (!this.pendingEscalations.delete(requestId)) return;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        resolve(decision);
      };

      // Stop / disconnect must unpark the run. T2 has already passed its
      // cancellation checkpoint by the time it escalates, so without this the
      // aborted run sits here holding resources until the full timeout — the
      // user pressed Stop and watched nothing stop. Skip (not timeout) because
      // an abort is not a failure of the section, it is the user leaving.
      // `automatic: true` — pressing Stop ends the whole run, it is not the
      // user reviewing and accepting THIS section's partial output.
      const onAbort = () => settle({ action: 'skip', automatic: true });
      signal?.addEventListener('abort', onAbort, { once: true });

      timeout = setTimeout(() => {
        this.emit('escalation:timeout', { taskId, requestId, sectionId: ctx.sectionId });
        settle({ action: 'timeout' });
      }, ESCALATION_DECISION_TIMEOUT_MS);

      this.pendingEscalations.set(requestId, settle);
      this.emit('escalation:decision-required', {
        taskId,
        requestId,
        sectionId: ctx.sectionId,
        sectionTitle: ctx.sectionTitle,
        issues: ctx.issues,
        summary: ctx.summary,
        timeoutMs: ESCALATION_DECISION_TIMEOUT_MS,
      });
    });
  }

  /**
   * Resolve a pending escalation from a REPL / dashboard / cloud listener.
   *
   * `requestId` comes back from the `escalation:decision-required` event and is
   * what makes an answer land on the section that asked. It is optional so a
   * host with only one escalation in flight (and any caller that predates the
   * id) still works: without it the oldest outstanding request is answered,
   * which is correct whenever there is exactly one.
   *
   * `automatic` defaults to false — a call into this method is normally a real
   * person answering the prompt. Pass `true` from a host that is itself
   * settling the gate on nobody's behalf (a REST caller who never had a
   * chance to connect, a session halt with no per-section review behind it),
   * so T2 doesn't set `userSkipped` for a decision no one actually reviewed —
   * see EscalationDecision.automatic.
   */
  resolveEscalation(action: EscalationDecision['action'], note?: string, requestId?: string, automatic?: boolean): void {
    const decision: EscalationDecision = { action, ...(note ? { note } : {}), ...(automatic ? { automatic: true } : {}) };
    if (requestId) {
      this.pendingEscalations.get(requestId)?.(decision);
      return;
    }
    const oldest = this.pendingEscalations.keys().next();
    if (!oldest.done) this.pendingEscalations.get(oldest.value)?.(decision);
  }

  /**
   * Release every parked escalation — run teardown, so none outlive the run.
   * `automatic: true`: teardown resolving a section nobody answered is the
   * same system-decided case as the early-return skips above, not a person
   * reviewing and accepting that section's output.
   */
  private releasePendingEscalations(action: EscalationDecision['action'] = 'skip'): void {
    for (const settle of Array.from(this.pendingEscalations.values())) settle({ action, automatic: true });
  }

  /**
   * Resolve a pending boardroom plan approval from a REPL / dashboard listener.
   * An optional `note` re-plans and re-asks; an optional `editedPlan` is applied
   * directly (no re-decompose).
   */
  resolvePlanApproval(approved: boolean, note?: string, editedPlan?: TaskPlan): void {
    this.pendingPlanApproval?.({ approved, note, editedPlan });
  }

  // ── Extended-context approval ───────────────────────────────────────
  // Same gate pattern: an oversized single input costs extra model calls to
  // chunk + map-reduce, so we confirm before spending. No listener (headless)
  // or a timeout means PROCEED — the feature is opt-in, and the run's budget
  // cap is the real guardrail against runaway cost.

  private pendingContextApproval?: (approved: boolean) => void;

  /** Resolve a pending extended-context confirmation from a UI listener. */
  resolveContextApproval(approved: boolean): void {
    this.pendingContextApproval?.(approved);
  }

  private async requestContextApproval(info: {
    inputTokens: number; windowTokens: number; multiplier: number; estChunks: number;
  }): Promise<boolean> {
    if (this.listenerCount('context:approval-required') === 0) return true;
    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pendingContextApproval) {
          this.pendingContextApproval = undefined;
          resolve(true);
        }
      }, 120_000);
      this.pendingContextApproval = (approved) => {
        clearTimeout(timeout);
        this.pendingContextApproval = undefined;
        resolve(approved);
      };
      this.emit('context:approval-required', info);
    });
  }

  /**
   * Extended context: when enabled, compact an over-budget conversation history
   * (rolling summary — cheap, automatic) and/or a single oversized input (chunk
   * + map-reduce — confirm-gated) so the run fits the model's window. Returns a
   * new options object with the compacted prompt/history; a no-op when disabled,
   * when nothing overflows, or when the model window isn't known yet.
   */
  private async applyExtendedContext(options: CascadeRunOptions): Promise<CascadeRunOptions> {
    const ec = this.config.extendedContext;
    if (!ec?.enabled) return options;
    const windowTokens = this.router.getReferenceContextWindow();
    if (!windowTokens) return options;

    const reserve = 0.2;
    const budget = Math.floor(windowTokens * (1 - reserve));
    const multiplier = ec.maxMultiplier ?? 2;
    const capTokens = windowTokens * multiplier;

    // Summarize with the cheapest tier so compaction stays inexpensive.
    const summarize: Summarize = async (input, instruction) => {
      const res = await this.router.generate('T3', {
        messages: [{ role: 'user', content: `${instruction}\n\n${input}` }],
        maxTokens: 1024,
        temperature: 0,
      });
      return res.content;
    };

    let history = options.conversationHistory ?? [];
    let prompt = options.prompt;

    // 1. History overflow → rolling summary (automatic; one cheap call).
    if (history.length > 4 && needsCompaction(messagesTokens(history), windowTokens, reserve)) {
      try {
        const before = history.length;
        history = await rollingSummary(history, { summarize, keepRecent: 4, targetTokens: budget });
        this.recordDecision('context', `Extended context: folded ${before - history.length + 1} earlier turns into a summary to fit the window`);
        this.emit('context:compacted', { kind: 'history', foldedTurns: before - (history.length - 1) });
      } catch {
        /* compaction is best-effort — fall back to the raw history */
      }
    }

    // 2. Single oversized input → chunk + map-reduce (confirm-gated; expensive).
    const inputTokens = estimateTokens(prompt);
    if (inputTokens > windowTokens) {
      const chunkTokens = Math.max(256, Math.floor(budget / 3));
      const estChunks = Math.ceil(inputTokens / chunkTokens);
      const approved = await this.requestContextApproval({ inputTokens, windowTokens, multiplier, estChunks });
      if (approved) {
        try {
          const r = await mapReduceCompact(prompt, { summarize, chunkTokens, targetTokens: budget, capTokens });
          prompt = r.text;
          this.recordDecision('context', `Extended context: compacted a ${inputTokens}-token input via ${r.chunks} chunks (${r.calls} calls${r.truncated ? ', truncated at cap' : ''})`);
          this.emit('context:compacted', { kind: 'input', chunks: r.chunks, calls: r.calls, truncated: r.truncated });
        } catch {
          /* leave the prompt as-is; the provider will truncate/handle it */
        }
      }
    }

    return { ...options, prompt, conversationHistory: history };
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

  /**
   * Register image / speech / transcription tools for the modalities this
   * config can actually serve.
   *
   * The sink writes bytes into the workspace, because that is what a desktop or
   * CLI run wants and it keeps a generated asset indistinguishable from any
   * other file the run produced. A host with different storage (the cloud
   * server stores a file row) constructs the tools itself via buildMediaTools
   * with its own sink.
   */
  /**
   * Replace where generated media is written.
   *
   * The default sink writes into the workspace, which is what a desktop or CLI
   * run wants. A host with different storage — the cloud server keeps a file
   * row plus bytes under the tenant's directory — supplies its own here, and
   * the media tools are rebuilt around it. Re-registering by name replaces the
   * existing tools rather than duplicating them.
   */
  setMediaSink(sink: AssetSink): void {
    this.mediaSink = sink;
    this.registerMediaTools(this.workspacePath);
  }

  /**
   * Let the agent read the page the user has open in the host's browser.
   *
   * Host-supplied because only a host WITH a browser can answer it — so the
   * tool is simply absent in the CLI and in hosted runs, rather than present
   * and always failing. Registered outside `enabledTools` for the same reason
   * media tools are: that allowlist is a blast-radius control for tools that
   * touch the machine, and reading a page the user already opened touches
   * nothing. `disabledTools` still removes it.
   */
  setCurrentPageProvider(provider: CurrentPageProvider): void {
    if ((this.config.tools?.disabledTools ?? []).includes('read_current_page')) return;
    this.toolRegistry.register(new CurrentPageTool(provider));
  }

  private registerMediaTools(workspacePath: string): void {
    // Media tools register OUTSIDE `enabledTools`, the same way MCP tools do.
    //
    // That allowlist exists to keep shell/file/git genuinely absent from a
    // hosted run — it is a blast-radius control for tools that touch the
    // machine. Generation tools touch nothing: they call an API the user
    // already configured a key for and hand the bytes to a host-supplied sink.
    // Gating them on the same list meant a cloud run (allowlist:
    // ['web_search','web_fetch']) silently had no image tool, so asking for a
    // picture got "I cannot create images" from a model that was telling the
    // truth about the tools it had been given.
    //
    // An explicit opt-out remains available: naming a media tool in
    // `disabledTools` removes it.
    const denied = new Set(this.config.tools?.disabledTools ?? []);
    const permitted = (name: string): boolean => !denied.has(name);

    const tools = buildMediaTools(
      {
        registry: this.multimodal,
        lookupProvider: (provider) => (this.config.providers ?? []).find((p) => p.type === provider),
        sink: this.mediaSink ?? (async (asset) => {
          const fsp = await import('node:fs/promises');
          const nodePath = await import('node:path');
          const dir = nodePath.join(workspacePath, 'generated');
          await fsp.mkdir(dir, { recursive: true });
          const dest = nodePath.join(dir, asset.filename);
          await fsp.writeFile(dest, asset.data);
          return nodePath.relative(workspacePath, dest);
        }),
      },
      async (p) => {
        const fsp = await import('node:fs/promises');
        return fsp.readFile(p);
      },
    );

    for (const tool of tools) {
      // `enabledTools` is the single off-switch for the whole tool surface, and
      // a restricted embed must not gain new tools just because it has an
      // OpenAI key.
      if (!permitted(tool.name)) continue;
      tool.setWorkspaceRoot(workspacePath);
      this.toolRegistry.register(tool);
    }
  }

  /**
   * Register `generate_document` where there is a real workspace to write into.
   *
   * A `.docx`/`.pptx`/`.xlsx` is a ZIP of OOXML parts, so `file_write` — which
   * does exactly what it says and writes the model's text verbatim — produced
   * files Word/Excel/PowerPoint correctly reported as corrupted. This tool owns
   * the conversion (see tools/generate-document.ts for why it isn't folded into
   * file_write).
   *
   * Registered OUTSIDE `enabledTools` for the same reason the media tools are:
   * that allowlist is a blast-radius control for tools that reach the machine
   * or the network, and this one only writes the artifact the user asked for,
   * into the workspace the run already owns. `disabledTools` still removes it.
   * A host with no filesystem (the cloud) has its own browser-side exporter and
   * simply never reaches this path — `buildDocumentTools` returns nothing
   * without a file reader, mirroring `transcribe_audio`.
   */
  private registerDocumentTools(workspacePath: string): void {
    const denied = new Set(this.config.tools?.disabledTools ?? []);
    const tools = buildDocumentTools(async (p) => {
      const fsp = await import('node:fs/promises');
      return new Uint8Array(await fsp.readFile(p));
    });
    for (const tool of tools) {
      if (denied.has(tool.name)) continue;
      tool.setWorkspaceRoot(workspacePath);
      this.toolRegistry.register(tool);
    }
  }

  /**
   * Supply per-model thumbs-up/down counts so Auto routing can weigh how models
   * have actually performed for this user, on top of public benchmarks.
   *
   * Optional everywhere: with no source, or an empty record, scoring is
   * byte-identical to before. The adjustment is capped and sample-size shrunk —
   * see core/router/feedback-prior.ts.
   */
  setFeedbackSource(source: FeedbackSource): void {
    this.router.setFeedbackSource(source);
  }

  /**
   * Write a durable checkpoint for an interrupted run.
   *
   * Best-effort throughout: a run is already ending badly on every path that
   * calls this, and failing to record a resume file must not make that ending
   * worse. Nothing here is allowed to throw.
   */
  private async checkpointRun(
    taskId: string,
    prompt: string,
    partialOutput: string,
    reason: ResumeReason,
    detail?: string,
  ): Promise<boolean> {
    // A resumed run's checkpoint must be CUMULATIVE. Saving only this attempt's
    // sections and then settling the claim discarded everything the earlier
    // attempts had already finished, so a third attempt re-did — and re-paid
    // for — work two runs had completed. Sections are keyed by id so a node
    // re-run in this attempt supersedes its inherited copy rather than
    // appearing twice.
    const inherited = this.resumedFrom?.completed ?? [];
    const merged = new Map<string, CompletedNode>();
    for (const node of inherited) merged.set(node.id, node);
    for (const node of this.currentRunCompleted) merged.set(node.id, node);
    const completed = [...merged.values()];

    // The ORIGINAL prompt travels forward, so each resume does not nest the
    // previous continuation inside a longer one until the task is unreadable.
    const canonicalPrompt = this.resumedFrom?.prompt ?? prompt;

    // Nothing finished and nothing produced — a checkpoint would restore no work
    // and only leave the prompt sitting on disk for no benefit.
    if (!completed.length && !partialOutput) return false;
    try {
      const saved = await this.resumeStore?.save({
        taskId,
        prompt: canonicalPrompt,
        reason,
        ...(detail ? { detail } : {}),
        partialOutput,
        completed,
      });
      // save() swallows filesystem errors by design, so `await` resolving is not
      // evidence anything was written. Trusting it marked a checkpoint present
      // when the disk was full and then deleted the claim it was replacing.
      this.wroteCheckpointThisRun = saved === true;
      return saved === true;
    } catch {
      return false; /* never let checkpointing worsen an already-failing run */
    }
  }

  /** True when a task can be resumed via /continue (this process or a previous one). */
  hasResumableRun(): boolean {
    return this.lastInterruptedRun != null;
  }

  /**
   * True when a checkpoint from ANY process is resumable. Async because the
   * durable check touches disk; `hasResumableRun` remains the sync in-memory
   * answer for callers already on a hot path.
   */
  async hasDurableResume(): Promise<boolean> {
    return (await this.resumeStore?.latest()) != null;
  }

  /** Interrupted runs available to resume, newest first. */
  async listResumableRuns() {
    return (await this.resumeStore?.list()) ?? [];
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

    this.raiseBudgetForResume(opts.maxTokens);
    return this.buildResumePrompt(last.prompt, last.partialOutput, []);
  }

  /**
   * Durable counterpart to prepareResume: recovers a run interrupted in ANY
   * process, including one that crashed before it could return. Consumes the
   * checkpoint, so the same finished work is never restored into two runs.
   */
  async prepareDurableResume(opts: { maxTokens?: number; taskId?: string } = {}): Promise<string | null> {
    // Reclaim anything a previous process claimed and then died holding, so a
    // crash mid-resume doesn't strand the checkpoint invisibly.
    await this.resumeStore?.reclaimStale();

    const claimed = await this.resumeStore?.claim(opts.taskId);
    if (!claimed) return null;

    try {
      this.lastInterruptedRun = undefined; // the durable copy supersedes it
      this.raiseBudgetForResume(opts.maxTokens);
      const prompt = this.buildResumePrompt(
        claimed.checkpoint.prompt, claimed.checkpoint.partialOutput, claimed.checkpoint.completed,
      );
      // Carry the claim's facts forward so the NEXT checkpoint is cumulative.
      // Without this, a resumed attempt that finishes one new section and is
      // interrupted again writes a checkpoint containing only that one section:
      // settling the claim then discards the original graph facts, and the
      // third attempt re-does work that two earlier runs already paid for. The
      // original prompt travels too, so it stays canonical instead of each
      // resume nesting the last continuation inside a longer one.
      this.resumedFrom = {
        prompt: claimed.checkpoint.prompt,
        completed: claimed.checkpoint.completed,
      };
      // Only now is the continuation safely in the caller's hands. Settling
      // earlier — as consume() did — meant a crash between reading and running
      // destroyed the one record of the work, in the mechanism whose whole
      // purpose is surviving crashes.
      this.claimedResumeId = claimed.claimId;
      return prompt;
    } catch (err) {
      // Building the continuation failed: hand the checkpoint back so the work
      // stays recoverable rather than disappearing with a failed attempt.
      await this.resumeStore?.release(claimed.claimId);
      throw err;
    }
  }

  /**
   * Discard the claimed checkpoint once the resumed run has taken ownership of
   * the work (it has produced its own checkpoint, or finished). Called by the
   * run loop; safe to call when nothing is claimed.
   */
  private async settleClaimedResume(succeeded: boolean): Promise<void> {
    const claimId = this.claimedResumeId;
    if (!claimId) return;
    this.claimedResumeId = undefined;

    // Settling unconditionally recreated a narrower form of the bug the lease
    // was introduced to fix. A resumed attempt that dies on its FIRST provider
    // call completes no section and produces no output, so checkpointRun()
    // correctly declines to save — and settling anyway deleted the original,
    // which still held two finished sections. There was then nothing left to
    // continue. Only discard the claim when the work it protects is genuinely
    // safe: the run finished, or it left a replacement checkpoint behind.
    if (succeeded || this.wroteCheckpointThisRun) {
      await this.resumeStore?.settle(claimId);
    } else {
      await this.resumeStore?.release(claimId);
    }
  }

  /**
   * Hand back a claim taken by prepareDurableResume() when the caller never
   * gets as far as run(). The REPL prepares the continuation and submits it
   * separately, so a failure in between would otherwise strand the checkpoint
   * for the whole lease timeout before reclaimStale() could recover it.
   */
  async releaseClaimedResume(): Promise<void> {
    const claimId = this.claimedResumeId;
    if (!claimId) return;
    this.claimedResumeId = undefined;
    await this.resumeStore?.release(claimId);
  }

  /** A resume gets a bigger budget — the previous attempt exhausted the old one. */
  private raiseBudgetForResume(maxTokens?: number): void {
    const raised = maxTokens ?? Math.round((this.config.budget?.maxTokensPerRun ?? 200_000) * 2);
    this.config = { ...this.config, budget: { ...this.config.budget, maxTokensPerRun: raised } };
    this.router.setMaxTokensPerRun(raised);
  }

  /**
   * The resume prompt. Completed sections are named explicitly rather than
   * gestured at: "do not recreate the files" is an instruction a planner can
   * only guess at, whereas a list of what is already done, and what it produced,
   * is something it can act on. That difference is the entire reason node
   * results are kept — a re-plan that cannot see the finished work will plan the
   * finished work again, and the user pays for it a second time.
   */
  private buildResumePrompt(
    prompt: string,
    partialOutput: string,
    completed: readonly CompletedNode[],
  ): string {
    const done = summarizeCompleted(completed);
    return [
      'Continue and FINISH this task. A previous attempt was interrupted before completion; '
      + 'any files already created are on disk — build on them, do NOT recreate them. '
      + 'Plan ONLY the remaining work.',
      '',
      `Original task: ${prompt}`,
      done ? `\n${done}` : '',
      partialOutput ? `\nPartial result so far:\n${partialOutput}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Resume the last budget-capped task with a raised budget (SDK/headless).
   * Returns null when there is nothing to resume.
   */
  async resumeRun(opts: { maxTokens?: number } = {}): Promise<CascadeRunResult | null> {
    // Prefer the durable checkpoint: it carries the finished sections, whereas
    // the in-memory record only ever held the prompt and the partial text.
    const prompt = (await this.prepareDurableResume(opts)) ?? this.prepareResume(opts);
    if (!prompt) return null;
    try {
      return await this.run({ prompt });
    } catch (err) {
      // run() awaits init() BEFORE entering its try/finally, so a failure there
      // never reaches settleClaimedResume and the claim would stay hidden until
      // stale reclamation. The REPL has its own catch; SDK and headless callers
      // come through here and need the same protection.
      await this.releaseClaimedResume();
      throw err;
    }
  }

  public getWorkspacePath(): string {
    return this.workspacePath;
  }
  
  public getWorldStateDB(): WorldStateDB | undefined {
    return this.worldStateDB;
  }

  /**
   * Record an explicit user rating for the last completed run.
   * Explicit ratings carry 3× the weight of auto-detected outcomes so user
   * feedback meaningfully shifts future routing decisions.
   * Returns false when called before any task has run in this session.
   */
  rateLastRun(rating: 'good' | 'bad'): boolean {
    if (!this.taskAnalyzer) return false;
    const recorded = this.taskAnalyzer.recordExplicitRating(rating);
    if (recorded) void this.perfTracker?.save();
    return recorded;
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

      // Initialize MCP servers. A server carrying `oauthStore` was connected via
      // OAuth ("cascade mcp connect"); attach an auto-refreshing token provider
      // (silent refresh; dead refresh token → surfaced as "reconnect needed").
      if (this.config.tools.mcpServers?.length) {
        for (const server of this.config.tools.mcpServers) {
          try {
            const authProvider = server.oauthStore ? fileOAuthProvider(server.oauthStore) : undefined;
            const connect = () => this.mcpClient.connect(server, authProvider ? { authProvider } : {});
            // Settings expanding this same connector's tool list can be
            // refreshing its token at this exact moment — serialize on the
            // store, not the connect call in general (see withOAuthStoreLock).
            await (server.oauthStore ? withOAuthStoreLock(server.oauthStore, connect) : connect());
            // Per-tool selection: a connected server usually brings dozens of
            // tools, most irrelevant to any given workspace. `disabledTools`
            // names the ones the user switched off in Settings; they are left
            // unregistered rather than refused at call time.
            this.toolRegistry.registerMcpTools(
              this.mcpClient,
              (name) => !(this.config.tools?.disabledTools ?? []).includes(name),
            );
          } catch (err) {
            console.error(`Failed to connect to MCP server "${server.name}":`, err);
          }
        }
      }

      // Workspace code index (Phase 3) — opt-in; registers a `code_search` tool
      // backed by a hybrid + reranked index of the workspace. Non-fatal on error.
      if (this.config.codeIndex?.enabled) {
        try {
          await this.initCodeIndex();
        } catch (err) {
          console.error('Failed to initialize workspace code index:', err);
        }
      }

      // Knowledge graph search (Phase 4) — register a `knowledge_graph_search`
      // tool over world-state, but only once the workspace actually has learned
      // facts (so a fresh repo isn't handed a tool with nothing to search).
      if (this.config.knowledge?.factsExtraction !== false) {
        try {
          const ws = this.worldStateDB;
          if (ws && ws.getAllFacts().length > 0) {
            this.toolRegistry.register(new GraphSearchTool(ws));
          }
        } catch (err) {
          console.error('Failed to register knowledge graph search:', err);
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

      // Native tool-support probe for local/compat models with no capability
      // metadata (custom .gguf on llama.cpp / LM Studio). NOT gated on
      // cascadeAuto — the T3 tool-use gate needs the verdict either way.
      // Background, one-time per model (verdict cached in the store).
      if (this.store) {
        this.router.probeLocalToolSupport(this.store).catch(() => { /* non-fatal */ });
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

      // Phase 3: Wire encrypted audit logger to capture global events
      if (this.encryptedAuditLogger) {
        this.on('tool:call', (e) => this.encryptedAuditLogger!.logEvent('tool_call', e.tierId || 'unknown', e));
        this.on('tool:result', (e) => this.encryptedAuditLogger!.logEvent('tool_result', e.tierId || 'unknown', e));
        this.on('tier:status', (e) => this.encryptedAuditLogger!.logEvent('tier_status', e.tierId || 'unknown', e));
      }

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

  /**
   * Pure small talk that a single tool-less model answers best: greetings,
   * acknowledgements and self-identity questions. Deliberately NARROWER than
   * looksLikeConversational — "what is X" / "show me Y" / "list Z" need tools
   * or real lookup and stay on the worker path. Bare confirmations ("yes",
   * "ok") in an ongoing conversation are task input, not small talk.
   */
  private looksLikeSmallTalk(prompt: string, history: ConversationMessage[] = []): boolean {
    const p = prompt.trim();
    if (this.isCasualGreeting(p)) return true;
    if (/^(?:who|what)\b.*\byou\b/i.test(p) || /^what can you\b/i.test(p)) {
      return p.split(/\s+/).length <= 12;
    }
    // Greeting-led openers ("hey there!", "hello cascade") with nothing else.
    if (history.length === 0 && /^(?:hi|hello|hey|greetings)\b[\s,!.]*\w*[!.]*$/i.test(p)) return true;
    return false;
  }

  /**
   * A terse option/menu selection ("3", "b)", "option 2") replying to an
   * ongoing conversation. These inherit the prior turn's intent — they are
   * usually an ACTION choice, so they must not be short-circuited to a
   * tool-less direct answer, and a context-free on-device hint about them
   * is noise (the hint classifier never saw the conversation).
   */
  private looksLikeTerseOptionReply(prompt: string): boolean {
    const p = prompt.trim();
    return /^\(?(?:\d{1,2}|[a-d])[.)]?$/i.test(p) || /^(?:option|choice)\s+\d{1,2}$/i.test(p);
  }

  private looksLikeSimpleArtifactTask(prompt: string): boolean {
    return /create .*\.(txt|md|json|csv)\b/i.test(prompt)
      && !/(research|compare|thorough|pdf|report|analy[sz]e|architecture|multi-agent)/i.test(prompt);
  }

  private looksLikeConversational(prompt: string): boolean {
    const LOW_COMPLEXITY = [
      /^(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|sounds good)\b/i,
      /^(?:what is|what are|what'?s|list|show me|tell me|who is|who are|who'?re|where is|when is|how do i)\b/i,
      // Self-identity / capability questions ("who are you", "what can you do",
      // "who made you") are pure conversation — never a multi-agent build.
      /^(?:who|what)\b.*\byou\b/i,
      /^what can you\b/i,
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

  /**
   * Strong, explicit signals that a task needs the full hierarchy (planning +
   * multiple sections/workers). Deliberately conservative: requires a
   * build/implementation verb AND either an app/system-scale noun or an
   * explicit multi-part structure, so ordinary single-file asks (handled as
   * Simple/Moderate) don't get over-escalated.
   */
  /** Shared build/scale signals for the complexity floors below. */
  private buildSignals(prompt: string): { buildVerb: boolean; scaleCount: number; multiPart: boolean } {
    const p = prompt.trim();
    if (p.length < 24) return { buildVerb: false, scaleCount: 0, multiPart: false };
    const buildVerb = /\b(?:build|implement|create|develop|design|scaffold|refactor|migrate|architect|set up|integrate)\b/i.test(p);
    const scaleCount = (p.match(/\b(?:app(?:lication)?|system|platform|service|api|backend|frontend|full[- ]?stack|website|dashboard|pipeline|microservices?|database schema|authentication|end[- ]to[- ]end|codebase|project|multiple files|several (?:files|modules|components)|test suite)\b/gi) ?? []).length;
    const multiPart = /(?:\b(?:and|then|also|plus|as well as)\b.*\b(?:and|then|also)\b)|(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/i.test(p); // 2+ conjunctions or a list
    return { buildVerb, scaleCount, multiPart };
  }

  /**
   * A build prompt with REAL scale: multiple system-level deliverables, or a
   * deliverable plus explicitly multi-part phrasing. Only these floor to the
   * full T1→T2→T3 hierarchy — "create a todo app" is a build prompt too, but
   * flooring every small build to Complex was the #1 token bomb (3-5 managers
   * × workers for a task one worker handles).
   */
  private looksClearlyComplex(prompt: string): boolean {
    const s = this.buildSignals(prompt);
    return s.buildVerb && (s.scaleCount >= 2 || (s.scaleCount >= 1 && s.multiPart));
  }

  /** A small single-deliverable build — real work, but one manager's worth. */
  private looksLikeModerateBuild(prompt: string): boolean {
    const s = this.buildSignals(prompt);
    return s.buildVerb && (s.scaleCount >= 1 || s.multiPart);
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

  /**
   * Raises a raw complexity verdict (from the classifier LLM or a caller hint)
   * to the tier the prompt's signals demand. A small model that under-rates
   * clearly multi-step build work can't strand it below where it belongs:
   * explicit build+scale signals floor it to Complex (full T1→T2→T3), and a
   * single-deliverable build floors a "Simple" up to Moderate (one manager).
   * Conservative on purpose — the source is free to go higher, and a manual
   * tier override is the escape hatch. Records the decision it makes.
   */
  private floorComplexity(
    prompt: string,
    verdict: TaskComplexity,
    source: string,
    reason?: string,
  ): TaskComplexity {
    if (verdict !== 'Complex' && this.looksClearlyComplex(prompt)) {
      this.recordDecision('complexity', `Complex — heuristic floor over ${source} "${verdict}": explicit multi-step build/implementation signals (T1 engaged)`);
      return 'Complex';
    }
    if (verdict === 'Simple' && this.looksLikeModerateBuild(prompt)) {
      this.recordDecision('complexity', `Moderate — heuristic floor over ${source} "Simple": build signals without multi-system scale (single manager)`);
      return 'Moderate';
    }
    this.recordDecision('complexity', `${verdict} — ${source}${reason ? `: ${reason}` : ''}`);
    return verdict;
  }

  private async determineComplexity(
    prompt: string,
    workspacePath: string,
    conversationHistory: ConversationMessage[] = [],
    hint?: Exclude<TaskComplexity, 'Highly Complex'>,
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

    // A caller-supplied verdict (e.g. an opt-in on-device classifier) lets us
    // skip the classifier LLM round-trip entirely. Apply the SAME heuristic
    // floors as the classifier path so a small model under-rating clearly
    // multi-step work can't strand it below the tier it needs.
    // Exception: a terse option reply ("3") carries no signal on its own — the
    // on-device classifier never saw the conversation, so its verdict is noise.
    // Fall through to the LLM classifier, which reads the recent history.
    if (hint) {
      if (this.looksLikeTerseOptionReply(prompt) && conversationHistory.length > 0) {
        this.recordDecision(
          'complexity',
          `terse option reply — on-device hint "${hint}" ignored; classifying with conversation context`,
        );
      } else {
        return this.floorComplexity(prompt, hint, 'on-device hint');
      }
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
      // Take the FIRST verdict word that appears anywhere in the reply, not just
      // the very first token. Local models often prepend a preamble or markdown
      // ("**Simple** — …", "This is a simple request"), and the old "first token
      // only" parse fell through to Complex for anything unexpected — routing a
      // trivial prompt into the full T1→T2→T3 build. First-occurrence ordering
      // still ignores a reason that merely *mentions* a higher level later
      // ("Moderate — not complex enough …" → Moderate).
      const match = content.toLowerCase().match(/\b(simple|moderate|complex)\b/);
      const reason = content.replace(/^\S+\s*[—–-]*\s*/, '').trim();
      let verdict: TaskComplexity;
      if (match) {
        const raw = match[1] === 'simple' ? 'Simple' : match[1] === 'moderate' ? 'Moderate' : 'Complex';
        verdict = this.floorComplexity(prompt, raw, 'classifier', reason || 'no reason given');
      } else {
        // Unparseable verdict (common with chatty local models). Default by
        // length, but do NOT cap a clearly-complex-looking long prompt at
        // Moderate — otherwise a small model's garbled reply strands real build
        // work at T2 and T1 never runs. Short prompts stay cheap (Simple).
        const words = prompt.trim().split(/\s+/).length;
        verdict = words <= 12 ? 'Simple'
          : (words >= 40 || this.looksClearlyComplex(prompt)) ? 'Complex'
          : 'Moderate';
        this.recordDecision('complexity', `${verdict} — classifier output unparseable; defaulted by length/signals`);
      }
      return verdict;
    } catch (err) {
      // Don't swallow the real reason — a mistyped key, an unreachable provider,
      // or an empty model response all land here and previously vanished behind
      // "classifier unavailable". Log it so it's visible in the server output.
      const detail = err instanceof Error ? err.message : String(err);
      if (this.listenerCount('log') > 0) this.emit('log', { level: 'warn', message: `Complexity classifier failed: ${detail}` });
      else console.warn(`[cascade] Complexity classifier failed: ${detail}`);
      const followUpPrompt = /^(proceed|continue|go ahead|do it|yes|yep|ok|okay|carry on)$/i.test(prompt.trim());
      if (followUpPrompt && recentHistory.length > 0) {
        this.recordDecision('complexity', 'Complex — classifier unavailable; short follow-up inherits prior context');
        return 'Complex';
      }
      // A transient classifier failure must not silently route every task into
      // the most expensive full-hierarchy path — default to Moderate instead.
      this.recordDecision('complexity', `Moderate — classifier unavailable (${detail}); defaulting to the mid-cost route`);
      return 'Moderate';
    }
  }

  async run(options: CascadeRunOptions): Promise<CascadeRunResult> {
    await this.init();
    // Reset the per-task budget allowance so this run starts with a fresh ceiling.
    this.router.beginRun();
    // Wire the abort signal into the router so a cancel aborts in-flight LLM
    // calls (not just the checkpoints between them) — i.e. near-instant cancel.
    // A multi-tier run fans the SAME signal out to many concurrent tier/provider
    // calls, each adding an 'abort' listener — well past Node's default ceiling
    // of 10, which logged a MaxListenersExceededWarning. Raise the limit for
    // this run's signal so the warning doesn't fire (the listeners are expected
    // and are removed when their calls settle).
    if (options.signal) setMaxListeners(64, options.signal);
    this.router.setRunSignal(options.signal);
    const startMs = Date.now();
    const taskId = randomUUID();
    this.decisionLog = [];
    // Sections finished by THIS run. Reset per run so a checkpoint can never
    // restore work from an earlier, unrelated task.
    this.currentRunCompleted = [];
    this.wroteCheckpointThisRun = false;
    this.completedNormally = false;
    // Cleared only when a run starts WITHOUT resuming; prepareDurableResume
    // sets it just before the resumed run begins, so it must survive that reset.
    if (!this.claimedResumeId) this.resumedFrom = undefined;

    // "Fast answer": a single mid-tier model, no orchestration, no tools, no
    // verification — the quickest, cheapest path for simple asks.
    if (options.fastAnswer) {
      return this.runFastAnswer(options, startMs, taskId);
    }

    // Auto fast answer for pure small talk: hosts often augment the prompt
    // (memories, delivery guidance, documents), so the routing decision reads
    // `routingPrompt` — the user's actual message — when the host provides it.
    // Without this, "hi" spun up a real T3 worker whose synthesized assignment
    // carried the augmentation, which small models echoed as phantom artifacts.
    const routingPrompt = options.routingPrompt ?? options.prompt;
    const pinnedTier = ['T1', 'T2', 'T3'].includes(this.config.routing?.forceTier ?? '');
    if (
      this.config.fastAnswer?.autoSimple !== false &&
      !pinnedTier &&
      this.looksLikeSmallTalk(routingPrompt, options.conversationHistory)
    ) {
      this.recordDecision('complexity', 'Simple — heuristic: small talk → direct answer (no worker, no classifier call)');
      return this.runFastAnswer(options, startMs, taskId, { auto: true });
    }

    // Extended context: compact an over-budget history/input to fit the model
    // window before any tier sees it (no-op unless enabled + something overflows).
    options = await this.applyExtendedContext(options);

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

    // 1. Determine complexity — a manual override (routing.forceTier) skips
    // the classifier entirely and pins the run's root tier.
    const forceTier = this.config.routing?.forceTier;
    const forced: TaskComplexity | undefined =
      forceTier === 'T1' ? 'Complex' : forceTier === 'T2' ? 'Moderate' : forceTier === 'T3' ? 'Simple' : undefined;
    let complexity: TaskComplexity;
    if (forced) {
      complexity = forced;
      this.recordDecision('complexity', `${forced} — manually forced via routing.forceTier=${forceTier}`);
    } else {
      complexity = await this.determineComplexity(
        routingPrompt,
        options.workspacePath || process.cwd(),
        options.conversationHistory,
        options.complexityHint,
      );
    }

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
          // Analyze the user's actual request, not the host-augmented prompt —
          // delivery guidance/memories would poison the task-type profile.
          const model = await this.taskAnalyzer!.selectModel(routingPrompt, tier, this.router.getSelector());
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

    // Thread recent conversation into the ROOT task so a follow-up is resolved
    // in context. Without this the execution tiers only received the bare latest
    // message (the classifier saw history, execution didn't) — so a short reply
    // like "1" ran as a standalone task. No-op when there's no history.
    const rootPrompt = buildContextualPrompt(options.prompt, options.conversationHistory);

    let finalOutput = '';
    // One breaker per run, shared by every tier below. It exists so a model that
    // is failing every call — dead key, wrong id, exhausted quota — costs the
    // run a handful of calls to discover instead of one per subtask plus a
    // retry each.
    const runBreaker = new RunBreaker(this.config.budget?.failureThreshold);
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
      // Accumulate finished sections so an interruption can checkpoint them.
      tier.on('section:complete', (e: CompletedNode) => {
        if (e.status !== 'COMPLETED' && e.status !== 'PARTIAL') return;
        this.currentRunCompleted.push(e);
        this.emit('section:complete', e);
      });
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
      t3.setPresenter(true); // Simple run: this T3 IS the answer — stream it live.
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
        description: rootPrompt,
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
      t2.setRunBreaker(runBreaker);
      t2.setEscalationCallback((ctx) => this.requestEscalationDecision(ctx, taskId, options.signal));
      t2.setPresenter(true); // Moderate run: T2's aggregated synthesis is the answer — stream it.
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
        description: rootPrompt,
        expectedOutput: 'A complete resolution of the task.',
        constraints: [],
        t3Subtasks: []
      };
      const t2Result = await t2.execute(assignment, taskId, options.signal);
      this.emit('tier:status', { tierId: 't2-root', status: 'COMPLETED', role: 'T2' });
      t2Results = [t2Result];
      const completed = t2Result.t3Results.filter((r: T3Result) => r.status === 'COMPLETED');
      if (completed.length > 0) {
        finalOutput = composeRootSectionOutput(
          t2Result,
          completed.map((r: T3Result) => (typeof r.output === 'string' ? r.output : JSON.stringify(r.output))),
        );
      } else {
        // Don't return a bare "Task failed" — surface whatever the worker(s)
        // produced plus the concrete reason(s), so the user (and logs) can see
        // WHY (e.g. an empty model response or a self-test failure) instead of a
        // dead end. Prefer the longest partial output as the salvageable answer.
        const partial = t2Result.t3Results
          .map((r: T3Result) => (typeof r.output === 'string' ? r.output : ''))
          .filter((o) => o.trim())
          .sort((a, b) => b.length - a.length)[0];
        // Section-level issues too: an unanswered escalation is recorded on the
        // T2 result, so reading only t3Results told the user why the worker
        // struggled but not that a decision had been requested and timed out.
        const reasons = Array.from(
          new Set([
            ...(t2Result.issues ?? []),
            ...t2Result.t3Results.flatMap((r: T3Result) => r.issues ?? []),
          ].filter(Boolean)),
        );
        if (partial) {
          finalOutput = reasons.length ? `${partial}\n\n_(incomplete: ${reasons.join('; ')})_` : partial;
        } else {
          finalOutput = reasons.length
            ? `The task could not be completed: ${reasons.join('; ')}`
            : 'The task could not be completed — the model returned no usable output.';
        }
      }
    } else {
      const t1 = new T1Administrator(this.router, this.toolRegistry, this.config);
      t1.setRunBreaker(runBreaker);
      t1.setEscalationCallback((ctx) => this.requestEscalationDecision(ctx, taskId, options.signal));
      t1.setPresenter(true); // Complex run: T1's final compile is the answer — stream it.
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
      
      const result = await t1.execute(rootPrompt, options.images, undefined, options.signal);
      finalOutput = result.output;
      t2Results = result.t2Results;
    }

    // A budget stop inside a T3 worker (or a T2/T1 call the wave machinery
    // wraps) is caught internally so one dead-end subtask can't crash the
    // whole run — it comes back as a normal FAILED/PARTIAL result, same as any
    // other tool error. That means it silently bypassed the dedicated handling
    // below (`run:budget-exceeded`, `lastInterruptedRun` for `/continue`): a
    // Moderate run could finish looking like an ordinary failure, and a
    // Complex run could carry on through review/compilation with every further
    // call guaranteed to fail. The router's own state is checked directly here
    // — after the tier has returned, regardless of how deep in the hierarchy
    // the cap was actually hit or how that layer chose to report it — and
    // re-raised so the one correct handler for this class of stop still runs.
    const budgetInfo = this.router.budgetExceededInfo();
    if (budgetInfo) throw new CascadeRouter.BudgetExceededError(budgetInfo.reason);

    // The run stopped because a model was failing every call. T1 composes its
    // answer from the section summaries, which is why this used to surface as
    // "a series of system-level errors" — true, but not something anyone can
    // act on. Lead with the provider's actual complaint instead, so the reader
    // learns it was a rate limit or a dead key and can go fix it.
    const trip = runBreaker.reason();
    if (trip) {
      // The run did not throw — it degraded — so this path needs its own
      // checkpoint. Fixing the key or switching model and resuming is exactly
      // the recovery this stop is asking for.
      await this.checkpointRun(taskId, options.prompt, finalOutput || '', 'breaker', trip.message);
      finalOutput = [
        `⚠ **Run stopped early — ${trip.modelId} was failing every request.**`,
        '',
        trip.message,
        '',
        `Cascade stopped after ${trip.failures} consecutive failures rather than retrying every remaining ` +
        'subtask against the same model, which would have cost more and produced the same result.',
        finalOutput ? `\n---\n\n${finalOutput}` : '',
      ].join('\n').trimEnd();
    }
    // Reaching here means the run produced its result the ordinary way — UNLESS
    // the breaker tripped, which falls through this same path with a warning
    // stitched onto the output. A breaker trip on the first operation completes
    // no section and writes no replacement checkpoint, so calling it "normal
    // completion" deleted the claim it should have preserved.
    this.completedNormally = trip == null;
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
        // Cancelling is a decision to stop NOW, not a decision to throw away the
        // sections that already finished. Checkpointing lets /continue pick them
        // back up; the file is pruned by age and count like any other.
        await this.checkpointRun(taskId, options.prompt, finalOutput || '', 'cancelled',
          err instanceof Error ? err.message : 'Task cancelled');
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
        await this.checkpointRun(taskId, options.prompt, finalOutput || '', 'budget', err.message);
        if (!finalOutput) finalOutput = `⚠ Stopped to avoid runaway cost: ${err.message}`;
        runError = null;
      } else {
        // An unexpected error still re-throws — the caller must see it — but the
        // finished sections are no longer lost with it. This is the case that
        // made resume worth building: a crash used to discard every completed
        // node, so the next attempt paid for all of them a second time.
        await this.checkpointRun(taskId, options.prompt, finalOutput || '', 'error',
          err instanceof Error ? err.message : String(err));
        runError = err;
        throw err;
      }
    } finally {
      // Always release pending permission escalations so they don't leak
      // across runs — even on error paths. cancelAllPending is safe to call
      // when there are no pending requests.
      try { escalator.cancelAllPending(); } catch { /* non-critical */ }

      // The resumed run has now either checkpointed its own progress or finished,
      // so the claim it was resuming from is safe to discard.
      try { await this.settleClaimedResume(this.completedNormally); } catch { /* non-critical */ }

      // Same for section escalations. A run that ended while one was parked
      // (error, abort, budget kill) must not leave a live timer and an
      // unresolved promise holding the next run's map.
      try { this.releasePendingEscalations(); } catch { /* non-critical */ }

      // Restore tier models to the configured baseline so Cascade Auto's
      // per-task picks don't leak into /why, the status bar, or the next run.
      this.router.restoreTierModels();
      this.router.setRunSignal(undefined);

      // Record model performance for future auto-selection
      if (this.taskAnalyzer) {
        try {
          const stats = this.router.getStats();
          // Pass the run's token volume so the tracker learns which models tend
          // to fail on larger contexts (drives "send big contexts elsewhere").
          this.taskAnalyzer.recordRunOutcome(runError ? 'failure' : 'success', stats.costByTier, stats.totalTokens);
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

    // Opt-in: distill this finished session into durable project knowledge so
    // future runs remember it. Fire-and-forget after the result is ready — it
    // must never delay or fail the run, and it's undoable from the Knowledge tab.
    if (!runError && this.config.memory?.rememberSessions) {
      void this.rememberSession(options, finalOutput).catch(() => { /* best-effort */ });
    }

    return {
      output: finalOutput,
      sessionId: options.sessionId ?? '',
      taskId,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: stats.totalTokens,
        estimatedCostUsd: stats.totalCostUsd,
        // At least one call ran on a model with no known price, so its spend is
        // missing from the total above. Say so rather than letting the caller
        // present an undercount as the final figure.
        ...(stats.untrackedCostCalls > 0 ? { costUnknown: true } : {}),
      },
      t2Results,
      durationMs,
      costByTier: stats.costByTier,
      tokensByTier: stats.tokensByTier,
      costByFeature: stats.costByFeature,
      costPercentByTier: this.router.getTierCostPercentages(),
    };
  }

  /**
   * Direct single-model reply — the "fast answer" path. No planning, no workers,
   * no tools, no artifact verification: the user's message (with recent history)
   * answered by one mid-tier model, streamed as the primary output and shaped
   * into the normal CascadeRunResult so persistence + the run receipt still work.
   */
  private async runFastAnswer(
    options: CascadeRunOptions,
    startMs: number,
    taskId: string,
    { auto = false }: { auto?: boolean } = {},
  ): Promise<CascadeRunResult> {
    const tier: TierRole = 'T2'; // mid quality/cost
    const selector = this.router.getSelector();
    const model = options.fastAnswerModel
      ? selector.selectForTier(tier, options.fastAnswerModel)
      : (selector.getCandidatesForTier(tier)[0] ?? selector.selectForTier(tier));
    if (!model) {
      throw new Error('No model is available for a fast answer — add a provider API key first.');
    }
    this.recordDecision(
      'model',
      `Fast answer${auto ? ' (auto)' : ''} → ${model.provider}:${model.id} — direct single-model reply (no orchestration)`,
    );
    this.emit('tier:status', { tierId: 'fast', role: tier, status: 'ACTIVE', model: `${model.provider}:${model.id}` });

    // Persona parity with the worker path: an active identity speaks here too.
    let identityPrompt = '';
    if (this.store) {
      const identityId = options.identityId || this.config.defaultIdentityId;
      if (identityId) {
        const identity = this.store.listIdentities().find((i) => i.id === identityId);
        if (identity?.systemPrompt) identityPrompt = identity.systemPrompt + '\n\n';
      }
    }

    const history = (options.conversationHistory ?? []).slice(-10);
    const userContent: ConversationMessage['content'] = options.images?.length
      ? [
          { type: 'text', text: options.prompt },
          ...options.images.map((image) => ({ type: 'image' as const, image })),
        ]
      : options.prompt;
    const messages: ConversationMessage[] = [...history, { role: 'user', content: userContent }];
    const systemPrompt =
      identityPrompt +
      'You are Cascade in fast mode. Answer the user directly, accurately and concisely. ' +
      'You have no tools and cannot run code, browse, or create files — do not claim to.';

    let streamed = '';
    // With an image, let the router pick a vision-capable model instead of pinning.
    const requireVision = !!options.images?.length;
    let result: Awaited<ReturnType<CascadeRouter['generate']>> | undefined;
    try {
      result = await this.router.generate(
        tier,
        { messages, systemPrompt, maxTokens: 2048, ...(requireVision ? {} : { model }) },
        (chunk) => {
          streamed += chunk.text;
          this.emit('stream:token', { tierId: 'fast', text: chunk.text, primary: true });
          options.streamCallback?.({ text: chunk.text, finishReason: null });
        },
        requireVision,
      );
    } catch (err) {
      // Mirror the orchestrated path: a cancel resolves (with whatever streamed)
      // rather than rejecting, so the host can flag the turn cancelled.
      if (err instanceof CascadeCancelledError || options.signal?.aborted) {
        this.emit('run:cancelled', { taskId, reason: err instanceof Error ? err.message : 'Task cancelled' });
        this.emit('tier:status', { tierId: 'fast', role: tier, status: 'COMPLETED', model: `${model.provider}:${model.id}` });
        const stats = this.router.getStats();
        return {
          output: streamed,
          sessionId: options.sessionId ?? '',
          taskId,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: stats.totalTokens,
            estimatedCostUsd: stats.totalCostUsd,
            ...(stats.untrackedCostCalls > 0 ? { costUnknown: true } : {}),
          },
          t2Results: [],
          durationMs: Date.now() - startMs,
          costByTier: stats.costByTier,
          tokensByTier: stats.tokensByTier,
          costByFeature: stats.costByFeature,
          costPercentByTier: this.router.getTierCostPercentages(),
        };
      }
      throw err;
    } finally {
      // The orchestrated path clears the run signal in its own teardown; this
      // path returns early, so detach it here or the next run leaks listeners.
      this.router.setRunSignal(undefined);
    }
    this.emit('tier:status', { tierId: 'fast', role: tier, status: 'COMPLETED', model: `${model.provider}:${model.id}` });

    const stats = this.router.getStats();
    return {
      output: result.content || streamed,
      sessionId: options.sessionId ?? '',
      taskId,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: stats.totalTokens,
        estimatedCostUsd: stats.totalCostUsd,
        ...(stats.untrackedCostCalls > 0 ? { costUnknown: true } : {}),
      },
      t2Results: [],
      durationMs: Date.now() - startMs,
      costByTier: stats.costByTier,
      tokensByTier: stats.tokensByTier,
      costByFeature: stats.costByFeature,
      costPercentByTier: this.router.getTierCostPercentages(),
    };
  }

  /**
   * Distill a completed session into durable facts and store them in the
   * project knowledge graph (opt-in via memory.rememberSessions). Best-effort:
   * skips trivial exchanges, uses one cheap T3 call, and swallows all errors.
   */
  private async rememberSession(options: CascadeRunOptions, output: string): Promise<void> {
    const db = this.router.getWorldStateDB?.();
    if (!db) return;
    const history = options.conversationHistory ?? [];
    if (!sessionWorthRemembering(history, options.prompt, output)) return;
    const transcript = buildSessionTranscript(history, options.prompt, output);
    const facts = await distillSessionFacts(transcript, async (prompt) => {
      const res = await this.router.generate('T3', {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
        temperature: 0,
      });
      return res.content;
    });
    for (const f of facts) db.upsertFact(f.entity, f.relation, f.value, 'session-memory');
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
