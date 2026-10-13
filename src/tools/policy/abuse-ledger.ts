// ─────────────────────────────────────────────
//  Cascade AI — Abuse ledger
// ─────────────────────────────────────────────
//
//  The egress governor only has to be right about one request at a time because
//  this ledger remembers the rest. Every policy block the platform records lands
//  here against the user it came from; once a user collects more than a
//  threshold of blocks inside a window, the ledger reports them suspended and
//  the host refuses their further runs until a person clears it.
//
//  Decoupling the two keeps each simple. The governor is a pure rate judgement
//  with no notion of "who" beyond the actor it was handed; the ledger is the
//  only place that reasons about a user across runs. It is pure too: the caller
//  owns persistence (the cloud store) and passes the record in and out, so the
//  same logic serves an in-memory test and a database-backed deployment without
//  either leaking into it.

/** One recorded block against a user. */
export interface AbuseStrike {
  /** Epoch ms. */
  at: number;
  /** The egress deny code, or another policy reason, for the audit trail. */
  code: string;
}

/** What the host persists per user. Serialisable; no methods. */
export interface AbuseRecord {
  strikes: AbuseStrike[];
  /**
   * Set once the ledger decides a user is suspended, and never cleared by this
   * module — only a person (an operator action) lifts it, so a suspended user
   * who waits out the window is still suspended. Epoch ms of the decision.
   */
  suspendedAt?: number;
  /** The code that tipped them over, kept for the notice and the audit log. */
  suspendedFor?: string;
}

export interface AbusePolicy {
  /** The window strikes are counted over. */
  windowMs: number;
  /** Strikes within the window that trip suspension (the Nth trips it). */
  threshold: number;
}

export const DEFAULT_ABUSE_POLICY: AbusePolicy = {
  windowMs: 60 * 60 * 1000, // one hour
  threshold: 5,
};

export function emptyRecord(): AbuseRecord {
  return { strikes: [] };
}

/** True once a record carries a suspension this module set. */
export function isSuspended(record: AbuseRecord | undefined): boolean {
  return !!record?.suspendedAt;
}

/**
 * Fold one new strike into a record and decide whether it suspends the user.
 * Returns a NEW record (the input is not mutated) plus whether this strike was
 * the one that tipped them over, so the caller can log and notify exactly once.
 *
 * An already-suspended user stays suspended: the strike is still recorded (it is
 * evidence), but `nowSuspended` is false because nothing changed — the caller
 * should not fire a second suspension notice.
 */
export function recordStrike(
  record: AbuseRecord,
  strike: AbuseStrike,
  policy: AbusePolicy = DEFAULT_ABUSE_POLICY,
): { record: AbuseRecord; nowSuspended: boolean } {
  const cutoff = strike.at - policy.windowMs;
  // Keep strikes within the window, plus the new one. Older strikes are dropped
  // from the live count but their having happened already shows in a suspension
  // that was set while they were fresh — suspension does not expire here.
  const strikes = [...record.strikes.filter((s) => s.at > cutoff), strike];

  if (record.suspendedAt) {
    return { record: { ...record, strikes }, nowSuspended: false };
  }

  const recent = strikes.filter((s) => s.at > cutoff).length;
  if (recent >= policy.threshold) {
    return {
      record: { strikes, suspendedAt: strike.at, suspendedFor: strike.code },
      nowSuspended: true,
    };
  }
  return { record: { ...record, strikes }, nowSuspended: false };
}

/** How many strikes stand within the window as of `now`. For status display. */
export function recentStrikeCount(
  record: AbuseRecord,
  now: number,
  policy: AbusePolicy = DEFAULT_ABUSE_POLICY,
): number {
  const cutoff = now - policy.windowMs;
  return record.strikes.filter((s) => s.at > cutoff).length;
}

/**
 * Lift a suspension — the one transition this module won't make on its own.
 * Clears the flag and the strike history, so a reinstated user starts clean
 * rather than one strike away from the wall. An operator action calls this.
 */
export function clearSuspension(_record: AbuseRecord): AbuseRecord {
  return emptyRecord();
}
