// ─────────────────────────────────────────────
//  Cascade AI — T2 Manager
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import type {
  ConversationMessage,
  EscalationPayload,
  ModelInfo,
  PeerMessageEvent,
  PermissionRequest,
  PermissionDecision,
  T1ToT2Assignment,
  T2Result,
  T2ToT3Assignment,
  T3Result,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { BaseTier } from './base.js';
import { T3Worker, canProduceFiles, canProduceNonDiskDeliverables } from './t3-worker.js';
import { MemoryStore } from '../../memory/store.js';
import { PeerBus } from '../peer/bus.js';
import type { PermissionEscalator } from '../permissions/escalator.js';
import type { ToolCreator } from '../../tools/tool-creator.js';
import { RunBreaker } from '../run-breaker.js';
import type { EscalationDecision, TaskType } from '../../types.js';
import { RedactionLayer } from '../audit/redaction.js';
import { sectionNeedsDecision, settledEscalationStatus } from './escalation-policy.js';
import { describeGenerationForPlanner } from '../multimodal/registry.js';
import { compileSubtaskGraph } from '../orchestration/adapters.js';
import { planSpecShape, typedFieldRules } from './plan-spec.js';

// Built per-run so the peer-coordination hint only appears when the
// peer_message tool is actually registered. On a restricted host (e.g. cloud
// pure-chat) the planner isn't told to hand out peerT3Ids for a tool that
// doesn't exist. With the full tool set the prompt is unchanged.
//
// Takes the same tool-presence predicate as buildT1SystemPrompt/buildWorkerRules
// rather than a single boolean: T2 is a planner too — it is the tier that turns
// "make a video" into the actual subtask list — so it needs the same
// capability awareness T1 gets, or T1's terminating generate_video step is
// decomposed back into script-and-direction prose one level down.
export function buildT2SystemPrompt(has: (toolName: string) => boolean): string {
  const generation = describeGenerationForPlanner(has);
  return [
    'You are a T2 Manager agent in the Cascade AI system.',
    // Must agree with the decomposition prompt in decomposeSection(), which is
    // the one carrying the actual instruction. It said 1-4 and "the FEWEST that
    // fully cover it"; this said 2-5. The model received both, so its floor was
    // simultaneously one and two, and the cheaper reading — pad to two — costs a
    // real worker call on every small section.
    'Your role is to analyze a section of a task and decompose it into 1-4 discrete subtasks for T3 Workers — the fewest that fully cover it.',
    'If subtasks have dependencies, you can specify "executionMode": "sequential" for the section.',
    has('peer_message') && 'Provide "peerT3Ids" to subtasks so they can coordinate using the peer_message tool.',
    'Return ONLY valid JSON matching the T3 subtask array schema — no other text.',
    generation && `\n${generation}`,
  ]
    .filter((l): l is string => l !== false && l !== '')
    .join('\n');
}

export class T2Manager extends BaseTier {
  protected router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private assignment?: T1ToT2Assignment;
  private sectionModel?: ModelInfo;
  /**
   * The task type `sectionModel` was selected under. Carried into every call
   * that uses it so routing evidence lands on this exact selection — one tier
   * can select the same model for two kinds of work in a run, and only the one
   * that reaches a provider should be credited.
   */
  private sectionTaskType?: TaskType;
  private t3Workers: Map<string, T3Worker> = new Map();
  private escalations: EscalationPayload[] = [];
  private peerSyncBuffer: Array<{ fromId: string; content: unknown; timestamp: string }> = [];
  private store?: MemoryStore;
  private runBreaker?: RunBreaker;
  private t3PeerBus: PeerBus = new PeerBus();   // ← T3↔T3 bus (local to this T2)
  private t2PeerBus?: PeerBus;
  private permissionEscalator?: PermissionEscalator;
  private toolCreator?: ToolCreator;
  /**
   * Asked when a section ends ESCALATED — i.e. a worker hit something it could
   * not decide alone. Without this the escalation was a dead end: the status
   * said "needs a decision" and no decision was ever requested, so an MCP run
   * that legitimately needed input just stopped there.
   */
  private escalationCallback?: (
    ctx: { sectionId: string; sectionTitle: string; issues: string[]; summary: string },
  ) => Promise<EscalationDecision>;

  /**
   * The one allowed retry has been spent. Retrying is bounded because an
   * escalation loop that can re-ask forever burns a budget on a question that
   * is not resolving; a second escalation is terminal instead.
   */
  private escalationRetryUsed = false;

  /** Optional boardroom gate (Moderate / root-T2 runs) — pauses after decomposition. */
  private planApprovalCallback?: (
    subtasks: ReadonlyArray<{ subtaskId: string; subtaskTitle: string; description: string }>,
    sectionTitle: string,
  ) => Promise<{ approved: boolean; note?: string; keepSubtaskIds?: string[] }>;
  /** AbortController for the current T3 wave — aborted on cancel-and-respawn */
  private waveAbortController: AbortController | null = null;

  setPeerBus(bus: PeerBus): void {
    this.t2PeerBus = bus;
    this.t2PeerBus.register(this.id);

    // Listen for messages from sibling T2s
    this.t2PeerBus.on(`message:${this.id}`, (msg) => {
      this.log(`T2 peer message from ${msg.fromId}`);
      this.receivePeerSync(msg.fromId, msg.payload);
    });
  }

  setPeerMessageCallback(cb: (event: PeerMessageEvent) => void, sessionId: string): void {
    this.t3PeerBus.onPeerMessage = cb;
    this.t3PeerBus.sessionId = sessionId;
    if (this.t2PeerBus) {
      this.t2PeerBus.onPeerMessage = cb;
      this.t2PeerBus.sessionId = sessionId;
    }
  }



  constructor(router: CascadeRouter, toolRegistry: ToolRegistry, parentId: string) {
    super('T2', undefined, parentId);
    this.router = router;
    this.toolRegistry = toolRegistry;
  }

  /**
   * Share the run-wide circuit breaker. Every T2 in a run gets the SAME
   * instance: three sections each failing once against a dead model is the
   * same fact as one section failing three times, and a per-section breaker
   * would never see it.
   */
  setRunBreaker(breaker: RunBreaker): void {
    this.runBreaker = breaker;
  }

  setStore(store: MemoryStore): void {
    this.store = store;
  }

  /**
   * Inject the shared PermissionEscalator for this task run.
   * The escalator will also be given this T2's evaluator function.
   */
  setPermissionEscalator(escalator: PermissionEscalator): void {
    this.permissionEscalator = escalator;
    escalator.setT2Evaluator((req) => this.evaluatePermissionAtT2(req));
  }

  setToolCreator(creator: ToolCreator): void {
    this.toolCreator = creator;
  }

  /** Ask the user what to do when a section escalates. */
  setEscalationCallback(
    cb: (ctx: { sectionId: string; sectionTitle: string; issues: string[]; summary: string }) => Promise<EscalationDecision>,
  ): void {
    this.escalationCallback = cb;
  }

  /** Boardroom gate for Moderate (root-T2) runs: pause after decomposition. */
  setPlanApprovalCallback(
    cb: (
      subtasks: ReadonlyArray<{ subtaskId: string; subtaskTitle: string; description: string }>,
      sectionTitle: string,
    ) => Promise<{ approved: boolean; note?: string; keepSubtaskIds?: string[] }>,
  ): void {
    this.planApprovalCallback = cb;
  }

  /**
   * Phase 1 of T2 peer discussion: broadcast this section's plan so sibling T2s
   * and T1 can detect overlaps and coordinate execution order.
   * Called BEFORE execute() begins the agent loop.
   */
  announcePlan(assignment: T1ToT2Assignment): void {
    if (!this.t2PeerBus) return;
    const payload = {
      type: 'T2_PLAN_ANNOUNCEMENT',
      sectionId: assignment.sectionId,
      sectionTitle: assignment.sectionTitle,
      description: assignment.description,
      subtaskTitles: assignment.t3Subtasks?.map(s => s.subtaskTitle) ?? [],
      keywords: this.extractKeywords(assignment),
    };
    this.t2PeerBus.broadcast(this.id, payload);
    this.log(`[T2] Announced plan for section: ${assignment.sectionTitle}`);
  }

  /**
   * Phase 2: After this section completes, share the output with sibling T2s
   * so they can reference it in their final compilation if relevant.
   */
  shareCompletedOutput(sectionId: string, output: string): void {
    if (!this.t2PeerBus) return;
    const payload = { type: 'T2_SECTION_OUTPUT', sectionId, output };
    this.t2PeerBus.broadcast(this.id, payload);
  }

  private extractKeywords(assignment: T1ToT2Assignment): string[] {
    const text = `${assignment.sectionTitle} ${assignment.description}`.toLowerCase();
    // Extract file-like tokens and key nouns for overlap detection
    const fileTokens = text.match(/[\w./-]+\.(ts|js|tsx|jsx|py|md|json|yaml|txt|html|css|sh)\b/gi) ?? [];
    const wordTokens = text.match(/\b(?:auth|database|api|server|client|config|deploy|test|ui|model|schema|route|endpoint|migration|component)\b/gi) ?? [];
    return [...new Set([...fileTokens, ...wordTokens].map(t => t.toLowerCase()))];
  }

  receivePeerSync(fromId: string, content: unknown): void {
    this.peerSyncBuffer.push({
      fromId,
      content,
      timestamp: new Date().toISOString(),
    });
    this.emit('peer-sync-received', { fromId, content });
  }

  async execute(assignment: T1ToT2Assignment, taskId: string, signal?: AbortSignal): Promise<T2Result> {
    this.signal = signal;
    this.assignment = assignment;
    this.taskId = taskId;
    this.setLabel(assignment.sectionTitle);
    const m = this.router.getModelForTier('T2');
    if (m) this.setServingModel(`${m.provider}:${m.id}`);
    this.setStatus('ACTIVE');

    this.sendStatusUpdate({
      progressPct: 0,
      currentAction: `Analyzing section: ${assignment.sectionTitle}`,
      status: 'IN_PROGRESS',
    });

    this.log(`T2 managing section: ${assignment.sectionTitle}`);

    // Cascade Auto: route this section to the benchmark-best model for its type
    this.sectionModel = undefined;
    this.sectionTaskType = undefined;
    try {
      const sectionText = `${assignment.sectionTitle} ${assignment.description} ${assignment.expectedOutput}`;
      const picked = await this.router.selectModelForSubtask('T2', sectionText);
      this.sectionModel = picked?.model;
      this.sectionTaskType = picked?.taskType;
      if (this.sectionModel) {
        this.log(`Cascade Auto: routing this section to ${this.sectionModel.provider}:${this.sectionModel.id}`);
      }
    } catch { /* fall back to the tier model */ }

    try {
      // ── Cancellation checkpoint: before section decomposition ──
      this.throwIfCancelled();

      let subtasks = assignment.t3Subtasks.length > 0
        ? assignment.t3Subtasks
        : await this.decomposeSection(assignment);

      // Boardroom gate (planApproval: 'all'): review the decomposition before any
      // T3 spawns — approve, drop subtasks, or steer with one re-decompose pass.
      if (this.planApprovalCallback) {
        const decision = await this.planApprovalCallback(subtasks, assignment.sectionTitle);
        if (!decision.approved) {
          const output = 'Plan rejected — nothing was executed.';
          this.setStatus('COMPLETED', output);
          this.sendStatusUpdate({ progressPct: 100, currentAction: 'Plan rejected by user', status: 'IN_PROGRESS', output });
          return { sectionId: assignment.sectionId, sectionTitle: assignment.sectionTitle, status: 'COMPLETED', t3Results: [], sectionSummary: output, issues: [] };
        }
        if (decision.keepSubtaskIds?.length) {
          const keep = new Set(decision.keepSubtaskIds);
          subtasks = subtasks.filter((s) => keep.has(s.subtaskId));
        }
        if (decision.note?.trim()) {
          subtasks = await this.decomposeSection({
            ...assignment,
            description: `${assignment.description}\n\nGuidance (must be followed): ${decision.note}`,
          });
        }
      }

      this.sendStatusUpdate({
        progressPct: 20,
        currentAction: `Dispatching ${subtasks.length} T3 workers`,
        status: 'IN_PROGRESS',
      });

      // ── Cancellation checkpoint: before T3 dispatch ──
      this.throwIfCancelled();

      const t3Results = await this.executeSubtasks(subtasks, taskId);

      this.sendStatusUpdate({
        progressPct: 90,
        currentAction: 'Aggregating T3 results',
        status: 'IN_PROGRESS',
      });

      // `let`: a skipped escalation re-aggregates to keep the escalated output.
      let summary = await this.aggregateResults(assignment, t3Results);
      const issues = t3Results
        .filter((r) => r.status !== 'COMPLETED')
        .flatMap((r) => r.issues);

      let overallStatus = this.determineStatus(t3Results);
      // Set only by the explicit 'skip' branch below, and only when that skip
      // was a genuine human answer — carried onto the returned T2Result so
      // T1's reviewer pass can tell "the user chose to keep this as-is" from
      // an ordinary shortfall (see userSkipped on the T2Result type). A skip
      // the SDK produced itself (no listener, autonomy: 'auto', an aborted
      // run — see EscalationDecision.automatic) is not that: nobody reviewed
      // the section, so it must stay eligible for T1's corrective pass.
      let userSkipped = false;

      // Ask whenever ANY worker escalated — not only when the whole section
      // came back ESCALATED. determineStatus checks `some(COMPLETED)` first, so
      // a section with one finished worker and one that stopped on a question
      // reports PARTIAL, and gating on the aggregate status skipped the prompt
      // entirely: the question was never asked, and the escalated worker's
      // output was dropped by the COMPLETED-only aggregation on the way past.
      const hasEscalated = sectionNeedsDecision(t3Results);

      // Keep the work and settle on a status T1 will act on correctly. Its
      // compile filter is `status !== 'FAILED'`, so leaving a section ESCALATED
      // lets it through as if it were finished — the exact dead end this
      // feature exists to remove.
      const settleEscalated = async (reason?: string) => {
        if (reason) issues.push(reason);
        summary = await this.aggregateResults(assignment, t3Results, { includeEscalated: true });
        overallStatus = settledEscalationStatus(t3Results);
      };

      // An escalated section means a worker hit something it could not decide.
      // Until now that was the end of the line — the status said "needs a
      // decision" and nobody was ever asked for one. Ask, and act on the answer.
      if (hasEscalated && this.escalationCallback && this.escalationRetryUsed) {
        // The one allowed retry already ran and escalated again. Asking a second
        // time is how a run burns its budget on a question that is not
        // resolving, so this is terminal — but the work is still kept.
        await settleEscalated('Escalated again after the retry — no further attempts were made.');
      } else if (hasEscalated && !this.escalationCallback) {
        // Nothing can ask (a bare T2Manager, or a host that never wired the
        // gate). Settle rather than leaking ESCALATED past T1's filter.
        await settleEscalated();
      } else if (hasEscalated && this.escalationCallback) {
        this.sendStatusUpdate({
          progressPct: 95,
          currentAction: 'Escalated — waiting for your decision',
          status: 'ESCALATING',
        });
        const decision = await this.escalationCallback({
          sectionId: assignment.sectionId,
          sectionTitle: assignment.sectionTitle,
          issues,
          summary,
        });
        this.log(`Escalation decision for "${assignment.sectionTitle}": ${decision.action}`);

        if (decision.action === 'skip') {
          // "Skip" means keep what this section produced and move on — so the
          // escalated work has to survive, and previously it did not. Every
          // downstream consumer filters on COMPLETED: aggregateResults returns
          // "no T3 workers completed" and T1 drops FAILED sections from the
          // compile entirely. A one-worker section (the common shape) therefore
          // discarded exactly the output the user had just chosen to keep.
          //
          // So re-aggregate counting the escalated outputs, and stay PARTIAL
          // even when nothing reached COMPLETED: PARTIAL is what carries the
          // section past T1's filter, and it is also the honest status — work
          // exists, it just is not finished.
          summary = await this.aggregateResults(assignment, t3Results, { includeEscalated: true });
          overallStatus = settledEscalationStatus(t3Results);
          userSkipped = decision.automatic !== true;
        } else if (decision.action === 'retry' || decision.action === 'guidance') {
          // Bounded to a single attempt: an escalation loop that can re-ask
          // forever is how a run burns a budget on a question that never
          // resolves. Recorded as a flag rather than by clearing the callback,
          // because clearing it made the gate silently vanish on the retry —
          // a second escalation then returned status ESCALATED unasked, which
          // T1 compiles as though the section had finished.
          this.escalationRetryUsed = true;
          const guided = decision.action === 'guidance' && decision.note?.trim()
            ? {
                ...assignment,
                description: `${assignment.description}\n\nGuidance (must be followed): ${decision.note.trim()}`,
                // Drop T1's preplanned subtasks so the retry re-decomposes with
                // the guidance in hand. The workers execute from their subtask
                // slices, not from this description — leaving the slices in
                // place gave "Retry with guidance" byte-identical worker
                // prompts to "Retry as-is", making the note do nothing at all.
                t3Subtasks: [],
              }
            : assignment;
          // Re-run the section with the answer applied. The retry keeps its
          // callback so a second escalation still reaches the terminal branch
          // above instead of slipping through as an unasked ESCALATED.
          return await this.execute(guided, taskId, signal);
        } else {
          // 'timeout' — nobody answered. Fail with the reason attached rather
          // than hanging: in cloud the run is holding server resources, and a
          // silent stall is indistinguishable from a crash.
          issues.push('Escalated, but no decision was received in time.');
          overallStatus = 'FAILED';
        }
      }

      const isOk = overallStatus === 'COMPLETED' || overallStatus === 'PARTIAL';
      this.setStatus(isOk ? 'COMPLETED' : 'FAILED', summary);

      // Say what actually happened. This read "Section complete" unconditionally
      // — two lines after computing a status that may well be FAILED — so a
      // section whose every worker died still announced completion. The node
      // badge was right (it comes from this.status, set just above); only this
      // text disagreed with it, which is why the Cockpit showed a failure icon
      // next to the word "complete".
      const sectionAction = overallStatus === 'COMPLETED' ? 'Section complete'
        : overallStatus === 'PARTIAL' ? 'Section partially complete — some subtasks failed'
        : overallStatus === 'ESCALATED' ? 'Section escalated — needs a decision'
        : 'Section failed — no subtask completed';
      this.sendStatusUpdate({ progressPct: 100, currentAction: sectionAction, status: 'IN_PROGRESS', output: summary });

      // ── Build result first, then publish to peers ──
      const result: T2Result = {
        sectionId: assignment.sectionId,
        sectionTitle: assignment.sectionTitle,
        status: overallStatus,
        t3Results,
        sectionSummary: summary,
        issues,
        ...(userSkipped ? { userSkipped: true } : {}),
      };

      this.publishSectionOutput(result); // ← now result exists to publish

      return result;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.setStatus('FAILED', errMsg);

      const failedResult: T2Result = {
        sectionId: assignment.sectionId,
        sectionTitle: assignment.sectionTitle,
        status: 'FAILED',
        t3Results: [],
        sectionSummary: '',
        issues: [`T2 execution error: ${errMsg}`],
      };

      this.publishSectionOutput(failedResult); // ← publish failures too so dependents don't hang

      return failedResult;
    }
  }

  // ── Private ──────────────────────────────────

  private async decomposeSection(assignment: T1ToT2Assignment): Promise<T2ToT3Assignment['subtaskId'] extends string ? T2ToT3Assignment[] : never> {
    const peerPlans = this.peerSyncBuffer
      .filter(p => (p.content as any)?.type === 'T2_PLAN_ANNOUNCEMENT')
      .map(p => `[Peer ${p.fromId} Plan]: ${(p.content as any).sectionTitle} - ${(p.content as any).subtaskTitles?.join(', ')}`)
      .join('\n');

    // The same capability signal T1 plans against and the acceptance rung grades
    // against. T2 is a planner too — it is the tier that writes the `files` and
    // `acceptance` a worker is actually held to — so it asking for a file the
    // run cannot produce is enough on its own to fail the subtask.
    const toolNames = this.toolRegistry.getToolDefinitions().map((t) => t.name);
    const spec = planSpecShape(canProduceFiles(toolNames), canProduceNonDiskDeliverables(toolNames));
    const prompt = `Decompose this section into 1-4 concrete subtasks for T3 workers — the FEWEST that fully cover it (one subtask is the correct answer for a small section).${spec.preamble ? `\n\n${spec.preamble}` : ''}

Section: ${assignment.sectionTitle}
Description: ${assignment.description}
Expected output: ${assignment.expectedOutput}
Constraints: ${assignment.constraints.join('; ')}
${peerPlans ? `\nContext from sibling T2 plans (use this to align execution and avoid overlaps):\n${peerPlans}\n` : ''}
Return a JSON array of subtask objects, each with:
- subtaskId: string (unique)
- subtaskTitle: string
- description: string
- expectedOutput: string
- constraints: string[]
- peerT3Ids: string[] (empty for now)
- dependsOn: string[] (array of subtaskIds this task depends on to start)
- executionMode: "parallel|sequential" (default is parallel)
${typedFieldRules(spec)}
- contextBrief: string (1-3 short sentences with ALL the background the worker needs — it sees nothing else)

Return ONLY the JSON array.`;

    const messages: ConversationMessage[] = [{ role: 'user', content: prompt }];
    const result = await this.generateTracked('T2', {
      messages,
      systemPrompt: this.systemPromptOverride + buildT2SystemPrompt((name) => this.toolRegistry.hasTool(name)) + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
      maxTokens: 2000,
      ...(this.sectionModel
          ? { model: this.sectionModel, selectionTaskType: this.sectionTaskType }
          : {}),
    });

    try {
      const jsonMatch = /\[[\s\S]*\]/.exec(result.content);
      if (!jsonMatch) throw new Error('No JSON array found');
      const parsed = JSON.parse(jsonMatch[0]) as T2ToT3Assignment[];
      // Same class of bug as T1's plan (see T1Administrator.validatePlan):
      // the LLM's JSON doesn't honor `constraints: string[]` being required,
      // and every T3 prompt builder calls `.join`/`.map` on it unguarded.
      return parsed.map((a) => ({ ...a, sectionTitle: assignment.sectionTitle, constraints: a.constraints ?? [] }));
    } catch {
      // Fallback: single subtask = the whole section
      return [{
        subtaskId: randomUUID(),
        subtaskTitle: assignment.sectionTitle,
        description: assignment.description,
        expectedOutput: assignment.expectedOutput,
        constraints: assignment.constraints,
        peerT3Ids: [],
        parentT2: this.id,
        sectionTitle: assignment.sectionTitle,
        dependsOn: [],
        executionMode: 'parallel',
      }];
    }
  }

  private buildWorkerMap(assignments: T2ToT3Assignment[], taskId: string): Map<string, T3Worker> {
    const workerMap = new Map<string, T3Worker>();
    for (const a of assignments) {
      const worker = new T3Worker(this.router, this.toolRegistry, this.id);
      if (this.store) worker.setStore(this.store, taskId);
      // Graph identity is the subtask id, which is what a sibling's dependsOn
      // names — the worker's own tier id is generated and means nothing to the
      // graph. The wave is stamped by the execution loop below.
      worker.setGraphPosition({ nodeId: a.subtaskId, dependsOn: a.dependsOn ?? [] });
      worker.setPeerBus(this.t3PeerBus);
      if (this.permissionEscalator) worker.setPermissionEscalator(this.permissionEscalator);
      if (this.toolCreator) worker.setToolCreator(this.toolCreator);

      workerMap.set(a.subtaskId, worker);
      this.t3Workers.set(a.subtaskId, worker);

      worker.on('stream:token', (e) => this.emit('stream:token', e));
      worker.on('log', (e) => this.emit('log', e));
      worker.on('tier:status', (e) => this.emit('tier:status', e));
      worker.on('tool:approval-request', (e) => this.emit('tool:approval-request', {
        ...e,
        __cascadeResponder: (decision: { approved: boolean; always?: boolean }) =>
          worker.emit(`tool:approval-response:${e.id}`, decision),
      }));
    }
    return workerMap;
  }

  private async executeSubtasks(
    subtasks: Array<Omit<T2ToT3Assignment, 'parentT2'>>,
    taskId: string,
  ): Promise<T3Result[]> {
    const assignments: T2ToT3Assignment[] = subtasks.map((s) => ({
      ...s,
      parentT2: this.id,
    }));

    // Wire peer IDs and sanitize dependencies
    const allKeys = new Set(assignments.map((a) => a.subtaskId));
    for (const a of assignments) {
      a.peerT3Ids = assignments
        .filter((x) => x.subtaskId !== a.subtaskId)
        .map((x) => x.subtaskId);
      a.dependsOn = (a.dependsOn ?? []).filter((d) => allKeys.has(d));
    }

    // Create T3 workers
    const workerMap = new Map<string, T3Worker>();
    const workers: T3Worker[] = assignments.map((a) => {
      const worker = new T3Worker(this.router, this.toolRegistry, this.id);
      if (this.store) worker.setStore(this.store, taskId);

      // ← Inject the shared T3 peer bus
      worker.setPeerBus(this.t3PeerBus);

      // ← Inject the permission escalator so T3 uses T2→T1→User flow
      if (this.permissionEscalator) {
        worker.setPermissionEscalator(this.permissionEscalator);
      }

      // ← Inject optional ToolCreator for runtime tool generation
      if (this.toolCreator) {
        worker.setToolCreator(this.toolCreator);
      }

      workerMap.set(a.subtaskId, worker);
      this.t3Workers.set(a.subtaskId, worker);

      // Bubble up events
      worker.on('stream:token', (e) => this.emit('stream:token', e));
      worker.on('log', (e) => this.emit('log', e));
      worker.on('tier:status', (e) => this.emit('tier:status', e));
      worker.on('tool:call', (e) => this.emit('tool:call', e));
      worker.on('tool:result', (e) => this.emit('tool:result', e));
      worker.on('tool:approval-request', (e) => this.emit('tool:approval-request', {
        ...e,
        __cascadeResponder: (decision: { approved: boolean; always?: boolean }) =>
          worker.emit(`tool:approval-response:${e.id}`, decision),
      }));

      return worker;
    });

    // ── Dependency-aware execution ────────────
    return this.runWithDependencies(assignments, workerMap, taskId);
  }

  /**
   * Runs T3 workers respecting dependsOn declarations.
   *
   * Uses Kahn's algorithm for topological ordering:
   *  1. Build an in-degree map from the dependency graph.
   *  2. Detect cycles — if any exist, break them by removing the offending edge
   *     and logging a warning (so the run degrades gracefully instead of deadlocking).
   *  3. Execute workers in waves: start all zero-in-degree tasks in parallel,
   *     then reduce in-degrees of their dependents and repeat.
   */
  private async runWithDependencies(
    assignments: T2ToT3Assignment[],
    workerMap: Map<string, T3Worker>,
    taskId: string,
  ): Promise<T3Result[]> {
    // ── Build graph ────────────────────────────
    //
    // Validation and cycle repair are compileSubtaskGraph's job — the same
    // compiler T1 uses for sections, so a plan is checked by one implementation
    // instead of two that drifted. It replaces the local breakCycles(), which
    // (like T1's copy) treated every node a topological pass could not reach as
    // cyclic. That set also holds everything DOWNSTREAM of a cycle, whose
    // in-degree can never reach zero while its dependency is stuck, so breaking
    // one cycle also cut the dependencies of innocent later subtasks and ran
    // them in the first wave — before the work they consume. The compiler uses
    // strongly connected components, so only real cycle members are touched.
    //
    // Execution stays here rather than moving to DependencyScheduler: this loop
    // adds nodes mid-run (T3→T2 reinforcements), re-runs a whole wave after tool
    // synthesis (respawnBudget) and short-circuits on the run breaker. The
    // scheduler executes a fixed DAG and cannot express any of those.
    const compiled = compileSubtaskGraph(assignments);
    for (const issue of compiled.issues) {
      this.log(`⚠ Subtask graph: ${issue.message}`);
    }
    const sanitizedAssignments = compiled.graph.nodes.map((node) => {
      const assignment = node.payload;
      const original = assignment.dependsOn ?? [];
      const repaired = node.dependsOn;
      // Same object when nothing was dropped, a copy when it was. breakCycles
      // had exactly this contract — it never mutated the caller's assignments —
      // and the worker prompt reads dependsOn off whichever it gets.
      const unchanged = repaired.length === original.length
        && repaired.every((dependencyId, index) => dependencyId === original[index]);
      return unchanged ? assignment : { ...assignment, dependsOn: [...repaired] };
    });

    // adjacency: subtaskId → set of subtaskIds that depend on it
    const adj = new Map<string, Set<string>>();
    // inDegree: how many unresolved dependencies each task has
    const inDegree = new Map<string, number>();
    // resolved outputs
    const resultMap = new Map<string, T3Result>();

    for (const a of sanitizedAssignments) {
      if (!adj.has(a.subtaskId)) adj.set(a.subtaskId, new Set());
      inDegree.set(a.subtaskId, 0);
    }
    for (const a of sanitizedAssignments) {
      for (const dep of a.dependsOn ?? []) {
        adj.get(dep)!.add(a.subtaskId);
        inDegree.set(a.subtaskId, (inDegree.get(a.subtaskId) ?? 0) + 1);
      }
    }

    // ── Wave-based execution ───────────────────
    //
    // Each iteration: collect all tasks with inDegree = 0, run them in parallel,
    // then decrement in-degrees of their dependents.
    //
    // respawnBudget: how many times a wave may be cancelled and re-run after
    // dynamic tool synthesis. Capped at 1 to prevent infinite loops.

    let remaining = new Set(sanitizedAssignments.map((a) => a.subtaskId));
    let wave = 0;
    let respawnBudget = 1;
    // T3→T2 reinforcement: bounded sibling-worker spawns requested by workers.
    const reinforceCfg = this.router.getReinforcementsConfig?.() ?? { enabled: false, maxPerSection: 4 };
    let reinforcementsAdded = 0;

    while (remaining.size > 0) {
      // The breaker is open: the model these workers would use is failing every
      // call, so launching them buys nothing but latency and spend. Mark the
      // rest skipped — with the reason — instead of running them to watch them
      // fail. This is the whole point of the breaker: pay once to learn the key
      // is dead, not once per subtask.
      if (this.runBreaker?.isOpen()) {
        const why = this.runBreaker.skipMessage();
        this.log(`Run breaker open — skipping ${remaining.size} remaining subtask(s)`);
        for (const id of remaining) {
          this.t3PeerBus.publish(this.id, id, why, 'FAILED');
          resultMap.set(id, {
            subtaskId: id,
            status: 'FAILED',
            output: why,
            testResults: { checksRun: [], passed: [], failed: [] },
            issues: [why],
            peerSyncsUsed: [],
            correctionAttempts: 0,
          });
        }
        remaining.clear();
        break;
      }

      // Collect all runnable tasks this wave
      const runnableIds = [...remaining].filter((id) => (inDegree.get(id) ?? 0) === 0);

      if (runnableIds.length === 0) {
        // Safety net: should not happen after cycle breaking, but if it does,
        // force-unblock the lowest-in-degree remaining task to prevent stalling.
        const fallbackId = [...remaining].sort(
          (a, b) => (inDegree.get(a) ?? 0) - (inDegree.get(b) ?? 0),
        )[0]!;
        this.log(`⚠ Dependency stall detected — force-starting: ${fallbackId}`);
        inDegree.set(fallbackId, 0);
        runnableIds.push(fallbackId);
      }

      wave++;
      // Stamp before the wave runs, so the first event each worker emits
      // already carries it. T2 keeps its own loop rather than using
      // DependencyScheduler (it adds workers mid-run and re-runs waves after
      // tool synthesis), so the counter is local — but it means the same thing
      // as the scheduler's, which is what a client needs.
      for (const id of runnableIds) workerMap.get(id)?.setGraphPosition({ wave });
      this.log(`Wave ${wave}: running ${runnableIds.length} subtask(s) in parallel`);
      this.sendStatusUpdate({
        progressPct: 20 + Math.min(wave * 10, 60),
        currentAction: `T3 wave ${wave}: ${runnableIds.map((id) =>
          sanitizedAssignments.find((a) => a.subtaskId === id)?.subtaskTitle ?? id
        ).join(', ')}`,
        status: 'IN_PROGRESS',
      });

      // ── Cancellation checkpoint: between each T3 wave ────────────
      this.throwIfCancelled();

      // Fresh AbortController per wave — aborted on cancel-and-respawn
      this.waveAbortController = new AbortController();
      const waveSignal = AbortSignal.any(
        [this.signal, this.waveAbortController.signal].filter(Boolean) as AbortSignal[],
      );
      // Every worker in the wave shares this signal, and each provider call
      // beneath them attaches its own 'abort' listener to it. A wave wider
      // than Node's default ceiling of ten therefore logged a
      // MaxListenersExceededWarning on a perfectly ordinary run — the same
      // fan-out already accounted for on the top-level run signal and the
      // router's per-run one. The listeners come off as their calls settle.
      setMaxListeners(64, waveSignal);

      // Execute this wave — parallel for cloud, sequential for local (t3Execution).
      const runOne = async (id: string) => {
        const assignment = sanitizedAssignments.find((a) => a.subtaskId === id)!;
        const worker = workerMap.get(id)!;
        const result = await worker.execute(assignment, taskId, waveSignal);
        // Per-path privacy tier: a local-only subtask's raw output never
        // travels above T3 — the tiers above see only a success/fail signal.
        if (result.localOnly) {
          result.output = `[local-only path — output withheld by privacy policy; status: ${result.status}; ` +
            `checks passed: ${result.testResults.passed.length}/${result.testResults.checksRun.length || 0}]`;
        } else {
          // Redact secrets/PII at the T3→T2 boundary so only logic travels up
          // the chain. output may be a structured object — redact strings only.
          if (typeof result.output === 'string' && result.output) {
            result.output = RedactionLayer.redact(result.output);
          }
        }
        if (result.issues) result.issues = result.issues.map((i) => RedactionLayer.redact(i));
        resultMap.set(id, result);
        return result;
      };

      let waveResults: PromiseSettledResult<Awaited<ReturnType<typeof runOne>>>[];
      if (this.router.getT3ExecutionMode?.() === 'sequential') {
        this.log(`Wave ${wave}: running ${runnableIds.length} subtask(s) sequentially (local tier)`);
        waveResults = [];
        for (const id of runnableIds) {
          try { waveResults.push({ status: 'fulfilled', value: await runOne(id) }); }
          catch (reason) { waveResults.push({ status: 'rejected', reason }); }
        }
      } else {
        waveResults = await Promise.allSettled(runnableIds.map(runOne));
      }

      // ── Cancel-and-respawn: if ANY worker in this wave escalated for tool synthesis,
      // cancel the whole wave, synthesize the tool once, then re-run ALL wave workers
      // with fresh instances that have the new tool available.
      const escalatedToolIdx = respawnBudget > 0
        ? waveResults.findIndex(
            (r) => r.status === 'fulfilled' &&
              r.value.status === 'ESCALATED' &&
              r.value.issues.some((iss) => iss.includes('dynamic tool generation')),
          )
        : -1;

      if (escalatedToolIdx !== -1 && this.toolCreator) {
        respawnBudget--;
        this.waveAbortController.abort();

        const escalatedId = runnableIds[escalatedToolIdx]!;
        const escalatedAssignment = sanitizedAssignments.find((a) => a.subtaskId === escalatedId)!;

        this.log(`Wave ${wave}: tool escalation detected — synthesizing tool then respawning all ${runnableIds.length} worker(s)`);
        this.sendStatusUpdate({
          progressPct: 50,
          currentAction: `Synthesizing dynamic tool for: ${escalatedAssignment.subtaskTitle}`,
          status: 'IN_PROGRESS',
        });

        const toolName = await this.toolCreator.createTool(
          `Help complete: ${escalatedAssignment.subtaskTitle}`,
          escalatedAssignment.description,
        );

        if (toolName) {
          this.log(`Tool "${toolName}" created — respawning wave ${wave} workers`);
          // Stamp all wave assignments so fresh T3s know about the tool
          for (const a of sanitizedAssignments) {
            if (runnableIds.includes(a.subtaskId)) {
              a.description += `\n\n[SYSTEM]: Dynamic tool "${toolName}" is now available — use it to complete your task.`;
            }
          }
          // Share the new tool over the worker bus so peers register it instead
          // of regenerating the same capability.
          const spec = this.toolCreator.getSpec(toolName);
          if (spec) this.t3PeerBus.broadcast(this.id, { type: 'TOOL_CREATED', spec });
        }

        // Clear only current-wave outputs so prior-wave completions remain accessible to dependents
        for (const id of runnableIds) {
          this.t3PeerBus.clearOutput(id);
        }

        // Rebuild fresh T3Worker instances for this wave
        const freshMap = this.buildWorkerMap(
          sanitizedAssignments.filter((a) => runnableIds.includes(a.subtaskId)),
          taskId,
        );
        for (const [k, v] of freshMap) workerMap.set(k, v);

        // Re-queue all wave IDs
        for (const id of runnableIds) {
          remaining.add(id);
          inDegree.set(id, 0);
        }
        wave--; // keep wave counter accurate (will be incremented again at top)
        continue;
      }

      // ── Normal wave completion: reduce in-degrees, handle rejections ─
      for (let i = 0; i < runnableIds.length; i++) {
        const id = runnableIds[i]!;
        remaining.delete(id);

        const r = waveResults[i]!;
        if (r.status === 'rejected') {
          // Tell the breaker before deciding to retry. A systemic failure —
          // dead key, wrong model id, exhausted quota — will fail the retry the
          // same way and every worker after it, so past the threshold we stop
          // paying to confirm it.
          const assignment = sanitizedAssignments.find((a) => a.subtaskId === id)!;
          const failedModel = workerMap.get(id)?.getServingModel();
          const tripped = this.runBreaker?.record(r.reason, failedModel);
          if (tripped) {
            this.log(`Run breaker opened: ${tripped.failures} consecutive ${tripped.kind} failures on ${tripped.modelId} — stopping`);
            this.emit('run:breaker', tripped);
          }

          if (this.runBreaker?.isOpen()) {
            const why = this.runBreaker.skipMessage();
            this.log(`T3 worker ${id} failed and the run breaker is open — not retrying`);
            this.t3PeerBus.publish(this.id, id, why, 'FAILED');
            resultMap.set(id, {
              subtaskId: id,
              status: 'FAILED',
              output: why,
              testResults: { checksRun: [], passed: [], failed: [] },
              issues: [why],
              peerSyncsUsed: [],
              correctionAttempts: 0,
            });
            for (const dependent of adj.get(id) ?? []) {
              inDegree.set(dependent, Math.max(0, (inDegree.get(dependent) ?? 0) - 1));
            }
            continue;
          }

          this.log(`T3 worker ${id} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)} — retrying once`);
          try {
            const retried = await this.retryT3(assignment, taskId);
            resultMap.set(id, retried);
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            this.log(`T3 retry for ${id} threw before publishing — unblocking dependents with FAILED`);
            this.t3PeerBus.publish(this.id, id, `Retry failed: ${msg}`, 'FAILED');
            resultMap.set(id, {
              subtaskId: id,
              status: 'FAILED',
              output: `Retry threw: ${msg}`,
              testResults: { checksRun: [], passed: [], failed: [] },
              issues: [msg],
              peerSyncsUsed: [],
              correctionAttempts: 1,
            });
          }
        }

        for (const dependent of adj.get(id) ?? []) {
          inDegree.set(dependent, Math.max(0, (inDegree.get(dependent) ?? 0) - 1));
        }
      }

      // ── T3→T2 reinforcement: spawn the sibling workers requested this wave ──
      // (bounded by maxPerSection; the workers are depth-1 so they can't request
      // more, and the while-loop runs them as a normal wave honoring t3Execution).
      if (reinforceCfg.enabled && reinforcementsAdded < reinforceCfg.maxPerSection) {
        let addedThisWave = 0;
        for (const id of runnableIds) {
          for (const req of resultMap.get(id)?.reinforcements ?? []) {
            if (reinforcementsAdded >= reinforceCfg.maxPerSection) break;
            reinforcementsAdded++;
            addedThisWave++;
            const assignment: T2ToT3Assignment = {
              ...req,
              subtaskId: `reinf-${this.id}-${reinforcementsAdded}`,
              dependsOn: [],
              peerT3Ids: [],
            };
            sanitizedAssignments.push(assignment);
            adj.set(assignment.subtaskId, new Set());
            inDegree.set(assignment.subtaskId, 0);
            remaining.add(assignment.subtaskId);
            const fresh = this.buildWorkerMap([assignment], taskId);
            for (const [k, v] of fresh) { v.markAsReinforcement(); workerMap.set(k, v); }
            this.log(`Reinforcement: spawned worker "${assignment.subtaskTitle}" (requested by ${id})`);
          }
        }
        if (addedThisWave > 0) {
          this.sendStatusUpdate({ progressPct: 55, currentAction: `Added ${addedThisWave} reinforcement worker(s)`, status: 'IN_PROGRESS' });
        }
      }
    }

    return [...resultMap.values()];
  }



  private async retryT3(assignment: T2ToT3Assignment, taskId: string): Promise<T3Result> {
    this.log(`Retrying T3 for subtask: ${assignment.subtaskTitle}`);
    const worker = new T3Worker(this.router, this.toolRegistry, this.id);
    if (this.store) worker.setStore(this.store, taskId);
    worker.setPeerBus(this.t3PeerBus); // ← wire bus on retry too
    // Bring this to parity with buildWorkerMap()'s wiring — without the
    // escalator a retried worker fell back to the escalator-less legacy
    // approval path (no autonomy awareness, always waits on a live human
    // decision), and without the tier:status/log forwarding its progress
    // silently stopped reaching the Cockpit graph.
    if (this.permissionEscalator) worker.setPermissionEscalator(this.permissionEscalator);
    if (this.toolCreator) worker.setToolCreator(this.toolCreator);
    worker.on('log', (e) => this.emit('log', e));
    worker.on('tier:status', (e) => this.emit('tier:status', e));
    worker.on('stream:token', (e) => this.emit('stream:token', e));
    worker.on('tool:approval-request', (e) => this.emit('tool:approval-request', {
      ...e,
      __cascadeResponder: (decision: { approved: boolean; always?: boolean }) =>
        worker.emit(`tool:approval-response:${e.id}`, decision),
    }));
    return worker.execute(
      { ...assignment, description: `[RETRY] ${assignment.description}` },
      taskId,
      this.signal,
    );
  }

  private publishSectionOutput(result: T2Result): void {
    this.t2PeerBus?.publish(
      this.id,
      result.sectionId,
      result.sectionSummary,
      result.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
    );
  }

  private async aggregateResults(
    assignment: T1ToT2Assignment,
    results: T3Result[],
    opts: { includeEscalated?: boolean } = {},
  ): Promise<string> {
    // Escalated workers usually DID produce something — they stopped on a
    // decision, not on a failure. Normally that output is excluded because the
    // section is still open; once the user has answered "skip", keeping it is
    // the whole point of the answer.
    const completed = results.filter(
      (r) => r.status === 'COMPLETED' || (opts.includeEscalated && r.status === 'ESCALATED' && r.output),
    );
    if (!completed.length) return `Section ${assignment.sectionTitle} failed — no T3 workers completed.`;

    const peerOutputs = this.peerSyncBuffer
      .filter(p => (p.content as any)?.type === 'T2_SECTION_OUTPUT')
      .map(p => `[Peer ${p.fromId} Output]: ${(p.content as any).output}`)
      .join('\n\n');

    const peerContext = peerOutputs ? `\n\nContext from sibling T2 completed sections (use this to ensure your summary aligns with the overall state):\n${peerOutputs}` : '';
    const MAX_CHUNK_LENGTH = 15000; // Roughly ~3.5k tokens safety limit

    let currentSummary = '';
    let i = 0;

    // Rolling map-reduce for large outputs
    while (i < completed.length) {
      let chunkText = '';
      let chunkEnd = i;

      while (chunkEnd < completed.length) {
        const nextOutput = `[T3-${chunkEnd + 1}]: ${completed[chunkEnd]!.output}\n\n`;
        if (chunkText.length + nextOutput.length > MAX_CHUNK_LENGTH && chunkEnd > i) {
          break; // Stop if adding this output exceeds the chunk limit (and we have at least one)
        }
        chunkText += nextOutput;
        chunkEnd++;
      }

      i = chunkEnd;
      const isLastChunk = chunkEnd >= completed.length;

      const prompt = `Summarize these T3 worker outputs for section "${assignment.sectionTitle}" in 2-3 sentences.
  ${currentSummary ? `\nPREVIOUS SUMMARY SO FAR:\n${currentSummary}\n\nNEW OUTPUTS TO INTEGRATE:\n` : '\nOUTPUTS:\n'}${chunkText}${peerContext}`;

      const messages: ConversationMessage[] = [{ role: 'user', content: prompt }];
      try {
        // When this T2 is the run's presenter (a Moderate root run), stream the
        // FINAL synthesis as the primary answer so the desktop shows it live.
        const streamFinal = isLastChunk && this.isPresenter
          ? (chunk: { text: string }) => this.emit('stream:token', { tierId: this.id, text: chunk.text, primary: true })
          : undefined;
        const result = await this.generateTracked('T2', {
          messages,
          systemPrompt: this.systemPromptOverride + 'You are a T2 Manager. Summarize the work of your T3 workers succinctly.' + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
          maxTokens: 500,
          ...(this.sectionModel
          ? { model: this.sectionModel, selectionTaskType: this.sectionTaskType }
          : {}),
        }, streamFinal);
        currentSummary = result.content;
      } catch (err) {
        this.log(`aggregateResults: LLM summarization failed at chunk — returning raw T3 outputs. Error: ${err instanceof Error ? err.message : String(err)}`);
        return currentSummary + '\n\n' + chunkText; // Best effort fallback
      }
    }

    return currentSummary;
  }
  private determineStatus(results: T3Result[]): T2Result['status'] {
    if (results.every((r) => r.status === 'COMPLETED')) return 'COMPLETED';
    if (results.some((r) => r.status === 'COMPLETED')) return 'PARTIAL';
    if (results.some((r) => r.status === 'ESCALATED')) return 'ESCALATED';
    return 'FAILED';
  }

  /**
   * T2-level permission evaluator.
   * - Safe / non-dangerous tools: auto-approve via rules (no LLM call).
   * - Dangerous tools: ask T2's LLM whether the action fits the section goal.
   * - Returns null if the LLM is uncertain (triggers T1 evaluation).
   */
  private async evaluatePermissionAtT2(req: PermissionRequest): Promise<PermissionDecision | null> {
    // Non-dangerous path: already handled by SAFE_TOOLS set in escalator.
    // This method only receives calls for tools that cleared the safe-list.
    if (!req.isDangerous) {
      return {
        requestId: req.id,
        approved: true,
        always: true,
        decidedBy: 'T2',
        reasoning: 'Non-dangerous tool auto-approved by T2 section policy',
      };
    }

    // Dangerous path: LLM inference (max 200 tokens)
    const prompt = `You are a T2 Manager for this section: "${this.assignment?.sectionTitle ?? req.sectionContext}".
Section goal: ${this.assignment?.description ?? req.sectionContext}

A T3 Worker wants to execute:
Tool: ${req.toolName}
Target: ${JSON.stringify(req.input)}
Reason: ${req.subtaskContext}

Is this consistent with the section goal and safe to allow?
Reply with exactly one word: YES, NO, or UNSURE.`;

    try {
      const result = await this.generateTracked('T2', {
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: this.systemPromptOverride + 'You are a T2 Manager evaluating permissions.' + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
        maxTokens: 10,
        temperature: 0,
        ...(this.sectionModel
          ? { model: this.sectionModel, selectionTaskType: this.sectionTaskType }
          : {}),
      });
      const answer = result.content.trim().toUpperCase();
      // Dangerous tools are NEVER final-approved by a tier — a small local
      // model must not silently greenlight a file_write/shell/delete. T2
      // records its advice on the escalation trail and returns null so the
      // request keeps rising to the user (the topmost engaged tier prompts).
      const verdict: 'approve' | 'deny' | 'unsure' =
        answer.includes('YES') ? 'approve' : answer.includes('NO') ? 'deny' : 'unsure';
      (req.trail ??= []).push({ tier: 'T2', verdict, reason: `T2: ${verdict === 'approve' ? 'consistent with section goal' : verdict === 'deny' ? 'inconsistent with section goal' : 'unsure'}` });
      return null;
    } catch {
      (req.trail ??= []).push({ tier: 'T2', verdict: 'unsure', reason: 'T2 evaluation failed' });
      return null; // On error, escalate rather than block
    }
  }
}
