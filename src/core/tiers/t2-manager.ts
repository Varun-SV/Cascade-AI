// ─────────────────────────────────────────────
//  Cascade AI — T2 Manager
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type {
  ConversationMessage,
  EscalationPayload,
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

const T2_SYSTEM_PROMPT = `You are a T2 Manager agent in the Cascade AI system.
Your role is to analyze a section of a task and decompose it into 2-5 discrete subtasks for T3 Workers.
If subtasks have dependencies, you can specify "executionMode": "sequential" for the section.
Provide "peerT3Ids" to subtasks so they can coordinate using the peer_message tool.
Return ONLY valid JSON matching the T3 subtask array schema — no other text.`;

export class T2Manager extends BaseTier {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private assignment?: T1ToT2Assignment;
  private t3Workers: Map<string, T3Worker> = new Map();
  private escalations: EscalationPayload[] = [];
  private peerSyncBuffer: Array<{ fromId: string; content: unknown; timestamp: string }> = [];
  private store?: MemoryStore;
  private t3PeerBus: PeerBus = new PeerBus();   // ← T3↔T3 bus (local to this T2)
  private t2PeerBus?: PeerBus;
  private permissionEscalator?: PermissionEscalator;
  private toolCreator?: ToolCreator;

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
    this.setStatus('ACTIVE');

    this.sendStatusUpdate({
      progressPct: 0,
      currentAction: `Analyzing section: ${assignment.sectionTitle}`,
      status: 'IN_PROGRESS',
    });

    this.log(`T2 managing section: ${assignment.sectionTitle}`);

    try {
      // ── Cancellation checkpoint: before section decomposition ──
      this.throwIfCancelled();

      const subtasks = assignment.t3Subtasks.length > 0
        ? assignment.t3Subtasks
        : await this.decomposeSection(assignment);

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

    const prompt = `Decompose this section into 2-5 concrete subtasks for T3 workers.

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

Return ONLY the JSON array.`;

    const messages: ConversationMessage[] = [{ role: 'user', content: prompt }];
    const result = await this.router.generate('T2', {
      messages,
      systemPrompt: this.systemPromptOverride + T2_SYSTEM_PROMPT + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
      maxTokens: 2000,
    });

    try {
      const jsonMatch = /\[[\s\S]*\]/.exec(result.content);
      if (!jsonMatch) throw new Error('No JSON array found');
      return JSON.parse(jsonMatch[0]) as T2ToT3Assignment[];
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
        executionMode: 'parallel',
      }];
    }
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

    let remaining = new Set(sanitizedAssignments.map((a) => a.subtaskId));
    let wave = 0;

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

      // Execute this wave in parallel
      const waveResults = await Promise.allSettled(
        runnableIds.map(async (id) => {
          const assignment = sanitizedAssignments.find((a) => a.subtaskId === id)!;
          const worker = workerMap.get(id)!;
          const result = await worker.execute(assignment, taskId, this.signal);
          resultMap.set(id, result);
          return result;
        }),
      );

      // Reduce in-degrees for dependents of completed tasks
      for (let i = 0; i < runnableIds.length; i++) {
        const id = runnableIds[i]!;
        remaining.delete(id);

        const r = waveResults[i]!;
        if (r.status === 'rejected') {
          this.log(`T3 worker ${id} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)} — retrying once`);
          const assignment = sanitizedAssignments.find((a) => a.subtaskId === id)!;
          const retried = await this.retryT3(assignment, taskId);
          resultMap.set(id, retried);
        } else if (r.status === 'fulfilled' && r.value.status === 'ESCALATED' && r.value.issues.some(i => i.includes('dynamic tool generation'))) {
          // Tool Creation Redesign: T2 spawns builder -> verifies -> original T3 uses it
          const assignment = sanitizedAssignments.find((a) => a.subtaskId === id)!;
          if (this.toolCreator) {
            this.log(`T3 escalated for tool. T2 spawning Tool-Builder T3 for: ${assignment.subtaskTitle}`);
            this.sendStatusUpdate({
              progressPct: 50,
              currentAction: `Spawning Tool-Builder T3 for: ${assignment.subtaskTitle}`,
              status: 'IN_PROGRESS',
            });
            const toolName = await this.toolCreator.createTool(
              `Help complete: ${assignment.subtaskTitle}`,
              assignment.description,
            );
            if (toolName) {
              this.log(`T2 verifying new tool: ${toolName}`);
              this.sendStatusUpdate({
                progressPct: 60,
                currentAction: `T2 Verifying new tool: ${toolName}`,
                status: 'IN_PROGRESS',
              });
              // Verification step via T2 model
              try {
                const verifyResult = await this.router.generate('T2', {
                  messages: [{ role: 'user', content: `A new tool named "${toolName}" was just created dynamically to help with: ${assignment.description}. Based on its name and purpose, does this seem like a valid addition? Reply "VERIFIED" or "REJECTED".` }],
                  systemPrompt: this.systemPromptOverride + 'You are T2 Manager verifying a dynamic tool.',
                  maxTokens: 50,
                });
                if (!verifyResult.content.toUpperCase().includes('REJECTED')) {
                  this.log(`T2 verification passed for ${toolName}. Restarting original T3.`);
                  const retried = await this.retryT3({
                    ...assignment,
                    description: `${assignment.description}\n\n[SYSTEM NOTIFICATION]: A new dynamic tool "${toolName}" has been built and verified for you. Use it to complete your task.`
                  }, taskId);
                  resultMap.set(id, retried);
                } else {
                  this.log(`T2 rejected the dynamic tool: ${toolName}`);
                  resultMap.set(id, r.value);
                }
              } catch {
                // If verification generation fails, gracefully accept the tool
                const retried = await this.retryT3({
                  ...assignment,
                  description: `${assignment.description}\n\n[SYSTEM NOTIFICATION]: A new dynamic tool "${toolName}" has been built for you. Use it to complete your task.`
                }, taskId);
                resultMap.set(id, retried);
              }
            } else {
              resultMap.set(id, r.value);
            }
          } else {
            resultMap.set(id, r.value);
          }
        }

        for (const dependent of adj.get(id) ?? []) {
          inDegree.set(dependent, Math.max(0, (inDegree.get(dependent) ?? 0) - 1));
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

      const prompt = `Summarize these T3 worker outputs for section "${assignment.sectionTitle}" in 2-3 sentences.
  ${currentSummary ? `\nPREVIOUS SUMMARY SO FAR:\n${currentSummary}\n\nNEW OUTPUTS TO INTEGRATE:\n` : '\nOUTPUTS:\n'}${chunkText}${peerContext}`;

      const messages: ConversationMessage[] = [{ role: 'user', content: prompt }];
      try {
        const result = await this.router.generate('T2', {
          messages,
          systemPrompt: this.systemPromptOverride + 'You are a T2 Manager. Summarize the work of your T3 workers succinctly.' + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
          maxTokens: 500
        });
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
      });
      const answer = result.content.trim().toUpperCase();
      if (answer.includes('YES')) {
        return { requestId: req.id, approved: true, always: true, decidedBy: 'T2', reasoning: 'T2 LLM evaluated: consistent with section goal' };
      }
      if (answer.includes('NO')) {
        return { requestId: req.id, approved: false, always: true, decidedBy: 'T2', reasoning: 'T2 LLM evaluated: inconsistent with section goal' };
      }
      // UNSURE → return null to escalate to T1
      return null;
    } catch {
      return null; // On error, escalate rather than block
    }
  }
}
