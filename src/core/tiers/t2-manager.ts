// ─────────────────────────────────────────────
//  Cascade AI — T2 Manager
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
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
import { T3Worker } from './t3-worker.js';
import { MemoryStore } from '../../memory/store.js';
import { PeerBus } from '../peer/bus.js';
import type { PermissionEscalator } from '../permissions/escalator.js';
import type { ToolCreator } from '../../tools/tool-creator.js';
import { RedactionLayer } from '../audit/redaction.js';

const T2_SYSTEM_PROMPT = `You are a T2 Manager agent in the Cascade AI system.
Your role is to analyze a section of a task and decompose it into 2-5 discrete subtasks for T3 Workers.
If subtasks have dependencies, you can specify "executionMode": "sequential" for the section.
Provide "peerT3Ids" to subtasks so they can coordinate using the peer_message tool.
Return ONLY valid JSON matching the T3 subtask array schema — no other text.`;

export class T2Manager extends BaseTier {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private assignment?: T1ToT2Assignment;
  private sectionModel?: ModelInfo;
  private t3Workers: Map<string, T3Worker> = new Map();
  private escalations: EscalationPayload[] = [];
  private peerSyncBuffer: Array<{ fromId: string; content: unknown; timestamp: string }> = [];
  private store?: MemoryStore;
  private t3PeerBus: PeerBus = new PeerBus();   // ← T3↔T3 bus (local to this T2)
  private t2PeerBus?: PeerBus;
  private permissionEscalator?: PermissionEscalator;
  private toolCreator?: ToolCreator;
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
    try {
      const sectionText = `${assignment.sectionTitle} ${assignment.description} ${assignment.expectedOutput}`;
      this.sectionModel = (await this.router.selectModelForSubtask('T2', sectionText)) ?? undefined;
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

      const summary = await this.aggregateResults(assignment, t3Results);
      const issues = t3Results
        .filter((r) => r.status !== 'COMPLETED')
        .flatMap((r) => r.issues);

      const overallStatus = this.determineStatus(t3Results);
      const isOk = overallStatus === 'COMPLETED' || overallStatus === 'PARTIAL';
      this.setStatus(isOk ? 'COMPLETED' : 'FAILED', summary);

      this.sendStatusUpdate({ progressPct: 100, currentAction: 'Section complete', status: 'IN_PROGRESS', output: summary });

      // ── Build result first, then publish to peers ──
      const result: T2Result = {
        sectionId: assignment.sectionId,
        sectionTitle: assignment.sectionTitle,
        status: overallStatus,
        t3Results,
        sectionSummary: summary,
        issues,
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

    const prompt = `Decompose this section into 1-4 concrete subtasks for T3 workers — the FEWEST that fully cover it (one subtask is the correct answer for a small section).

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
- files: string[] (the EXACT relative paths this subtask creates or edits)
- acceptance: string[] (1-3 mechanically checkable done-criteria: file exists / contains X / command exits 0)
- contextBrief: string (1-3 short sentences with ALL the background the worker needs — it sees nothing else)

Return ONLY the JSON array.`;

    const messages: ConversationMessage[] = [{ role: 'user', content: prompt }];
    const result = await this.router.generate('T2', {
      messages,
      systemPrompt: this.systemPromptOverride + T2_SYSTEM_PROMPT + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
      maxTokens: 2000,
      ...(this.sectionModel ? { model: this.sectionModel } : {}),
    });

    try {
      const jsonMatch = /\[[\s\S]*\]/.exec(result.content);
      if (!jsonMatch) throw new Error('No JSON array found');
      const parsed = JSON.parse(jsonMatch[0]) as T2ToT3Assignment[];
      return parsed.map((a) => ({ ...a, sectionTitle: assignment.sectionTitle }));
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
    // adjacency: subtaskId → set of subtaskIds that depend on it
    const adj = new Map<string, Set<string>>();
    // inDegree: how many unresolved dependencies each task has
    const inDegree = new Map<string, number>();
    // resolved outputs
    const resultMap = new Map<string, T3Result>();

    for (const a of assignments) {
      if (!adj.has(a.subtaskId)) adj.set(a.subtaskId, new Set());
      inDegree.set(a.subtaskId, 0);
    }

    for (const a of assignments) {
      const deps = (a.dependsOn ?? []);
      for (const dep of deps) {
        adj.get(dep)!.add(a.subtaskId);
        inDegree.set(a.subtaskId, (inDegree.get(a.subtaskId) ?? 0) + 1);
      }
    }

    // ── Cycle detection & breaking (Kahn's) ───
    //
    // After a full topological pass, any task still with inDegree > 0
    // is part of a cycle. We break cycles by forcibly zeroing their inDegree
    // and logging a warning so they can still execute (without that dependency).

    const sanitizedAssignments = this.breakCycles(assignments, adj, inDegree);

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
          this.log(`T3 worker ${id} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)} — retrying once`);
          const assignment = sanitizedAssignments.find((a) => a.subtaskId === id)!;
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

  /**
   * Detects cyclic dependencies using Kahn's algorithm and breaks them
   * by removing back-edges. Returns a sanitized copy of assignments.
   *
   * A cycle like t1→t2→t3→t1 is broken at the last edge (t3→t1),
   * meaning t3 will start without waiting for t1, preventing deadlock.
   */
  private breakCycles(
    assignments: T2ToT3Assignment[],
    adj: Map<string, Set<string>>,
    inDegree: Map<string, number>,
  ): T2ToT3Assignment[] {
    // Clone inDegree for simulation
    const degree = new Map(inDegree);
    const queue: string[] = [];
    const visited = new Set<string>();

    for (const [id, d] of degree) {
      if (d === 0) queue.push(id);
    }

    while (queue.length > 0) {
      const id = queue.shift()!;
      visited.add(id);
      for (const dep of adj.get(id) ?? []) {
        const newDeg = (degree.get(dep) ?? 1) - 1;
        degree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }

    // Any node not visited is in a cycle
    const cycleNodes = [...inDegree.keys()].filter((id) => !visited.has(id));

    if (cycleNodes.length === 0) return assignments; // No cycles

    this.log(
      `⚠ Circular dependency detected among subtasks: [${cycleNodes.join(', ')}]. ` +
      `Breaking cycles — affected tasks will run without their cyclic dependencies.`,
    );

    // Sanitize: remove dependsOn references that involve cycle nodes
    return assignments.map((a) => {
      if (!cycleNodes.includes(a.subtaskId)) return a;
      const safeDeps = (a.dependsOn ?? []).filter((d) => !cycleNodes.includes(d));
      if (safeDeps.length !== (a.dependsOn ?? []).length) {
        this.log(
          `  → Breaking cycle: removed ${(a.dependsOn ?? []).filter((d) => cycleNodes.includes(d)).join(', ')} ` +
          `from "${a.subtaskTitle}" dependsOn`,
        );
        // Also decrement inDegree for the removed deps
        for (const removed of (a.dependsOn ?? []).filter((d) => cycleNodes.includes(d))) {
          inDegree.set(a.subtaskId, Math.max(0, (inDegree.get(a.subtaskId) ?? 1) - 1));
          adj.get(removed)?.delete(a.subtaskId);
        }
      }
      return { ...a, dependsOn: safeDeps };
    });
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
  ): Promise<string> {
    const completed = results.filter((r) => r.status === 'COMPLETED');
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
        const result = await this.router.generate('T2', {
          messages,
          systemPrompt: this.systemPromptOverride + 'You are a T2 Manager. Summarize the work of your T3 workers succinctly.' + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
          maxTokens: 500,
          ...(this.sectionModel ? { model: this.sectionModel } : {}),
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
      const result = await this.router.generate('T2', {
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: this.systemPromptOverride + 'You are a T2 Manager evaluating permissions.' + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
        maxTokens: 10,
        temperature: 0,
        ...(this.sectionModel ? { model: this.sectionModel } : {}),
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
