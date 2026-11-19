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
/** The answer to a request its caller withdrew before it was decided. */
function withdrawn(req: PermissionRequest): PermissionDecision {
  return { requestId: req.id, approved: false, decidedBy: 'USER', reasoning: 'Withdrawn: the caller stopped before it was decided' };
}

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
  /** The cache entries a T2 or T1 model made (`session:<key>`, `task:<tool>`), as against a person or a rule. */
  private modelDecided = new Set<string>();

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
  /**
   * Whether T2 and T1 are asked about a dangerous call at all. They can only
   * advise on one — it always comes to the user — so by default they aren't:
   * each piece of advice was a model call per request, and the web never showed it.
   */
  private adviseOnDangerous: boolean;
  /**
   * The project is checkpointed around the run (CascadeRunOptions.undoable).
   * Then, in autonomous mode, a dangerous tool's call that is not risky (see
   * Risk: it reads, or makes a change the checkpoint can undo) goes ahead,
   * and an "always" answer covers one kind of risk of one tool — "shell that
   * deletes" — rather than the whole tool.
   */
  private undoable: boolean;
  /** Whether the run's checkpoint records these files (CascadeRunOptions.checkpointed). */
  private checkpointed?: (paths: string[]) => Promise<boolean>;

  /** How to tell whether a file a call writes is in the run's checkpoint. */
  setCheckpointCoverage(fn: (paths: string[]) => Promise<boolean>): void {
    this.checkpointed = fn;
  }

  constructor(approvalTimeoutMs = 600_000, autonomous = false, adviseOnDangerous = false, undoable = false) {
    super();
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.autonomous = autonomous;
    this.adviseOnDangerous = adviseOnDangerous;
    this.undoable = undoable;
  }

  /**
   * What an "always" answer is remembered under. With checkpoints, a risky
   * call's grant is for its kind of risk: allowing `rm -r build/` for the run
   * must not also allow `git push --force`.
   */
  private grantKey(req: PermissionRequest): string {
    if (!this.undoable || !req.risk) return req.toolName;
    return `${req.toolName}#${req.risk.level === 'risky' ? req.risk.category ?? 'unclassified' : 'undoable'}`;
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
  async requestPermission(req: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
    const decision = await this.decide(req, signal);
    // A decision reached after the caller stopped waiting grants nothing:
    // what it would have allowed is no longer running to use it.
    return signal?.aborted && decision.approved ? withdrawn(req) : decision;
  }

  private async decide(req: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
    if (signal?.aborted) return withdrawn(req);
    // An undoable call is only undoable if the checkpoint records what it
    // writes: a file the .gitignore leaves out (local-data/, .env) would be
    // overwritten with nothing to put it back. Settled first, so an earlier
    // "allow for this run" is looked up under what the call really is.
    if (this.autonomous && this.undoable && req.risk?.level === 'recoverable' && req.risk.writes?.length && this.checkpointed) {
      const recorded = await this.checkpointed(req.risk.writes).catch(() => false);
      if (signal?.aborted) return withdrawn(req);
      if (!recorded) {
        req.risk = {
          level: 'risky', category: 'unrecorded',
          reason: `writes a file the checkpoint doesn't record (the project's .gitignore leaves it out), so /undo couldn't put it back`,
        };
      }
    }
    // ── 1. Check the task-wide cache (USER/T1 "always") ────────────
    // Checked BEFORE the per-T2 cache so a grant covers every sibling worker
    // in the run, regardless of which T2 section raises the same tool next.
    // Untrusted callers (forceReprompt) skip the cache so a prior `always`
    // decision can't silently auto-approve their dangerous actions.
    // A model's "always" does not stand for a local-only caller, whose
    // requests those models never see: only a person's grant — or a refusal,
    // which costs nothing to honour — carries over to it.
    const stands = (approved: boolean, byModel: boolean) => !((req.localOnly || req.askPerson) && byModel && approved);
    const grant = this.grantKey(req);
    if (!req.forceReprompt && this.taskWideCache.has(grant)
      && stands(this.taskWideCache.get(grant)!, this.modelDecided.has(`task:${grant}`))) {
      return {
        requestId: req.id,
        approved: this.taskWideCache.get(grant)!,
        always: true,
        decidedBy: 'T1',
        reasoning: 'Cached from a previous task-wide decision in this session',
      };
    }

    const cacheKey = `${req.parentT2Id}:${grant}`;

    // ── 1b. Check the per-T2 session cache ────────────
    // Untrusted callers (forceReprompt) skip the cache so a prior `always`
    // decision can't silently auto-approve their dangerous actions.
    if (!req.forceReprompt && this.sessionCache.has(cacheKey)
      && stands(this.sessionCache.get(cacheKey)!, this.modelDecided.has(`session:${cacheKey}`))) {
      return {
        requestId: req.id,
        approved: this.sessionCache.get(cacheKey)!,
        always: true,
        decidedBy: 'T2',
        reasoning: 'Cached from previous decision in this session',
      };
    }

    // ── 1c. The person's own to answer ─────────
    // Nothing below may approve it: not a rule, not autonomous mode, not a
    // tier's model. Only a person's earlier "allow for this run" (above) does.
    if (req.askPerson) return this.waitForUserDecision(req, signal);

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
    // ── 2b'. Autonomous mode with checkpoints: a dangerous tool's call that
    // only reads, or only changes what the checkpoint can put back, goes
    // ahead. A risky one — deleting, sending, rewriting history, installing,
    // outside the project… — still asks. An untrusted tool always asks.
    if (this.autonomous && this.undoable && req.risk && req.risk.level !== 'risky' && !req.forceReprompt) {
      return {
        requestId: req.id,
        approved: true,
        always: false,
        decidedBy: 'T1',
        reasoning: `Auto mode: ${req.risk.reason}`,
      };
    }

    // ── 2c. Dangerous: the user's, and nobody's advice is asked ──
    // The tiers below never decide a dangerous call; they only add advice.
    if (req.isDangerous && !this.adviseOnDangerous) return this.waitForUserDecision(req, signal);

    // ── 3. Ask T2 evaluator ───────────────────
    // Not for a local-only caller: the evaluators put the input in a prompt
    // for a model that may be a cloud one.
    if (this.t2Evaluator && !req.localOnly) {
      try {
        const t2Decision = await this.t2Evaluator(req);
        // The caller may have stopped waiting while the model thought. Its
        // answer is not cached: an "always" reached for a call that no
        // longer exists would approve the next one in its place.
        if (signal?.aborted) return withdrawn(req);
        if (t2Decision !== null) {
          if (t2Decision.always) {
            this.sessionCache.set(cacheKey, t2Decision.approved);
            this.modelDecided.add(`session:${cacheKey}`);
          }
          return t2Decision;
        }
      } catch {
        // T2 evaluator failed — escalate without caching
      }
    }

    // ── 4. Ask T1 evaluator ───────────────────
    if (this.t1Evaluator && !req.localOnly) {
      try {
        const t1Decision = await this.t1Evaluator(req);
        if (signal?.aborted) return withdrawn(req);
        if (t1Decision !== null) {
          if (t1Decision.always) {
            this.taskWideCache.set(this.grantKey(req), t1Decision.approved);
            this.modelDecided.add(`task:${this.grantKey(req)}`);
          }
          return t1Decision;
        }
      } catch {
        // T1 evaluator failed — escalate to user
      }
    }

    // ── 5. Escalate to user ───────────────────
    return this.waitForUserDecision(req, signal);
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

  private waitForUserDecision(req: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
    // Nobody to ask for: a listener added to a signal already aborted never
    // fires, so the question would sit on screen for a call that has gone.
    if (signal?.aborted) return Promise.resolve(withdrawn(req));
    return new Promise<PermissionDecision>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // The caller stopped waiting: the question is taken back, unanswered.
      const onAbort = () => {
        if (!this.pendingUserDecisions.delete(req.id)) return;
        if (timer) clearTimeout(timer);
        resolve(withdrawn(req));
      };
      const wrappedResolver = (decision: PermissionDecision) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (decision.always) {
          // Task-wide: a user's "Always" should cover every sibling worker in
          // this run, not just future requests under the same parent T2.
          this.taskWideCache.set(this.grantKey(req), decision.approved);
          this.modelDecided.delete(`task:${this.grantKey(req)}`);
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

      signal?.addEventListener('abort', onAbort, { once: true });
      // Emit event so cascade.ts / REPL can pick it up
      // Whether this run has a checkpoint, so the question can say truly
      // whether /undo could take the change back.
      req.undoable = this.undoable;
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
