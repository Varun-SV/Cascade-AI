// ─────────────────────────────────────────────
//  Cascade AI — T1 Administrator
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type {
  CascadeConfig,
  ConversationMessage,
  EscalationPayload,
  ImageAttachment,
  T1ToT2Assignment,
  T2Result,
  TaskComplexity,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { BaseTier } from './base.js';
import { T2Manager } from './t2-manager.js';
import { COMPLEXITY_T2_COUNT } from '../../constants.js';

const T1_SYSTEM_PROMPT = `You are T1, the Administrator in the Cascade AI orchestration system.

Your responsibilities:
1. Analyze task complexity: Simple | Moderate | Complex | Highly Complex
2. Decompose the task into logical sections (one per T2 Manager)
3. For each section, define 2-5 subtasks for T3 Workers
4. Return a structured plan as JSON

Rules:
- Simple → 1 T2
- Moderate → 2-3 T2s
- Complex → 3-5 T2s
- Highly Complex → 5+ T2s
- Each section must be non-overlapping and self-contained
- Return ONLY valid JSON — no other text`;

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

  constructor(router: CascadeRouter, toolRegistry: ToolRegistry, config: CascadeConfig) {
    super('T1', 'T1');
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.config = config;
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
    this.setStatus('ACTIVE');

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

Return JSON:
{
  "complexity": "Simple|Moderate|Complex|Highly Complex",
  "reasoning": "why this complexity",
  "sections": [
    {
      "sectionId": "s1",
      "sectionTitle": "Section Title",
      "description": "what this section does",
      "expectedOutput": "what it should produce",
      "constraints": ["constraint1"],
      "t3Subtasks": [
        {
          "subtaskId": "t1",
          "subtaskTitle": "Subtask Title",
          "description": "what this subtask does",
          "expectedOutput": "what it produces",
          "constraints": [],
          "peerT3Ids": []
        }
      ]
    }
  ]
}`;

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
          }],
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
    const managers: T2Manager[] = sections.map((section) => {
      const manager = new T2Manager(this.router, this.toolRegistry, this.id);
      this.t2Managers.set(section.sectionId, manager);

      // Bubble up events
      manager.on('stream:token', (e) => this.emit('stream:token', e));
      manager.on('log', (e) => this.emit('log', e));
      manager.on('tier:status', (e) => this.emit('tier:status', e));
      manager.on('tool:approval-request', (e) => this.emit('tool:approval-request', e));

      return manager;
    });

    const pct = (i: number) => 10 + Math.floor((i / sections.length) * 85);

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

    const t2Results: T2Result[] = [];
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
      .map((r) => `**${r.sectionTitle}**\n${r.sectionSummary}\n\nOutputs:\n${
        r.t3Results
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
    const result = await this.router.generate('T1', { messages, maxTokens: 8000 });

    return result.content;
  }
}
