// ─────────────────────────────────────────────
//  Cascade Cloud — per-user egress enforcement
// ─────────────────────────────────────────────
//
//  Ties the SDK's pure egress governor and abuse ledger to a real user and a
//  real store. One governor per user, kept for the life of the process so a
//  user cannot reset their rate window by starting a fresh run, and the ledger
//  persisted so a suspension outlives a restart.
//
//  `buildEgressGate(store, userId)` returns the closure the run hands to
//  `cascade.setEgressGate` and to the remote browser controller. It judges one
//  caller-named URL: a refusal is returned to the model as the tool's error and
//  recorded as a strike against the user; enough strikes in the window suspend
//  them, and a suspended user's every further request is refused up front.

import {
  EgressGovernor,
  recordStrike,
  isSuspended,
  emptyRecord,
  type EgressVerdict,
  type EgressLimits,
  type AbuseRecord,
  type AbusePolicy,
} from '#cascade-ai';
import type { CloudStore } from './db.js';

/** A gate the run installs; judges one URL and meters the user behind it. */
export type EgressGate = (url: string) => EgressVerdict;

/**
 * One governor per user, for the life of the process. Not persisted: the rate
 * window is inherently short-lived, and losing it on a restart only forgives a
 * burst that was already in flight — the ledger, which IS persisted, keeps the
 * part that must survive. Keyed by user so two users never share a limit.
 */
const governors = new Map<string, EgressGovernor>();

/** Per-plan limits could diverge later; one set for now. Exposed for tests. */
export function limitsForPlan(_plan: string): Partial<EgressLimits> | undefined {
  return undefined; // the governor's own defaults
}

function governorFor(userId: string, plan: string): EgressGovernor {
  let g = governors.get(userId);
  if (!g) {
    const limits = limitsForPlan(plan);
    g = new EgressGovernor(limits ? { limits } : {});
    governors.set(userId, g);
  }
  return g;
}

/** Drop a user's governor — a test seam, and a hook for account deletion. */
export function forgetGovernor(userId: string): void {
  governors.delete(userId);
}

function loadRecord(store: CloudStore, userId: string): AbuseRecord {
  const raw = store.getAbuseRecord(userId);
  if (!raw) return emptyRecord();
  try {
    const parsed = JSON.parse(raw) as AbuseRecord;
    // A record that does not parse to the expected shape is treated as empty
    // rather than crashing the run; the next strike rewrites it cleanly.
    if (!parsed || !Array.isArray(parsed.strikes)) return emptyRecord();
    return parsed;
  } catch {
    return emptyRecord();
  }
}

export interface EgressGateDeps {
  store: CloudStore;
  userId: string;
  plan?: string;
  policy?: AbusePolicy;
  /** Told when this user is newly suspended, so the host can log/notify once. */
  onSuspended?: (code: string) => void;
  /** Told on every strike, suspended or not — for the audit trail. */
  onStrike?: (code: string, reason: string) => void;
}

/** The message a suspended user's blocked request carries. */
export function suspendedMessage(): string {
  return 'This account is suspended for repeated policy violations. Contact support to restore access.';
}

/**
 * Build the per-user egress gate. The returned closure is safe to call from any
 * tool or the browser controller; it reads and writes the user's persisted
 * record on each refusal, which is rare (an allowed request touches only the
 * in-memory governor).
 */
export function buildEgressGate(deps: EgressGateDeps): EgressGate {
  const { store, userId } = deps;
  const plan = deps.plan ?? 'free';
  return (url: string): EgressVerdict => {
    // A suspended user is refused before the governor even looks: the block is
    // the point, not the rate. Read live so an operator's mid-session clear
    // takes effect without rebuilding the gate.
    if (store.isUserSuspended(userId)) {
      return { allow: false, code: 'denylist', reason: suspendedMessage() };
    }

    const verdict = governorFor(userId, plan).check(url);
    if (verdict.allow) return verdict;

    // A refusal is a strike. Fold it into the persisted record and, if it tips
    // the user over, record the suspension — all in the ledger's pure logic.
    const before = loadRecord(store, userId);
    const { record, nowSuspended } = recordStrike(
      before,
      { at: Date.now(), code: verdict.code },
      deps.policy,
    );
    store.saveAbuseRecord(
      userId,
      JSON.stringify(record),
      record.suspendedAt ?? null,
    );
    deps.onStrike?.(verdict.code, verdict.reason);
    if (nowSuspended) deps.onSuspended?.(verdict.code);

    // If this strike suspended them, say so rather than quoting the rate — the
    // next request would say it anyway, and the stronger notice is the honest
    // one for the action that just crossed the line.
    if (nowSuspended || isSuspended(record)) {
      return { allow: false, code: verdict.code, reason: suspendedMessage() };
    }
    return verdict;
  };
}

// ── Per-run resolver for the shared browser controller ──────
//
// The remote browser controller is one instance shared by every run on the
// deployment, so it cannot hold one user's gate. It is built once with a
// resolver that looks the acting run's gate up here; each run registers its
// gate when it starts and removes it when it ends.

const gatesByRun = new Map<string, EgressGate>();

export function registerRunGate(runId: string, gate: EgressGate): void {
  gatesByRun.set(runId, gate);
}

export function unregisterRunGate(runId: string): void {
  gatesByRun.delete(runId);
}

/**
 * The resolver the controller is built with. An unknown run (a race between the
 * action and registration, or a run with no gate) is allowed: web_fetch and the
 * tool path still meter that user, and failing a navigate closed on a bookkeeping
 * gap would break ordinary browsing. The gate itself never fails open on a
 * suspended user — that check is inside it.
 */
export function resolveRunEgress(url: string, runId: string): EgressVerdict {
  const gate = gatesByRun.get(runId);
  return gate ? gate(url) : { allow: true };
}
