// ─────────────────────────────────────────────
//  Cascade AI — T1 Administrator
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type {
  CascadeConfig,
  ConversationMessage,
  EscalationPayload,
  ImageAttachment,
  PermissionDecision,
  PermissionRequest,
  T1ToT2Assignment,
  T2Result,
  TaskComplexity,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { BaseTier } from './base.js';
import { T2Manager } from './t2-manager.js';
import { MemoryStore } from '../../memory/store.js';
import { COMPLEXITY_T2_COUNT } from '../../constants.js';
import { PeerBus } from '../peer/bus.js';
import type { PermissionEscalator } from '../permissions/escalator.js';

const T1_SYSTEM_PROMPT = `You are T1, the Administrator in the Cascade AI orchestration system.

Your responsibilities:
1. Analyze task complexity: Simple | Moderate | Complex | Highly Complex
2. Decompose the task into logical sections (one per T2 Manager)
3. For each section, define 2-5 subtasks for T3 Workers
4. Return a structured plan as JSON

CRITICAL PATH RULE: If the user specifies a target directory (e.g. "inside python_exclusive",
"in the /output folder"), every file path in EVERY T3 subtask's description, expectedOutput,
and constraints MUST include the full relative path.
Example: "python_exclusive/script.py" NOT just "script.py".
The directory must appear verbatim in every subtask that creates or reads a file.
NEVER omit the directory prefix when decomposing into subtasks.

Rules:
- Simple → 1 T3, Moderate → 2-3 T2s, Complex → 3-5 T2s, Highly Complex → 5+ T2s
- Return ONLY valid JSON — no other text
- If the user asks for a PDF, explicitly use the "pdf_create" tool
- If the user asks for Excel/Zip/complex processing, use "run_code" with Python or Node.js
- Ensure every plan includes explicit creation and verification steps for requested artifacts`;

interface TaskPlan {
  complexity: TaskComplexity;
  sections: T1ToT2Assignment[];
  reasoning: string;
}

export class T1Administrator extends BaseTier {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private config: CascadeConfig;
  private t2Managers: Map<string, T2Manager> = new Map();
  private escalations: EscalationPayload[] = [];
  private store?: MemoryStore;
  private t2PeerBus: PeerBus = new PeerBus();
  private permissionEscalator?: PermissionEscalator;
  /** Stored overall task goal — used when evaluating escalated permissions */
  private taskGoal = '';

  constructor(router: CascadeRouter, toolRegistry: ToolRegistry, config: CascadeConfig) {
    super('T1', 'T1');
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.config = config;
  }

  setStore(store: MemoryStore): void {
    this.store = store;
  }

  /**
   * Inject the shared PermissionEscalator for this task run.
   * Registers T1's evaluator so it can decide when T2 is uncertain.
   */
  setPermissionEscalator(escalator: PermissionEscalator): void {
    this.permissionEscalator = escalator;
    escalator.setT1Evaluator((req) => this.evaluatePermissionAtT1(req));
  }

  async execute(
    userPrompt: string,
    images?: ImageAttachment[],
    systemContext?: string,
  ): Promise<{
    output: string;
    t2Results: T2Result[];
    taskId: string;
    complexity: TaskComplexity;
  }> {
    this.taskId = randomUUID();
    this.setLabel('Administrator');
    this.setStatus('ACTIVE');
    this.taskGoal = userPrompt; // store for permission evaluation later

    this.sendStatusUpdate({
      progressPct: 0,
      currentAction: 'Analyzing task and planning execution',
      status: 'IN_PROGRESS',
    });

    this.log(`T1 received task: ${userPrompt.slice(0, 100)}...`);

    // Step 1: Analyze images if present (T1 processes top-level images)
    let enrichedPrompt = userPrompt;
    if (images?.length) {
      enrichedPrompt = await this.analyzeImages(userPrompt, images);
    }

    // Step 2: Decompose task into sections
    const plan = await this.decomposeTask(enrichedPrompt, systemContext);

    this.sendStatusUpdate({
      progressPct: 10,
      currentAction: `Plan ready: ${plan.complexity} → ${plan.sections.length} sections`,
      status: 'IN_PROGRESS',
    });

    this.emit('plan', { taskId: this.taskId, plan });

    // Step 3: Dispatch T2 managers in parallel
    const t2Results = await this.dispatchT2Managers(plan.sections);

    this.sendStatusUpdate({
      progressPct: 95,
      currentAction: 'Compiling final output',
      status: 'IN_PROGRESS',
    });

    // Step 4: Compile final output
    const output = await this.compileFinalOutput(userPrompt, plan, t2Results);

    this.setStatus('COMPLETED');
    this.sendStatusUpdate({ progressPct: 100, currentAction: 'Task complete', status: 'IN_PROGRESS' });

    return { output, t2Results, taskId: this.taskId, complexity: plan.complexity };
  }

  getEscalations(): EscalationPayload[] {
    return [...this.escalations];
  }

  // ── Private ──────────────────────────────────

  private async analyzeImages(prompt: string, images: ImageAttachment[]): Promise<string> {
    const visionModel = this.router.getModelForTier('T1');
    if (!visionModel?.isVisionCapable) return prompt;

    const messages: ConversationMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: `Describe these images and how they relate to the task: "${prompt}"` },
        ...images.map((img) => ({ type: 'image' as const, image: img })),
      ],
    }];

    const result = await this.router.generate('T1', { messages, maxTokens: 1000 }, undefined, true);
    return `${prompt}\n\n[Image context: ${result.content}]`;
  }

  private async decomposeTask(prompt: string, systemContext?: string): Promise<TaskPlan> {
    const contextSection = systemContext ? `\nProject context:\n${systemContext}` : '';
    const decompositionPrompt = `Analyze this task and create an execution plan.${contextSection}

    Task: ${prompt}

    IMPORTANT: If the task specifies a directory (e.g. "inside X", "in X folder"), 
    ALL file paths in ALL subtasks must include that full directory prefix.
    Example: if asked to create files "inside python_exclusive", every subtask that 
    creates a file must use "python_exclusive/filename.ext" as the path.

Return JSON where subtasks can declare dependencies:
{
  "sections": [{
    "t3Subtasks": [{
      "subtaskId": "t1",
      "subtaskTitle": "Generate Source Code",
      "dependsOn": [],           // ← empty = runs immediately
      "executionMode": "parallel"
    }, {
      "subtaskId": "t2", 
      "subtaskTitle": "Save Code to File",
      "dependsOn": ["t1"],       // ← waits for t1 to complete first
      "executionMode": "parallel"
    }, {
      "subtaskId": "t3",
      "subtaskTitle": "Execute and Verify",
      "dependsOn": ["t2"],       // ← waits for t2
      "executionMode": "parallel"
    }]
  }]
}
Use dependsOn when a subtask needs the output of a previous one.
Leave dependsOn empty for subtasks that can run immediately in parallel.`;

    const messages: ConversationMessage[] = [{ role: 'user', content: decompositionPrompt }];
    const result = await this.router.generate('T1', {
      messages,
      systemPrompt: T1_SYSTEM_PROMPT,
      maxTokens: 4000,
    });

    try {
      const jsonMatch = /\{[\s\S]*\}/.exec(result.content);
      if (!jsonMatch) throw new Error('No JSON in T1 response');
      const plan = JSON.parse(jsonMatch[0]) as TaskPlan;
      this.validatePlan(plan);
      return plan;
    } catch {
      // Fallback: single section, single T3
      return {
        complexity: 'Simple',
        reasoning: 'Fallback single-section plan',
        sections: [{
          sectionId: 's1',
          sectionTitle: 'Main Task',
          description: prompt,
          expectedOutput: 'Complete response to the task',
          constraints: [],
          t3Subtasks: [{
            subtaskId: 't1',
            subtaskTitle: 'Execute Task',
            description: prompt,
            expectedOutput: 'Complete response',
            constraints: [],
            peerT3Ids: [],
            executionMode: 'parallel',
          }],
          executionMode: 'parallel',
          peerT2Ids: [],
        }],
      };
    }
  }

  private validatePlan(plan: TaskPlan): void {
    if (!plan.sections || !Array.isArray(plan.sections) || plan.sections.length === 0) {
      throw new Error('Invalid plan: no sections');
    }
    const [min, max] = COMPLEXITY_T2_COUNT[plan.complexity] ?? [1, 8];
    if (plan.sections.length < min) {
      // Auto-expand by duplicating if needed (rare edge case)
    }
  }

  private async dispatchT2Managers(sections: T1ToT2Assignment[]): Promise<T2Result[]> {
    // Wire peer sync IDs
    const idMap = new Map(sections.map((s) => [s.sectionId, s]));
    for (const section of sections) {
      section.peerT2Ids = sections
        .filter((x) => x.sectionId !== section.sectionId)
        .map((x) => x.sectionId);
    }

    const managers: T2Manager[] = sections.map((section) => {
      const manager = new T2Manager(this.router, this.toolRegistry, this.id);
      if (this.store) {
        manager.setStore(this.store);
      }
      manager.setPeerBus(this.t2PeerBus);

      // ← Inject the permission escalator into each T2 manager
      if (this.permissionEscalator) {
        manager.setPermissionEscalator(this.permissionEscalator);
      }

      this.t2Managers.set(section.sectionId, manager);

      // Bubble up events
      manager.on('stream:token', (e) => this.emit('stream:token', e));
      manager.on('log', (e) => this.emit('log', e));
      manager.on('tier:status', (e) => this.emit('tier:status', e));
      manager.on('tool:approval-request', (e) => this.emit('tool:approval-request', e));

      // Route peer sync
      manager.on('message', (msg) => {
        if (msg.type === 'PEER_SYNC') {
          const recipientId = msg.payload.recipientT3Id as string;
          const target = this.t2Managers.get(recipientId);
          if (target) target.receivePeerSync(msg.from, msg.payload.content);
        }
      });

      return manager;
    });

    const pct = (i: number) => 10 + Math.floor((i / sections.length) * 85);
    const isSequential = sections.some(s => s.executionMode === 'sequential');
    const t2Results: T2Result[] = [];

    if (isSequential) {
      this.log('Dispatching T2 managers sequentially');
      for (let i = 0; i < managers.length; i++) {
        const m = managers[i]!;
        this.sendStatusUpdate({
          progressPct: pct(i),
          currentAction: `T2 working on: ${sections[i]!.sectionTitle} (Sequential)`,
          status: 'IN_PROGRESS',
        });
        try {
          const result = await m.execute(sections[i]!, this.taskId);
          t2Results.push(result);
          if (result.status === 'ESCALATED') {
            this.escalations.push({
              raisedBy: `T2_${sections[i]!.sectionId}`,
              sectionId: sections[i]!.sectionId,
              attempted: result.issues,
              blocker: result.issues.join('; '),
              needs: 'Human review required',
            });
          }
        } catch (err) {
          t2Results.push({
            sectionId: sections[i]!.sectionId,
            sectionTitle: sections[i]!.sectionTitle,
            status: 'FAILED',
            t3Results: [],
            sectionSummary: '',
            issues: [err instanceof Error ? err.message : String(err)],
          });
        }
      }
    } else {
      const results = await Promise.allSettled(
        managers.map((m, i) => {
          this.sendStatusUpdate({
            progressPct: pct(i),
            currentAction: `T2 working on: ${sections[i]!.sectionTitle}`,
            status: 'IN_PROGRESS',
          });
          return m.execute(sections[i]!, this.taskId);
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === 'fulfilled') {
          t2Results.push(r.value);
          if (r.value.status === 'ESCALATED') {
            this.escalations.push({
              raisedBy: `T2_${sections[i]!.sectionId}`,
              sectionId: sections[i]!.sectionId,
              attempted: r.value.issues,
              blocker: r.value.issues.join('; '),
              needs: 'Human review required',
            });
          }
        } else {
          t2Results.push({
            sectionId: sections[i]!.sectionId,
            sectionTitle: sections[i]!.sectionTitle,
            status: 'FAILED',
            t3Results: [],
            sectionSummary: '',
            issues: [r.reason instanceof Error ? r.reason.message : String(r.reason)],
          });
        }
      }
    }

    return t2Results;
  }

  private async compileFinalOutput(
    originalPrompt: string,
    plan: TaskPlan,
    t2Results: T2Result[],
  ): Promise<string> {
    const completedSections = t2Results.filter((r) => r.status !== 'FAILED');

    if (!completedSections.length) {
      return 'Task failed — all sections encountered errors. Please check the escalation log.';
    }

    const sectionsText = completedSections
      .map((r) => `**${r.sectionTitle}**\n${r.sectionSummary}\n\nOutputs:\n${r.t3Results
        .filter((t) => t.status === 'COMPLETED')
        .map((t) => `• ${typeof t.output === 'string' ? t.output : JSON.stringify(t.output)}`)
        .join('\n')
        }`)
      .join('\n\n---\n\n');

    const openIssues = t2Results.flatMap((r) => r.issues).filter(Boolean);
    const failedSections = t2Results.filter((r) => r.status === 'FAILED' || r.status === 'PARTIAL');

    const compilePrompt = `Compile a final, coherent response to the user's original request.

Original request: ${originalPrompt}

Section results:
${sectionsText}

${openIssues.length ? `Open issues:\n${openIssues.map((i) => `- ${i}`).join('\n')}` : ''}

Instructions:
- Write the complete final output in natural language
- Integrate all section outputs coherently
- Note any partial failures clearly
- Do NOT expose JSON or tier internals`;

    const messages: ConversationMessage[] = [{ role: 'user', content: compilePrompt }];
    const result = await this.router.generate('T1', { messages, maxTokens: 8000 }, (chunk) => {
      this.emit('stream:token', { tierId: this.id, text: chunk.text });
    });

    return result.content;
  }

  /**
   * T1-level permission evaluator.
   * Uses T1's model with full task context.
   * Returns null only when the model explicitly says UNSURE (triggers user prompt).
   */
  private async evaluatePermissionAtT1(req: PermissionRequest): Promise<PermissionDecision | null> {
    const prompt = `You are T1 Administrator. Overall task goal:
${this.taskGoal}

A T3 Worker (inside section "${req.sectionContext}") wants to:
Tool: ${req.toolName}
Target: ${JSON.stringify(req.input)}
Reason: ${req.subtaskContext}

T2 Manager was uncertain about this. Given the overall task goal, should this be allowed?
Reply with exactly one word: YES, NO, or UNSURE.
(UNSURE = escalate to the human user for a final decision.)`;

    try {
      const result = await this.router.generate('T1', {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 10,
        temperature: 0,
      });
      const answer = result.content.trim().toUpperCase();
      if (answer.includes('YES')) {
        return { requestId: req.id, approved: true, always: true, decidedBy: 'T1', reasoning: 'T1 evaluated: consistent with overall task goal' };
      }
      if (answer.includes('NO')) {
        return { requestId: req.id, approved: false, always: true, decidedBy: 'T1', reasoning: 'T1 evaluated: not consistent with overall task goal' };
      }
      return null; // UNSURE → escalate to user
    } catch {
      return null; // On error, escalate to user
    }
  }
}
