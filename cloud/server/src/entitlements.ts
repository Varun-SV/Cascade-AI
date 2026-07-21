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
}

const MB = 1024 * 1024;
const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { dailyRuns: 20, maxConcurrentRuns: 1, storageBytes: 10 * MB },
  pro: { dailyRuns: 200, maxConcurrentRuns: 3, storageBytes: 1024 * MB },
};

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
