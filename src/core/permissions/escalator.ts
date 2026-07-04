// ─────────────────────────────────────────────
//  Cascade AI — Permission Escalator
//  Routes T3 approval requests up: T2 → T1 → User
// ─────────────────────────────────────────────

import EventEmitter from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PermissionDecision, PermissionRequest } from '../../types.js';

/** Tools that are inherently safe — T2 auto-approves via rules (no LLM call) */
const SAFE_TOOLS = new Set([
  'file_read',
  'file_list',
  'git_status',
  'git_log',
  'git_diff',
  'image_analyze',
  'peer_message',
  'diff_view',
]);

type T2Evaluator = (req: PermissionRequest) => Promise<PermissionDecision | null>;
type T1Evaluator = (req: PermissionRequest) => Promise<PermissionDecision | null>;

/**
 * PermissionEscalator manages the hierarchical permission flow for a single task run.
 *
 * Decision cascade:
 * 1. Check the task-wide cache (USER/T1 "always" decisions, keyed by `toolName`
 *    alone) → return if hit. These are deliberately NOT scoped to one T2, so a
 *    user's or T1's "Always" covers every sibling worker anywhere in the run.
 * 2. Check the per-T2 session cache (section-wide key `${t2Id}:${toolName}`)
 *    → return if hit
 * 3. Ask T2 evaluator → if decision returned, cache (per-T2) + return
 * 4. Ask T1 evaluator → if decision returned, cache (task-wide) + return
 * 5. Emit `permission:user-required` → wait for external decision via
 *    `resolveUserDecision()`; an "always" answer caches task-wide.
 */
export class PermissionEscalator extends EventEmitter {
  /**
   * Session cache keyed by `${t2Id}:${toolName}`.
   * All T3 workers under the same T2 share cached decisions for the same tool.
   */
  private sessionCache = new Map<string, boolean>();

  /**
   * Task-wide cache keyed by `toolName` alone, for USER- and T1-level
   * "always" decisions — these are meant to cover every sibling T2/T3 in the
   * run, not just the one that happened to ask first (see PermissionDecision
   * doc comment: "task-wide for T1").
   */
  private taskWideCache = new Map<string, boolean>();

  private t2Evaluator?: T2Evaluator;
  private t1Evaluator?: T1Evaluator;

  /** Pending user-decision resolvers keyed by request ID */
  private pendingUserDecisions = new Map<
    string,
    (decision: PermissionDecision) => void
  >();

  /** ms to wait for a user approval decision before denying for safety. */
  private readonly approvalTimeoutMs: number;
  /** Autonomous mode (autonomy: 'auto'): non-dangerous tools auto-approve. */
  private autonomous: boolean;

  constructor(approvalTimeoutMs = 600_000, autonomous = false) {
    super();
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.autonomous = autonomous;
  }

  /** Toggle autonomous auto-approval at runtime (e.g. from /auto). */
  setAutonomous(on: boolean): void {
    this.autonomous = on;
  }

  setT2Evaluator(evaluator: T2Evaluator): void {
    this.t2Evaluator = evaluator;
  }

  setT1Evaluator(evaluator: T1Evaluator): void {
    this.t1Evaluator = evaluator;
  }

  /**
   * Main entry point. Called by T3Worker instead of emitting `tool:approval-request`.
   * Returns a PermissionDecision from whichever tier was able to decide.
   */
  async requestPermission(req: PermissionRequest): Promise<PermissionDecision> {
    // ── 1. Check the task-wide cache (USER/T1 "always") ────────────
    // Checked BEFORE the per-T2 cache so a grant covers every sibling worker
    // in the run, regardless of which T2 section raises the same tool next.
    // Untrusted callers (forceReprompt) skip the cache so a prior `always`
    // decision can't silently auto-approve their dangerous actions.
    if (!req.forceReprompt && this.taskWideCache.has(req.toolName)) {
      return {
        requestId: req.id,
        approved: this.taskWideCache.get(req.toolName)!,
        always: true,
        decidedBy: 'T1',
        reasoning: 'Cached from a previous task-wide decision in this session',
      };
    }

    const cacheKey = `${req.parentT2Id}:${req.toolName}`;

    // ── 1b. Check the per-T2 session cache ────────────
    // Untrusted callers (forceReprompt) skip the cache so a prior `always`
    // decision can't silently auto-approve their dangerous actions.
    if (!req.forceReprompt && this.sessionCache.has(cacheKey)) {
      return {
        requestId: req.id,
        approved: this.sessionCache.get(cacheKey)!,
        always: true,
        decidedBy: 'T2',
        reasoning: 'Cached from previous decision in this session',
      };
    }

    // ── 2. Non-dangerous safe tools → rule-based auto-approve ──
    if (!req.isDangerous && SAFE_TOOLS.has(req.toolName)) {
      const decision: PermissionDecision = {
        requestId: req.id,
        approved: true,
        always: true,
        decidedBy: 'T2',
        reasoning: `${req.toolName} is a read-only safe tool — auto-approved`,
      };
      this.sessionCache.set(cacheKey, true);
      return decision;
    }

    // ── 2b. Autonomous mode: auto-approve any NON-dangerous tool ──
    // Dangerous tools still fall through to T2/T1/user escalation below.
    if (this.autonomous && !req.isDangerous) {
      return {
        requestId: req.id,
        approved: true,
        always: false,
        decidedBy: 'T1',
        reasoning: 'Autonomous mode — non-dangerous tool auto-approved',
      };
    }

    // ── 3. Ask T2 evaluator ───────────────────
    if (this.t2Evaluator) {
      try {
        const t2Decision = await this.t2Evaluator(req);
        if (t2Decision !== null) {
          if (t2Decision.always) this.sessionCache.set(cacheKey, t2Decision.approved);
          return t2Decision;
        }
      } catch {
        // T2 evaluator failed — escalate without caching
      }
    }

    // ── 4. Ask T1 evaluator ───────────────────
    if (this.t1Evaluator) {
      try {
        const t1Decision = await this.t1Evaluator(req);
        if (t1Decision !== null) {
          if (t1Decision.always) this.taskWideCache.set(req.toolName, t1Decision.approved);
          return t1Decision;
        }
      } catch {
        // T1 evaluator failed — escalate to user
      }
    }

    // ── 5. Escalate to user ───────────────────
    return this.waitForUserDecision(req);
  }

  /**
   * Called by the REPL/SDK once the user has made a decision.
   * Only has effect when a request is actually pending.
   */
  resolveUserDecision(requestId: string, approved: boolean, always?: boolean): void {
    const resolver = this.pendingUserDecisions.get(requestId);
    if (!resolver) return;

    this.pendingUserDecisions.delete(requestId);
    const decision: PermissionDecision = {
      requestId,
      approved,
      always,
      decidedBy: 'USER',
    };

    // Caching on `always` happens inside wrappedResolver (waitForUserDecision),
    // which still has the original `req` in closure and caches task-wide.
    resolver(decision);
  }

  private waitForUserDecision(req: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wrappedResolver = (decision: PermissionDecision) => {
        if (timer) clearTimeout(timer);
        if (decision.always) {
          // Task-wide: a user's "Always" should cover every sibling worker in
          // this run, not just future requests under the same parent T2.
          this.taskWideCache.set(req.toolName, decision.approved);
        }
        resolve(decision);
      };

      this.pendingUserDecisions.set(req.id, wrappedResolver);

      // Time-box the wait: if no decision arrives (prompt unanswered or never
      // rendered), DENY — never auto-approve — so the run continues instead of
      // hanging forever on the pending Promise.
      if (this.approvalTimeoutMs > 0 && Number.isFinite(this.approvalTimeoutMs)) {
        timer = setTimeout(() => {
          if (this.pendingUserDecisions.delete(req.id)) {
            resolve({
              requestId: req.id,
              approved: false,
              decidedBy: 'USER',
              reasoning: `Approval timed out after ${this.approvalTimeoutMs}ms — denied for safety`,
            });
          }
        }, this.approvalTimeoutMs);
        // Don't keep the event loop alive solely for this timer.
        timer.unref?.();
      }

      // Emit event so cascade.ts / REPL can pick it up
      this.emit('permission:user-required', req);
    });
  }

  /** Check if there are permissions waiting for user input */
  hasPendingUserDecisions(): boolean {
    return this.pendingUserDecisions.size > 0;
  }

  /** Deny all pending user decisions (used on task cancel) */
  cancelAllPending(): void {
    for (const [id, resolver] of this.pendingUserDecisions) {
      resolver({ requestId: id, approved: false, decidedBy: 'USER', reasoning: 'Task cancelled' });
    }
    this.pendingUserDecisions.clear();
  }
}
