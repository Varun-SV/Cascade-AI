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
  StreamChunk,
  TaskComplexity,
  T3Result
} from '../types.js';
import { CascadeRouter } from './router/index.js';
import { T1Administrator } from './tiers/t1-administrator.js';
import { T2Manager } from './tiers/t2-manager.js';
import { T3Worker } from './tiers/t3-worker.js';
import { ToolRegistry } from '../tools/registry.js';
import { AuditLogger } from '../audit/log.js';
import { MemoryStore } from '../memory/store.js';

export class Cascade extends EventEmitter {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private config: CascadeConfig;
  private initialized = false;
  private store?: MemoryStore;
  private audit?: AuditLogger;

  constructor(config: CascadeConfig, workspacePath: string, store?: MemoryStore) {
    super();
    this.config = config;
    this.store = store;
    this.router = new CascadeRouter();
    this.toolRegistry = new ToolRegistry(config.tools, workspacePath);
  }

  setStore(store: MemoryStore): void {
    this.store = store;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.router.init(this.config);
    this.initialized = true;
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

    // 1. Determine complexity
    const complexity = await this.determineComplexity(options.prompt, options.conversationHistory);

    this.emit('tier:root', { role: complexity === 'Simple' ? 'T3' : complexity === 'Moderate' ? 'T2' : 'T1' });

    let finalOutput = '';
    let t2Results: any[] = [];

    // Helper to bind standard events to any tier
    const bindTierEvents = (tier: any) => {
      tier.on('stream:token', (e: any) => {
        this.emit('stream:token', e);
        options.streamCallback?.({ text: e.text, finishReason: null });
      });
      tier.on('log', (e: any) => this.emit('log', e));
      tier.on('tier:status', (e: any) => this.emit('tier:status', e));
      tier.on('tool:approval-request', async (request: ApprovalRequest & { __cascadeResponder?: (approved: boolean) => void }) => {
        this.emit('tool:approval-request', request);
        let approved = false;
        if (options.approvalCallback) {
          approved = await options.approvalCallback(request);
        }
        if (typeof request.__cascadeResponder === 'function') {
          request.__cascadeResponder(approved);
        } else {
          tier.emit(`tool:approval-response:${request.id}`, { approved } as ApprovalResponse);
        }
      });
    };

    if (complexity === 'Simple') {
      const t3 = new T3Worker(this.router, this.toolRegistry, 'root');
      if (this.store) {
        t3.setStore(this.store, taskId);
      }
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
      const t3Result = await t3.execute(assignment, taskId);
      finalOutput = typeof t3Result.output === 'string' ? t3Result.output : JSON.stringify(t3Result.output);
      this.emit('tier:status', { tierId: 't3-root', status: 'COMPLETED', role: 'T3' });
    } else if (complexity === 'Moderate') {
      const t2 = new T2Manager(this.router, this.toolRegistry, 'root');
      if (this.store) {
        t2.setStore(this.store);
      }
      bindTierEvents(t2);
      const assignment = {
        sectionId: taskId,
        sectionTitle: 'Direct Task',
        description: options.prompt,
        expectedOutput: 'A complete resolution of the task.',
        constraints: [],
        t3Subtasks: []
      };
      const t2Result = await t2.execute(assignment, taskId);
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
      if (this.store) {
        t1.setStore(this.store);
      }
      bindTierEvents(t1);
      t1.on('plan', (e: any) => this.emit('plan', e));
      
      const result = await t1.execute(options.prompt, options.images);
      finalOutput = result.output;
      t2Results = result.t2Results;
    }

    const stats = this.router.getStats();

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
      durationMs: Date.now() - startMs,
    };
  }

  getRouter(): CascadeRouter {
    return this.router;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
}

