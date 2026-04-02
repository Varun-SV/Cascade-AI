// ─────────────────────────────────────────────
//  Cascade AI — Main Facade
// ─────────────────────────────────────────────

import EventEmitter from 'node:events';
import type {
  ApprovalRequest,
  ApprovalResponse,
  CascadeConfig,
  CascadeRunOptions,
  CascadeRunResult,
  ImageAttachment,
  StreamChunk,
} from '../types.js';
import { CascadeRouter } from './router/index.js';
import { T1Administrator } from './tiers/t1-administrator.js';
import { ToolRegistry } from '../tools/registry.js';

export class Cascade extends EventEmitter {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private config: CascadeConfig;
  private initialized = false;

  constructor(config: CascadeConfig) {
    super();
    this.config = config;
    this.router = new CascadeRouter();
    this.toolRegistry = new ToolRegistry(config.tools);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.router.init(this.config);
    this.initialized = true;
  }

  async run(options: CascadeRunOptions): Promise<CascadeRunResult> {
    await this.init();

    const startMs = Date.now();

    const t1 = new T1Administrator(this.router, this.toolRegistry, this.config);

    // Bubble events up
    t1.on('stream:token', (e) => {
      this.emit('stream:token', e);
      options.streamCallback?.({ text: e.text, finishReason: null });
    });
    t1.on('log', (e) => this.emit('log', e));
    t1.on('tier:status', (e) => this.emit('tier:status', e));
    t1.on('plan', (e) => this.emit('plan', e));

    // Approval routing
    t1.on('tool:approval-request', async (request: ApprovalRequest) => {
      this.emit('tool:approval-request', request);
      let approved = false;
      if (options.approvalCallback) {
        approved = await options.approvalCallback(request);
      }
      t1.emit(`tool:approval-response:${request.id}`, { approved } as ApprovalResponse);
    });

    const { output, t2Results, taskId, complexity } = await t1.execute(
      options.prompt,
      options.images,
    );

    const stats = this.router.getStats();

    return {
      output,
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
