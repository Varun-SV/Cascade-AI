// ─────────────────────────────────────────────
//  Cascade AI — T2 Manager
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type {
  ConversationMessage,
  EscalationPayload,
  T1ToT2Assignment,
  T2Result,
  T2ToT3Assignment,
  T3Result,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { BaseTier } from './base.js';
import { T3Worker } from './t3-worker.js';

const T2_SYSTEM_PROMPT = `You are a T2 Manager agent in the Cascade AI system.
Your role is to analyze a section of a task and decompose it into 2-5 discrete subtasks for T3 Workers.
Return ONLY valid JSON matching the T3 subtask array schema — no other text.`;

export class T2Manager extends BaseTier {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private assignment?: T1ToT2Assignment;
  private t3Workers: Map<string, T3Worker> = new Map();
  private escalations: EscalationPayload[] = [];

  constructor(router: CascadeRouter, toolRegistry: ToolRegistry, parentId: string) {
    super('T2', undefined, parentId);
    this.router = router;
    this.toolRegistry = toolRegistry;
  }

  async execute(assignment: T1ToT2Assignment, taskId: string): Promise<T2Result> {
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
      // If T1 pre-planned subtasks, use them; otherwise decompose ourselves
      const subtasks = assignment.t3Subtasks.length > 0
        ? assignment.t3Subtasks
        : await this.decomposeSection(assignment);

      this.sendStatusUpdate({
        progressPct: 20,
        currentAction: `Dispatching ${subtasks.length} T3 workers`,
        status: 'IN_PROGRESS',
      });

      // Spawn T3 workers
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
      this.setStatus(overallStatus === 'COMPLETED' ? 'COMPLETED' : 'FAILED');

      this.sendStatusUpdate({ progressPct: 100, currentAction: 'Section complete', status: 'IN_PROGRESS' });

      return {
        sectionId: assignment.sectionId,
        sectionTitle: assignment.sectionTitle,
        status: overallStatus,
        t3Results,
        sectionSummary: summary,
        issues,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.setStatus('FAILED');
      return {
        sectionId: assignment.sectionId,
        sectionTitle: assignment.sectionTitle,
        status: 'FAILED',
        t3Results: [],
        sectionSummary: '',
        issues: [`T2 execution error: ${errMsg}`],
      };
    }
  }

  // ── Private ──────────────────────────────────

  private async decomposeSection(assignment: T1ToT2Assignment): Promise<T2ToT3Assignment['subtaskId'] extends string ? T2ToT3Assignment[] : never> {
    const prompt = `Decompose this section into 2-5 concrete subtasks for T3 workers.

Section: ${assignment.sectionTitle}
Description: ${assignment.description}
Expected output: ${assignment.expectedOutput}
Constraints: ${assignment.constraints.join('; ')}

Return a JSON array of subtask objects, each with:
- subtaskId: string (unique)
- subtaskTitle: string
- description: string
- expectedOutput: string
- constraints: string[]
- peerT3Ids: string[] (empty for now)

Return ONLY the JSON array.`;

    const messages: ConversationMessage[] = [{ role: 'user', content: prompt }];
    const result = await this.router.generate('T2', {
      messages,
      systemPrompt: T2_SYSTEM_PROMPT,
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

    // Wire peer sync IDs
    const idMap = new Map(assignments.map((a) => [a.subtaskId, a]));
    for (const a of assignments) {
      a.peerT3Ids = assignments.filter((x) => x.subtaskId !== a.subtaskId).map((x) => x.subtaskId);
    }

    // Create T3 workers
    const workers: T3Worker[] = assignments.map((a) => {
      const worker = new T3Worker(this.router, this.toolRegistry, this.id);
      this.t3Workers.set(a.subtaskId, worker);

      // Bubble up events
      worker.on('stream:token', (e) => this.emit('stream:token', e));
      worker.on('log', (e) => this.emit('log', e));
      worker.on('tier:status', (e) => this.emit('tier:status', e));
      worker.on('tool:approval-request', (e) => this.emit('tool:approval-request', e));

      // Route peer sync
      worker.on('message', (msg) => {
        if (msg.type === 'PEER_SYNC') {
          const target = this.t3Workers.get(msg.payload.recipientT3Id as string);
          if (target) target.receivePeerSync(msg.from, msg.payload.content);
        }
      });

      return worker;
    });

    // Execute all T3s in parallel
    const results = await Promise.allSettled(
      workers.map((w, i) => w.execute(assignments[i]!, taskId)),
    );

    const t3Results: T3Result[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'fulfilled') {
        t3Results.push(r.value);
      } else {
        // T3 crashed — try once more
        const retryResult = await this.retryT3(assignments[i]!, taskId);
        t3Results.push(retryResult);
      }
    }

    return t3Results;
  }

  private async retryT3(assignment: T2ToT3Assignment, taskId: string): Promise<T3Result> {
    this.log(`Retrying T3 for subtask: ${assignment.subtaskTitle}`);
    const worker = new T3Worker(this.router, this.toolRegistry, this.id);
    worker.on('stream:token', (e) => this.emit('stream:token', e));
    worker.on('tool:approval-request', (e) => this.emit('tool:approval-request', e));
    return worker.execute({ ...assignment, description: `[RETRY] ${assignment.description}` }, taskId);
  }

  private async aggregateResults(
    assignment: T1ToT2Assignment,
    results: T3Result[],
  ): Promise<string> {
    const completed = results.filter((r) => r.status === 'COMPLETED');
    if (!completed.length) return `Section ${assignment.sectionTitle} failed — no T3 workers completed.`;

    const outputs = completed.map((r, i) => `[T3-${i + 1}]: ${r.output}`).join('\n\n');
    const prompt = `Summarize these T3 worker outputs for section "${assignment.sectionTitle}" in 2-3 sentences:\n\n${outputs}`;

    const messages: ConversationMessage[] = [{ role: 'user', content: prompt }];
    const result = await this.router.generate('T2', { messages, maxTokens: 300 });
    return result.content;
  }

  private determineStatus(results: T3Result[]): T2Result['status'] {
    if (results.every((r) => r.status === 'COMPLETED')) return 'COMPLETED';
    if (results.some((r) => r.status === 'COMPLETED')) return 'PARTIAL';
    if (results.some((r) => r.status === 'ESCALATED')) return 'ESCALATED';
    return 'FAILED';
  }
}
