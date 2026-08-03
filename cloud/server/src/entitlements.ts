// ─────────────────────────────────────────────
//  Cascade Cloud Server — Entitlements
// ─────────────────────────────────────────────
//
// v1 ships free-only, but every run goes through these checks so the plan
// seams are real (not just a DB column) — Razorpay Subscriptions is a
// fast-follow that only needs to start writing a different `plan` value.

import type { CloudStore } from './db.js';

export interface PlanLimits {
  dailyRuns: number;
  maxConcurrentRuns: number;
  /** Cascade Files storage cap (bytes). Pro is a generous metered cap, not "unlimited". */
  storageBytes: number;
  /**
   * Ceiling on *unsaved* generated media held in the tenant's temp area
   * (bytes). Deliberately larger than `storageBytes`: nothing here is
   * permanent — every byte self-deletes after PENDING_MEDIA_TTL_MS — so it is
   * a burst allowance, not storage. It is NOT extra quota: promoting any of it
   * to a saved file still goes through `checkStorageQuota`.
   */
  pendingMediaBytes: number;
}

const MB = 1024 * 1024;
const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { dailyRuns: 20, maxConcurrentRuns: 1, storageBytes: 10 * MB, pendingMediaBytes: 64 * MB },
  pro: { dailyRuns: 200, maxConcurrentRuns: 3, storageBytes: 1024 * MB, pendingMediaBytes: 512 * MB },
};

/**
 * How long a generated-but-unsaved image/video survives before it is swept.
 *
 * 24 hours, chosen as the shortest window that still spans an overnight gap:
 * the realistic "I'll come back to that picture later today / first thing
 * tomorrow" behaviour is covered, while the unmetered bytes a single user can
 * park on the volume stay bounded to roughly one day of their own generation.
 * A longer window (48h+) buys little — someone who hasn't pressed Save within
 * a day has moved on — and doubles the disk that quota accounting cannot see.
 *
 * One constant, read by the sink, the sweeper and the lazy expiry checks, so
 * retuning the window is a one-line change.
 */
export const PENDING_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

export function limitsForPlan(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS['free']!;
}

/** Throw when saving `incomingBytes` would exceed the plan's storage cap. */
export function checkStorageQuota(usedBytes: number, incomingBytes: number, plan: string): void {
  const limit = limitsForPlan(plan).storageBytes;
  if (usedBytes + incomingBytes > limit) {
    throw new EntitlementError(
      `Storage full — you've used ${(usedBytes / MB).toFixed(1)} MB of your ${(limit / MB).toFixed(0)} MB `
      + `${plan === 'pro' ? 'Pro' : 'free'} limit. Delete some files${plan === 'pro' ? '' : ' or upgrade to Pro'} to save more.`,
    );
  }
}

/**
 * Throw when parking `incomingBytes` of freshly generated, unsaved media would
 * exceed the plan's pending-media allowance.
 *
 * The permanent quota is deliberately NOT consulted when media is generated —
 * that is the whole point of holding it as pending — but "not metered" cannot
 * mean "unbounded". Self-expiry limits how LONG bytes live, not how FAST they
 * arrive: a loop asking for video after video would otherwise park unlimited
 * bytes on the volume for a full TTL window. This is the rate ceiling.
 */
export function checkPendingMediaCap(usedBytes: number, incomingBytes: number, plan: string): void {
  const limit = limitsForPlan(plan).pendingMediaBytes;
  if (usedBytes + incomingBytes > limit) {
    throw new EntitlementError(
      `Too much unsaved generated media — ${(usedBytes / MB).toFixed(1)} MB of your ${(limit / MB).toFixed(0)} MB `
      + 'temporary media allowance is in use. Save what you want to keep (or delete it) and try again; '
      + 'unsaved media clears itself within 24 hours.',
    );
  }
}

export class EntitlementError extends Error {}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function checkDailyLimit(store: CloudStore, userId: string, plan: string): void {
  const limits = limitsForPlan(plan);
  const used = store.getUsage(userId, todayKey());
  if (used >= limits.dailyRuns) {
    throw new EntitlementError(
      `Daily run limit reached (${limits.dailyRuns} for the ${plan} plan). Resets at midnight UTC.`,
    );
  }
}

// In-memory per-user concurrency tracking. Correct for a single server
// process (v1's deploy target); a horizontally-scaled deploy would need
// this moved to shared state (e.g. Redis) — noted for the fast-follow.
const activeRuns = new Map<string, number>();

export function beginRun(userId: string, plan: string): () => void {
  const limits = limitsForPlan(plan);
  const current = activeRuns.get(userId) ?? 0;
  if (current >= limits.maxConcurrentRuns) {
    throw new EntitlementError(
      `You already have ${current} run(s) in progress (limit: ${limits.maxConcurrentRuns} for the ${plan} plan).`,
    );
  }
  activeRuns.set(userId, current + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeRuns.get(userId) ?? 1) - 1;
    if (remaining <= 0) activeRuns.delete(userId);
    else activeRuns.set(userId, remaining);
  };
}

/** Test-only escape hatch — activeRuns is module-level state that otherwise leaks between tests. */
export function _resetActiveRunsForTests(): void {
  activeRuns.clear();
}
