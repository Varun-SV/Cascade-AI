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
 * 1. Check session cache (section-wide key `${t2Id}:${toolName}`) → return if hit
 * 2. Ask T2 evaluator → if decision returned, cache + return
 * 3. Ask T1 evaluator → if decision returned, cache + return
 * 4. Emit `permission:user-required` → wait for external decision via `resolveUserDecision()`
 */
export class PermissionEscalator extends EventEmitter {
  /**
   * Session cache keyed by `${t2Id}:${toolName}`.
   * All T3 workers under the same T2 share cached decisions for the same tool.
   */
  private sessionCache = new Map<string, boolean>();

  private t2Evaluator?: T2Evaluator;
  private t1Evaluator?: T1Evaluator;

  /** Pending user-decision resolvers keyed by request ID */
  private pendingUserDecisions = new Map<
    string,
    (decision: PermissionDecision) => void
  >();

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
    const cacheKey = `${req.parentT2Id}:${req.toolName}`;

    // ── 1. Check session cache ────────────────
    if (this.sessionCache.has(cacheKey)) {
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
          if (t1Decision.always) this.sessionCache.set(cacheKey, t1Decision.approved);
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

    if (always) {
      // Find the cacheKey — walk pending list to find the T2 ID association
      // At this point we cache under a generic `user:${toolName}` scope
      // (the req itself is gone — resolver captures it by closure in waitForUserDecision)
    }

    resolver(decision);
  }

  private waitForUserDecision(req: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const wrappedResolver = (decision: PermissionDecision) => {
        if (decision.always) {
          this.sessionCache.set(`${req.parentT2Id}:${req.toolName}`, decision.approved);
        }
        resolve(decision);
      };

      this.pendingUserDecisions.set(req.id, wrappedResolver);

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
