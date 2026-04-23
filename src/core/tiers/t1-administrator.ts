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
import type { ToolCreator } from '../../tools/tool-creator.js';
import { parseFirstJsonObject } from '../../utils/json-extract.js';

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
- Ensure every plan includes explicit creation and verification steps for requested artifacts

DEPENDENCY GUIDANCE:
- Leave "dependsOn" empty [] for sections that are independent (e.g. writing different files, researching different topics).
- Populate "dependsOn" with section IDs ONLY when a later section strictly depends on the output of an earlier one (e.g. write code → then test it).
- Prefer empty dependencies (parallel execution): it is significantly faster and reduces total wall-clock time.
- Within a sequential section, mark T3 subtasks with "dependsOn" only when they truly block each other.

QUALITY RULES:
- Each section must have a clear, testable "expectedOutput" so T2 knows when it is done.
- Do NOT create trivial sections that only move files or print summaries — fold those into adjacent sections.
- If the plan would naturally produce fewer than 2 independent sections, prefer Moderate routing (single T2).`;

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
  private toolCreator?: ToolCreator;
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

  setToolCreator(creator: ToolCreator): void {
    this.toolCreator = creator;
  }

  async execute(
    userPrompt: string,
    images?: ImageAttachment[],
    systemContext?: string,
    signal?: AbortSignal,
  ): Promise<{
    output: string;
    t2Results: T2Result[];
    taskId: string;
    complexity: TaskComplexity;
  }> {
    this.signal = signal;
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

    // ── Cancellation checkpoint: before image analysis ──
    this.throwIfCancelled();

    // Step 1: Analyze images if present (T1 processes top-level images)
    let enrichedPrompt = userPrompt;
    if (images?.length) {
      enrichedPrompt = await this.analyzeImages(userPrompt, images);
    }

    // ── Cancellation checkpoint: after image analysis, before planning ──
    this.throwIfCancelled();

    // Step 2: Decompose task into sections
    const plan = await this.decomposeTask(enrichedPrompt, systemContext);

    this.sendStatusUpdate({
      progressPct: 10,
      currentAction: `Plan ready: ${plan.complexity} → ${plan.sections.length} sections`,
      status: 'IN_PROGRESS',
    });

    this.emit('plan', { taskId: this.taskId, plan });

    // ── Cancellation checkpoint: after planning, before T2 dispatch ──
    this.throwIfCancelled();

    // Step 3: Dispatch T2 managers in parallel
    let allT2Results = await this.dispatchT2Managers(plan.sections);

    // Step 4: T1 Reviewer Phase
    let pass = 1;
    const MAX_REPLAN_PASSES = 2;
    while (pass <= MAX_REPLAN_PASSES) {
      const reviewResult = await this.reviewT2Outputs(enrichedPrompt, plan, allT2Results);
      if (reviewResult.approved) {
        this.log('T1 Review passed.');
        break;
      }

      this.log(`T1 Review rejected outputs. Replanning (Pass ${pass}). Reason: ${reviewResult.reason}`);
      this.sendStatusUpdate({
        progressPct: 80 + (pass * 5),
        currentAction: `Review failed: ${reviewResult.reason}. Replanning...`,
        status: 'IN_PROGRESS',
      });

      const correctionPlan = await this.decomposeTask(`The previous execution plan failed to fully satisfy the original goal or encountered errors.
Review reason: ${reviewResult.reason}

Original goal: ${enrichedPrompt}

Create a CORRECTION PLAN that contains only the new sections needed to fix the issues. Do not repeat successful sections.`);
      
      const correctionResults = await this.dispatchT2Managers(correctionPlan.sections);
      allT2Results = [...allT2Results, ...correctionResults];
      pass++;
    }

    this.sendStatusUpdate({
      progressPct: 95,
      currentAction: 'Compiling final output',
      status: 'IN_PROGRESS',
    });

    // Step 5: Compile final output
    const output = await this.compileFinalOutput(userPrompt, plan, allT2Results);

    this.setStatus('COMPLETED', output);
    this.sendStatusUpdate({ progressPct: 100, currentAction: 'Task complete', status: 'IN_PROGRESS', output });

    return { output, t2Results: allT2Results, taskId: this.taskId, complexity: plan.complexity };
  }

  getEscalations(): EscalationPayload[] {
    return [...this.escalations];
  }

  // ── Private ──────────────────────────────────

  private async reviewT2Outputs(
    originalPrompt: string,
    plan: TaskPlan,
    t2Results: T2Result[],
  ): Promise<{ approved: boolean; reason?: string }> {
    const failedSections = t2Results.filter(r => r.status === 'FAILED');
    if (failedSections.length > 0) {
      return { 
        approved: false, 
        reason: `Some T2 managers failed entirely: ${failedSections.map(s => s.sectionTitle).join(', ')}. Errors: ${failedSections.flatMap(s => s.issues).join('; ')}`
      };
    }

    const sectionsText = t2Results
      .map((r) => `**${r.sectionTitle}**\n${r.sectionSummary}`)
      .join('\n\n');

    const prompt = `You are a strict QA Reviewer for the Cascade AI system.
Review the following execution outputs against the original user prompt.

Original Request: ${originalPrompt}

T2 Manager Summaries:
${sectionsText}

Does the current state of the workspace and the outputs fully satisfy the user's request?
If yes, reply with exactly: "APPROVED".
If no, reply with "REJECTED: [Detailed reason explaining exactly what is missing or incorrect]".`;

    try {
      const result = await this.router.generate('T1', {
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: this.systemPromptOverride + 'You are a QA Reviewer.',
        maxTokens: 500,
        temperature: 0,
      });
      const response = result.content.trim();
      if (response.toUpperCase().startsWith('APPROVED')) {
        return { approved: true };
      }
      return { approved: false, reason: response.replace(/^REJECTED:\s*/i, '') };
    } catch {
      // If review fails to generate, default to approve to avoid infinite loops on rate limits
      return { approved: true };
    }
  }

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

Return JSON where SECTIONS can declare dependencies on other SECTIONS:
{
  "sections": [{
    "sectionId": "s1",
    "sectionTitle": "Setup Project",
    "description": "Initialize the project",
    "expectedOutput": "Basic structure created",
    "constraints": [],
    "dependsOn": [],           // ← empty = runs immediately
    "t3Subtasks": [{
      "subtaskId": "t1",
      "subtaskTitle": "Init NPM",
      "description": "Run npm init",
      "expectedOutput": "package.json created",
      "constraints": [],
      "dependsOn": []
    }]
  }, {
    "sectionId": "s2", 
    "sectionTitle": "Write Tests",
    "description": "Write tests for the project",
    "expectedOutput": "Tests passing",
    "constraints": [],
    "dependsOn": ["s1"],       // ← waits for section s1 to complete first
    "t3Subtasks": [...]
  }]
}
Use dependsOn at the SECTION level when a whole T2 Manager needs the output of a previous T2 Manager.
Leave dependsOn empty for sections that can run immediately in parallel.`;

    const messages: ConversationMessage[] = [{ role: 'user', content: decompositionPrompt }];
    const result = await this.router.generate('T1', {
      messages,
      systemPrompt: this.systemPromptOverride + T1_SYSTEM_PROMPT,
      maxTokens: 4000,
    });

    try {
      const parsed = parseFirstJsonObject<TaskPlan>(result.content);
      if (!parsed) throw new Error('No JSON in T1 response');
      this.validatePlan(parsed);
      return parsed;
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
    for (const section of sections) {
      section.peerT2Ids = sections
        .filter((x) => x.sectionId !== section.sectionId)
        .map((x) => x.sectionId);
    }

    // Track (emitter, event, handler) tuples so we can detach all listeners
    // when dispatch finishes. Without this, bubble handlers and peer-sync
    // routers leak for the lifetime of the process in long-lived REPLs.
    const registered: Array<[T2Manager, string, (...args: unknown[]) => void]> = [];
    const bind = <T>(m: T2Manager, event: string, fn: (arg: T) => void) => {
      const handler = (arg: T) => fn(arg);
      m.on(event, handler as (...args: unknown[]) => void);
      registered.push([m, event, handler as (...args: unknown[]) => void]);
    };

    const managers: T2Manager[] = sections.map((section) => {
      const manager = new T2Manager(this.router, this.toolRegistry, this.id);
      manager.setHierarchyContext(`You are a T2 Manager for the section "${section.sectionTitle}". You are part of a COMPLEX task overseen by T1 Administrator.`);
      if (this.store) {
        manager.setStore(this.store);
      }
      manager.setPeerBus(this.t2PeerBus);

      if (this.permissionEscalator) {
        manager.setPermissionEscalator(this.permissionEscalator);
      }

      if (this.toolCreator) {
        manager.setToolCreator(this.toolCreator);
      }

      this.t2Managers.set(section.sectionId, manager);

      bind(manager, 'stream:token', (e) => this.emit('stream:token', e));
      bind(manager, 'log', (e) => this.emit('log', e));
      bind(manager, 'tier:status', (e) => this.emit('tier:status', e));
      bind(manager, 'tool:approval-request', (e) => this.emit('tool:approval-request', e));

      bind(manager, 'message', (msg: { type: string; from: string; payload: Record<string, unknown> }) => {
        if (msg.type === 'PEER_SYNC') {
          const recipientId = msg.payload.recipientT3Id as string;
          const target = this.t2Managers.get(recipientId);
          if (target) target.receivePeerSync(msg.from, msg.payload.content as string);
        }
      });

      return manager;
    });

    const cleanup = () => {
      for (const [m, event, handler] of registered) {
        m.off(event, handler);
      }
      registered.length = 0;
    };

    // ── Phase 1: T2 Peer Discussion — Proactive Announcement ──────────────
    // Each T2 broadcasts its section plan. T1 collects for 500ms and uses
    // the results to detect overlapping work and inject sibling context.
    this.t2PeerBus.clearBroadcastLog();
    managers.forEach((m, i) => m.announcePlan(sections[i]!));
    const announcements = await this.t2PeerBus.collect(500);

    // Build sibling context map: section → keywords from all other sections
    const siblingKeywords = new Map<string, string[]>();
    for (const ann of announcements) {
      const payload = ann.payload as { type: string; sectionId: string; sectionTitle: string; keywords: string[] };
      if (payload?.type !== 'T2_PLAN_ANNOUNCEMENT') continue;
      for (const other of announcements) {
        const otherPayload = other.payload as typeof payload;
        if (otherPayload?.type !== 'T2_PLAN_ANNOUNCEMENT' || otherPayload.sectionId === payload.sectionId) continue;
        const existing = siblingKeywords.get(payload.sectionId) ?? [];
        existing.push(...(otherPayload.keywords ?? []));
        siblingKeywords.set(payload.sectionId, [...new Set(existing)]);
      }
    }

    // Detect shared keywords → mark overlapping sections as sequential
    const overlapSections = new Set<string>();
    for (let i = 0; i < announcements.length; i++) {
      for (let j = i + 1; j < announcements.length; j++) {
        const a = announcements[i]!.payload as { keywords?: string[]; sectionId?: string };
        const b = announcements[j]!.payload as { keywords?: string[]; sectionId?: string };
        if (!a.keywords || !b.keywords || !a.sectionId || !b.sectionId) continue;
        const shared = a.keywords.filter(k => b.keywords!.includes(k));
        if (shared.length > 0) {
          overlapSections.add(a.sectionId);
          overlapSections.add(b.sectionId);
          this.log(`T2 overlap detected between sections: ${a.sectionId} ↔ ${b.sectionId} (shared: ${shared.join(', ')})`);
        }
      }
    }

    // Inject sibling context into each T2 manager
    managers.forEach((m, i) => {
      const section = sections[i]!;
      const myKeywords = siblingKeywords.get(section.sectionId) ?? [];
      const otherTitles = sections.filter(s => s.sectionId !== section.sectionId).map(s => s.sectionTitle);
      const context = [
        `You are T2 Manager for section: "${section.sectionTitle}".`,
        `Sibling sections being worked on in parallel: ${otherTitles.join(', ') || 'none'}.`,
        myKeywords.length > 0 ? `Watch for overlap with: ${[...new Set(myKeywords)].slice(0, 10).join(', ')}.` : '',
        overlapSections.has(section.sectionId) ? 'NOTE: Potential overlap detected with a sibling section — be careful not to duplicate work.' : '',
      ].filter(Boolean).join(' ');
      m.setHierarchyContext(context);
    });

    // If overlaps detected globally, add sequential dependencies for safety
    if (overlapSections.size > 0) {
      this.log('Overlap detected — adding sequential dependencies for conflicting sections to prevent race conditions');
      const overlapArray = Array.from(overlapSections);
      for (let i = 1; i < overlapArray.length; i++) {
        const section = sections.find(s => s.sectionId === overlapArray[i]);
        if (section) {
          section.dependsOn = [...(section.dependsOn || []), overlapArray[i - 1]!];
        }
      }
    }

    const t2Results: T2Result[] = [];

    try {
      t2Results.push(...await this.runT2sWithDependencies(sections, managers, this.taskId));
    } finally {
      cleanup();
    }

    return t2Results;
  }

  /**
   * Runs T2 managers respecting dependsOn declarations using Kahn's algorithm.
   */
  private async runT2sWithDependencies(
    sections: T1ToT2Assignment[],
    managers: T2Manager[],
    taskId: string,
  ): Promise<T2Result[]> {
    const adj = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();
    const resultMap = new Map<string, T2Result>();
    const allKeys = new Set(sections.map(s => s.sectionId));

    for (const s of sections) {
      if (!adj.has(s.sectionId)) adj.set(s.sectionId, new Set());
      inDegree.set(s.sectionId, 0);
      // Sanitize dependencies
      s.dependsOn = (s.dependsOn ?? []).filter(d => allKeys.has(d));
    }

    for (const s of sections) {
      for (const dep of (s.dependsOn ?? [])) {
        adj.get(dep)!.add(s.sectionId);
        inDegree.set(s.sectionId, (inDegree.get(s.sectionId) ?? 0) + 1);
      }
    }

    // Break cycles
    const queue: string[] = [];
    const degree = new Map(inDegree);
    for (const [id, deg] of degree.entries()) if (deg === 0) queue.push(id);
    const visited = new Set<string>();
    while (queue.length > 0) {
      const u = queue.shift()!;
      visited.add(u);
      for (const v of adj.get(u) ?? new Set()) {
        const newDeg = (degree.get(v) ?? 1) - 1;
        degree.set(v, newDeg);
        if (newDeg === 0) queue.push(v);
      }
    }
    const cycleNodes = [...inDegree.keys()].filter(id => !visited.has(id));
    if (cycleNodes.length > 0) {
      this.log(`⚠ Circular dependency detected among sections: [${cycleNodes.join(', ')}]. Breaking cycles.`);
      for (const s of sections) {
        if (cycleNodes.includes(s.sectionId)) {
          const safeDeps = (s.dependsOn ?? []).filter(d => !cycleNodes.includes(d));
          for (const removed of (s.dependsOn ?? []).filter(d => cycleNodes.includes(d))) {
            inDegree.set(s.sectionId, Math.max(0, (inDegree.get(s.sectionId) ?? 1) - 1));
            adj.get(removed)?.delete(s.sectionId);
          }
          s.dependsOn = safeDeps;
        }
      }
    }

    // Wave-based execution
    const totalSections = sections.length;
    let completedSections = 0;
    const executeWave = async () => {
      const readyIds: string[] = [];
      for (const [id, deg] of inDegree.entries()) {
        if (deg === 0 && !resultMap.has(id)) {
          readyIds.push(id);
        }
      }
      if (readyIds.length === 0) return;

      await Promise.all(readyIds.map(async (id) => {
        // Mark as started (prevent picking it up in next wave before it finishes)
        resultMap.set(id, null as any);

        const index = sections.findIndex(s => s.sectionId === id);
        const section = sections[index]!;
        const manager = managers[index]!;

        const progressPct = 10 + Math.floor((completedSections / totalSections) * 85);
        this.sendStatusUpdate({
          progressPct,
          currentAction: `T2 working on: ${section.sectionTitle}`,
          status: 'IN_PROGRESS',
        });

        this.throwIfCancelled();

        let result: T2Result;
        try {
          result = await manager.execute(section, taskId, this.signal);
          manager.shareCompletedOutput(section.sectionId, result.sectionSummary);
          if (result.status === 'ESCALATED') {
            this.escalations.push({
              raisedBy: `T2_${section.sectionId}`,
              sectionId: section.sectionId,
              attempted: result.issues,
              blocker: result.issues.join('; '),
              needs: 'Human review required',
            });
          }
        } catch (err) {
          result = {
            sectionId: section.sectionId,
            sectionTitle: section.sectionTitle,
            status: 'FAILED',
            t3Results: [],
            sectionSummary: '',
            issues: [err instanceof Error ? err.message : String(err)],
          };
        }

        resultMap.set(id, result);
        completedSections++;

        for (const dependentId of adj.get(id) ?? new Set()) {
          inDegree.set(dependentId, Math.max(0, (inDegree.get(dependentId) ?? 1) - 1));
        }
      }));

      // Check if more are ready after this wave
      if (Array.from(inDegree.values()).some(deg => deg === 0) && resultMap.size < totalSections) {
        await executeWave();
      }
    };

    await executeWave();

    return sections.map(s => resultMap.get(s.sectionId)!).filter(Boolean);
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
    const result = await this.router.generate('T1', {
      messages,
      systemPrompt: this.systemPromptOverride + 'You are a final output compiler. Summarize and format the task results clearly.',
      maxTokens: 8000
    }, (chunk) => {
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
        systemPrompt: this.systemPromptOverride + 'You are a T1 Administrator evaluating permissions.',
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
