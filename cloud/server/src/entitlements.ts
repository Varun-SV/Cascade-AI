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
  /**
   * Largest single document this plan may attach to a run (bytes).
   *
   * A RESOURCE limit, and the only limit on a document's length. What stood
   * here before was a fixed 200,000-character cut applied during text
   * extraction — a context-window decision taken at ingestion, in front of a
   * pipeline that already sizes documents against the run's real window. It
   * destroyed the rest of the file before anything could ask for it.
   *
   * Cost tracks size: indexing a document is proportional to its length, so
   * bounding the bytes per plan bounds the spend per plan without interrupting
   * anyone mid-run to ask.
   *
   * Distinct from `storageBytes`, which is the total a user may keep. This is
   * how big any ONE of them may be.
   */
  documentBytes: number;
  /**
   * Cumulative extracted document TEXT this plan may keep in the shared
   * database, in characters.
   *
   * `documentBytes` bounds one upload. It does not bound a user: ingestion used
   * to cut every document at 200,000 characters, and removing that cut — which
   * was destroying the rest of the file before anything could ask for it — left
   * nothing counting what a tenant accumulates. A DOCX compresses well, so a
   * few megabytes of upload can become tens of megabytes of durable text, and
   * rows uploaded but never attached to a run are not reached by conversation
   * deletion. Repeat that and one account quietly owns the database.
   *
   * Characters rather than bytes, because that is what the row stores and what
   * `char_count` already reports, so the number the user is shown and the
   * number enforced here are the same one.
   *
   * Free gets one maximal document's worth (EXPANSION_CEILING_CHARS), so the
   * ceiling never refuses a single legitimate file; Pro gets ten. Starting
   * points, chosen to be generous against real documents and finite against
   * crafted ones — a 1,000-page PDF is about 3M characters.
   */
  documentTextChars: number;
  /**
   * Browser sessions this plan may open per UTC day.
   *
   * Sessions, not runs or minutes: a session is the unit the provider bills
   * for, and the one thing that exists only because someone turned the
   * Browser chip on. Counted when a session is created (see
   * `RemoteBrowserController.onSessionCreatedFor`), so a browser-mode run that
   * never needed one costs nothing here.
   *
   * Separate from `maxConcurrentRuns` and the deployment's `maxSessions`,
   * which bound how many at ONCE. This bounds how many in a day.
   */
  dailyBrowserSessions: number;
}

const MB = 1024 * 1024;
const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { dailyRuns: 20, maxConcurrentRuns: 1, storageBytes: 10 * MB, pendingMediaBytes: 64 * MB, documentBytes: 5 * MB, documentTextChars: 25_000_000, dailyBrowserSessions: 5 },
  pro: { dailyRuns: 200, maxConcurrentRuns: 3, storageBytes: 1024 * MB, pendingMediaBytes: 512 * MB, documentBytes: 10 * MB, documentTextChars: 250_000_000, dailyBrowserSessions: 50 },
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

/**
 * How long an uploaded document may sit unattached to any message before it is
 * swept.
 *
 * An upload starts with `message_id` NULL and is linked when a run uses it, so
 * a row still NULL long afterwards is one the user never sent. Those are the
 * rows nothing else removes: conversation deletion cascades from `messages`,
 * and an orphan has no message to cascade from. Without a sweep the only way
 * out of the text ceiling would be deleting conversations that were never the
 * problem.
 *
 * Seven days rather than the 24 hours pending media gets, because this is
 * content the USER made rather than something a tool generated: a draft left
 * open over a long weekend should still have its attachment. The trade is that
 * an upload abandoned for longer than a week is silently absent if it is ever
 * sent — the run path skips ids it cannot find — and a week is long enough
 * that this is a fair place to draw it.
 */
export const ORPHAN_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * Why this user may not open another browser session today, or nothing.
 *
 * A message rather than a boolean, because the same words go to the model (as
 * the tool's refusal) and to the person (as the notice), and they must agree.
 */
export function browserSessionRefusal(store: CloudStore, userId: string, plan: string): string | undefined {
  const limit = limitsForPlan(plan).dailyBrowserSessions;
  if (store.getBrowserSessions(userId, todayKey()) < limit) return undefined;
  return usedUpMessage(plan, limit);
}

function usedUpMessage(plan: string, limit: number): string {
  const pro = limitsForPlan('pro').dailyBrowserSessions;
  return `Today's browser sessions are used up (${limit} a day on the ${plan === 'pro' ? 'Pro' : 'free'} plan). `
    + 'They reset at midnight UTC.'
    + (plan === 'pro' ? '' : ` Pro includes ${pro} a day.`);
}

/**
 * Claim one of today's browser sessions, the moment one is about to be opened.
 *
 * Claimed rather than checked: a check here and a count once the session
 * existed let concurrent runs all see the same last session and each open
 * one. The claim is atomic (see `CloudStore.takeBrowserSession`), and
 * `giveBack` returns it — to the day it was taken from, even if midnight has
 * passed since — when no session came of it.
 */
export function claimBrowserSession(
  store: CloudStore, userId: string, plan: string,
): { refusal: string } | { giveBack: () => void } {
  const day = todayKey();
  const limit = limitsForPlan(plan).dailyBrowserSessions;
  if (!store.takeBrowserSession(userId, day, limit)) return { refusal: usedUpMessage(plan, limit) };
  return { giveBack: () => store.giveBackBrowserSession(userId, day) };
}

/**
 * Refuse a browser-mode run up front when today's sessions are already gone.
 *
 * A run that cannot open a browser should not start as though it could: the
 * chip is the user asking for one, and a run without it is the run that
 * wrote a site's answer itself. Refused before anything is persisted or spent,
 * like the daily run limit.
 */
export function checkBrowserSessionLimit(store: CloudStore, userId: string, plan: string): void {
  const refusal = browserSessionRefusal(store, userId, plan);
  if (refusal) throw new EntitlementError(refusal);
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
