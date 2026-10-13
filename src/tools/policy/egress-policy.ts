// ─────────────────────────────────────────────
//  Cascade AI — Outbound egress policy
// ─────────────────────────────────────────────
//
//  A control the platform owns, independent of any model's own refusal.
//
//  A model's safety training decides one call at a time, from the text of that
//  call. A run that decomposes a goal into narrow sub-tasks — the whole point of
//  the tier system — can hand each worker a slice that reads as harmless on its
//  own, so each call passes its own check while the run as a whole does not. The
//  refusal is a behavioural guardrail, not a boundary the platform can lean on.
//
//  This module is the boundary. It watches the SHAPE of outbound traffic a run
//  actually emits — how many requests, to how many hosts, how fast — rather than
//  the words that asked for it, because the shape of enumeration and scanning
//  survives decomposition when the intent does not. It also carries a denylist
//  hook the operator fills, and a scheme check. It does not try to read a
//  payload for "attack strings": that is a catalogue the next encoding defeats,
//  and keeping it out keeps this file from being one.
//
//  Verdicts are returned, never thrown, so each caller (web_fetch, the browser
//  controller) decides how to surface a block. A blocked call is also a signal:
//  the host counts blocks per user (see the abuse ledger) and suspends a user
//  who keeps hitting the wall, so this governor only has to be right about one
//  request at a time.

/** A reason an outbound request was refused. Stable codes, for the audit log. */
export type EgressDenyCode =
  | 'scheme' // not http/https
  | 'denylist' // host the operator refuses
  | 'host-rate' // too many requests to one host, too fast
  | 'host-spread' // too many distinct hosts, too fast (scanning)
  | 'total-rate'; // too many requests overall, too fast

export type EgressVerdict =
  | { allow: true }
  | { allow: false; code: EgressDenyCode; reason: string };

/** Limits for one actor (one user). All windows share one duration. */
export interface EgressLimits {
  /** The sliding window every count is measured over. */
  windowMs: number;
  /** Most requests to a single host within the window. */
  maxPerHost: number;
  /** Most distinct hosts within the window — the scanning signal. */
  maxHosts: number;
  /** Most requests overall within the window. */
  maxTotal: number;
}

/**
 * Sensible defaults for an interactive run. Generous enough that ordinary
 * browsing and research never meet them, tight enough that enumerating a host's
 * paths or sweeping a range of hosts does. Tune per plan at the call site.
 */
export const DEFAULT_EGRESS_LIMITS: EgressLimits = {
  windowMs: 60_000,
  maxPerHost: 60,
  maxHosts: 30,
  maxTotal: 120,
};

/** Decides whether a host is refused outright, before any counting. */
export type HostDenylist = (host: string) => boolean;

/** Lower-case a host and drop a trailing dot, so `A.com.` and `a.com` are one. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

interface Hit {
  host: string;
  at: number;
}

/**
 * One governor per isolated actor. The host keeps one per user (see the cloud
 * registry) so a run cannot shed its history by starting another run, and so
 * two users never share a limit. In the SDK a single run makes its own.
 *
 * State is a flat list of recent hits, pruned to the window on every check.
 * A run emits at most a few hundred requests a minute by construction (each is
 * a tool call the tiers gate), so the list stays short and the linear scan is
 * cheaper than the bookkeeping a bucketed structure would need.
 */
export class EgressGovernor {
  private readonly limits: EgressLimits;
  private readonly denylist: HostDenylist | undefined;
  private readonly now: () => number;
  private hits: Hit[] = [];

  constructor(opts: {
    limits?: Partial<EgressLimits>;
    denylist?: HostDenylist;
    /** Injectable clock, for tests. */
    now?: () => number;
  } = {}) {
    this.limits = { ...DEFAULT_EGRESS_LIMITS, ...(opts.limits ?? {}) };
    this.denylist = opts.denylist;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Judge one outbound request and, when allowed, record it. A refused request
   * is NOT recorded: a user hammering the wall should not also inflate the
   * window that an allowed burst is measured against, and the refusal is
   * already counted where it matters — the abuse ledger, via the caller.
   */
  check(rawUrl: string): EgressVerdict {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allow: false, code: 'scheme', reason: `Not a valid URL: ${rawUrl}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        allow: false,
        code: 'scheme',
        reason: `Only http and https addresses are allowed, not "${url.protocol}".`,
      };
    }
    const host = normalizeHost(url.hostname);
    if (this.denylist?.(host)) {
      return { allow: false, code: 'denylist', reason: `The host "${host}" is not allowed.` };
    }

    const t = this.now();
    this.prune(t);

    if (this.hits.length >= this.limits.maxTotal) {
      return {
        allow: false,
        code: 'total-rate',
        reason: `Too many outbound requests in a short time (over ${this.limits.maxTotal} in ${Math.round(this.limits.windowMs / 1000)}s). Slow down.`,
      };
    }
    let sameHost = 0;
    const hosts = new Set<string>();
    for (const h of this.hits) {
      hosts.add(h.host);
      if (h.host === host) sameHost++;
    }
    if (sameHost >= this.limits.maxPerHost) {
      return {
        allow: false,
        code: 'host-rate',
        reason: `Too many requests to "${host}" in a short time (over ${this.limits.maxPerHost} in ${Math.round(this.limits.windowMs / 1000)}s).`,
      };
    }
    // A new host counts against the spread limit; one already in the window
    // does not, so steady work against a known set of hosts is never a sweep.
    if (!hosts.has(host) && hosts.size >= this.limits.maxHosts) {
      return {
        allow: false,
        code: 'host-spread',
        reason: `Reaching too many different hosts in a short time (over ${this.limits.maxHosts} in ${Math.round(this.limits.windowMs / 1000)}s).`,
      };
    }

    this.hits.push({ host, at: t });
    return { allow: true };
  }

  private prune(t: number): void {
    const cutoff = t - this.limits.windowMs;
    // Hits are appended in time order, so the stale ones are a prefix.
    let i = 0;
    while (i < this.hits.length && this.hits[i]!.at <= cutoff) i++;
    if (i > 0) this.hits = this.hits.slice(i);
  }
}
