// ─────────────────────────────────────────────
//  Cascade AI — Abstract Tier Base
// ─────────────────────────────────────────────

import EventEmitter from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  CascadeMessage,
  StatusUpdate,
  TierRole,
  TierStatus,
} from '../../types.js';
import { CascadeCancelledError } from '../../utils/retry.js';
// Type-only: the router imports tiers, so a value import here would close a
// cycle. Nothing at runtime depends on it.
import type { CascadeRouter } from '../router/index.js';

export abstract class BaseTier extends EventEmitter {
  /**
   * Declared here so generateTracked() can reach it. Each tier owns its own
   * instance; this only states that one exists.
   */
  protected abstract router: CascadeRouter;
  readonly id: string;
  readonly role: TierRole;
  protected status: TierStatus = 'IDLE';
  protected parentId?: string;
  protected taskId: string = '';
  protected label: string;
  protected systemPromptOverride: string = '';
  protected hierarchyContext: string = '';
  /** Propagated AbortSignal — set by the tier's `execute()` before work begins. */
  protected signal?: AbortSignal;
  /**
   * True for the run's ROOT tier (T3 for Simple, T2 for Moderate, T1 for
   * Complex). Its own synthesis stream is the user-facing answer and is
   * tagged `primary` so the desktop renders it live — background workers,
   * which would interleave, are not tagged.
   */
  protected isPresenter = false;
  /**
   * The model actually serving this tier (`provider:id`), once resolved —
   * rides on every tier:status event so the desktop can show which model ran
   * which node (Cockpit node panel / Why panel).
   */
  protected servingModel?: string;
  /**
   * This tier's identity IN THE TASK GRAPH — the section or subtask id the
   * planner assigned — plus where it sat in the dependency order.
   *
   * `id` and `graphNodeId` are deliberately different id spaces, and both are
   * needed. `id` identifies this tier INSTANCE ("T2_a1b2c3d4", minted per
   * construction); `graphNodeId` identifies the WORK ("s1"), which is what
   * dependency edges point at. Without the distinction a graph view cannot be
   * drawn at all: `dependsOn` lists section ids, while every running tier
   * reports a generated tier id, so every edge would name a node that never
   * appears in the stream.
   */
  protected graphNodeId?: string;
  protected graphDependsOn?: readonly string[];
  protected graphWave?: number;

  constructor(role: TierRole, id?: string, parentId?: string) {
    super();
    this.role = role;
    this.id = id ?? `${role}_${randomUUID().slice(0, 8)}`;
    this.parentId = parentId;
    this.label = this.id;
  }

  /** Mark this tier as the run's presenter (root tier). */
  setPresenter(on = true): void {
    this.isPresenter = on;
  }

  /**
   * Record where this tier sits in the compiled task graph.
   *
   * Called by whichever tier scheduled this one: the id and edges are known at
   * construction, the wave only once the scheduler reaches it, so the fields
   * are set independently rather than all at once.
   */
  setGraphPosition(position: { nodeId?: string; dependsOn?: readonly string[]; wave?: number }): void {
    if (position.nodeId !== undefined) this.graphNodeId = position.nodeId;
    if (position.dependsOn !== undefined) this.graphDependsOn = [...position.dependsOn];
    if (position.wave !== undefined) this.graphWave = position.wave;
  }

  /**
   * The graph fields, for spreading into a status payload.
   *
   * One helper rather than two literals because `tier:status` is emitted from
   * two different call sites with two different payload shapes; adding a field
   * to only one of them makes it arrive intermittently, which is worse for a
   * consumer than never arriving at all.
   */
  protected graphFields(): { nodeId?: string; dependsOn?: string[]; waveId?: number } {
    return {
      nodeId: this.graphNodeId,
      dependsOn: this.graphDependsOn ? [...this.graphDependsOn] : undefined,
      waveId: this.graphWave,
    };
  }

  getStatus(): TierStatus {
    return this.status;
  }

  protected setStatus(status: TierStatus, output?: string): void {
    this.status = status;
    const timestamp = new Date().toISOString();
    const event = {
      tierId: this.id,
      role: this.role,
      parentId: this.parentId,
      label: this.label,
      status,
      timestamp,
      output,
      model: this.servingModel,
      ...this.graphFields(),
    };
    this.emit('status', event);
    this.emit('tier:status', event);
  }

  /** Record the model serving this tier; future status events carry it. */
  /**
   * The model actually serving this tier ("provider:id"), once one has been
   * chosen. The run breaker reads it to attribute a failure to a model rather
   * than to the subtask that happened to hit it.
   */
  getServingModel(): string | undefined {
    return this.servingModel;
  }

  protected setServingModel(model: string | undefined): void {
    this.servingModel = model || undefined;
  }

  /**
   * Run a generation and record which model actually answered it.
   *
   * Tiers set servingModel from the model they SELECTED, before the call. The
   * router can fail over mid-call — a rate limit, a dead id, an exhausted
   * account — and then the tier's terminal status names a model that never
   * ran. cloud/server persists that value onto the assistant message, and
   * `/why` and thumbs feedback read it back, so the credit (or the blame) goes
   * to the wrong model and the performance history learns something untrue
   * about two models at once.
   *
   * Every tier call goes through here rather than `router.generate` directly,
   * so a new call site cannot quietly reintroduce the mis-attribution.
   */
  /**
   * Run a generation whose model must NOT become this tier's attribution.
   *
   * Graders, critics and extractors run beside the answer, often on a
   * deliberately different model — the T2 critic exists precisely so a model
   * is not marking its own work. Routing those through generateTracked() made
   * the last grading call overwrite servingModel, so the subtask's output, its
   * terminal status and the feedback history all named the grader rather than
   * the model that wrote the answer.
   */
  protected async generateAuxiliary(
    ...args: Parameters<CascadeRouter['generate']>
  ): Promise<Awaited<ReturnType<CascadeRouter['generate']>>> {
    return this.router.generate(...args);
  }

  protected async generateTracked(
    ...args: Parameters<CascadeRouter['generate']>
  ): Promise<Awaited<ReturnType<CascadeRouter['generate']>>> {
    const result = await this.router.generate(...args);
    if (result?.servedBy) {
      this.setServingModel(`${result.servedBy.provider}:${result.servedBy.id}`);
    }
    return result;
  }

  protected setLabel(label: string): void {
    this.label = label;
  }

  setSystemPromptOverride(prompt: string): void {
    this.systemPromptOverride = prompt;
  }

  setHierarchyContext(context: string): void {
    this.hierarchyContext = context;
  }

  protected sendStatusUpdate(update: StatusUpdate): void {
    const timestamp = new Date().toISOString();
    const message = this.buildMessage('STATUS_UPDATE', this.parentId ?? 'T1', update as unknown as Record<string, unknown>);
    this.emit('message', message);
    this.emit('tier:status', {
      tierId: this.id,
      role: this.role,
      parentId: this.parentId,
      label: this.label,
      status: this.status,
      currentAction: update.currentAction,
      progressPct: update.progressPct,
      timestamp,
      output: update.output,
      // Only present on a review update. Explicit rather than spread because
      // this emit names every field it forwards.
      ...(update.review ? { review: update.review } : {}),
      model: this.servingModel,
      ...this.graphFields(),
    });
  }

  protected buildMessage(
    type: CascadeMessage['type'],
    to: string,
    payload: Record<string, unknown>,
  ): CascadeMessage {
    return {
      version: '1.0',
      from: this.id,
      to,
      type,
      taskId: this.taskId,
      timestamp: new Date().toISOString(),
      payload: payload as unknown as CascadeMessage['payload'],
    };
  }

  protected log(message: string, data?: unknown): void {
    this.emit('log', { tierId: this.id, role: this.role, message, data, timestamp: new Date().toISOString() });
  }

  /**
   * Throws `CascadeCancelledError` if the run's `AbortSignal` has fired.
   * Call this at safe checkpoints (before LLM calls, between T3 dispatches)
   * to provide a fast, clean cancellation path.
   */
  protected throwIfCancelled(): void {
    if (this.signal?.aborted) {
      throw new CascadeCancelledError(
        typeof this.signal.reason === 'string'
          ? this.signal.reason
          : 'Run cancelled by caller',
      );
    }
  }
}
