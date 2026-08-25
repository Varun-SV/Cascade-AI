// ─────────────────────────────────────────────
//  Cascade AI — Provider Failover Manager
// ─────────────────────────────────────────────

import type { ModelInfo, ProviderType, TierRole } from '../../types.js';
import type { ModelSelector } from './selector.js';

/**
 * What a verdict is actually ABOUT.
 *
 * `ProviderType` is too coarse. Azure deliberately supports several configured
 * deployments, each able to carry its own resource, endpoint and key — see
 * ensureProvider(), which binds a config entry per deployment for exactly that
 * reason. So "azure is out of credit" is a claim about credentials the failure
 * never touched, and it makes every healthy sibling resource ineligible as a
 * fallback. A verdict is scoped to the credential that actually failed.
 */
export function failureScopeOf(model: { provider: ProviderType; id: string }): string {
  return model.provider === 'azure' ? `azure:${model.id}` : model.provider;
}

interface FailoverState {
  /** The credential this verdict is about — see failureScopeOf. */
  scope: string;
  provider: ProviderType;
  failedAt: number;
  reason: string;
  retryAfterMs: number;
  /** Number of consecutive failures — drives backoff step selection */
  failureCount: number;
  /**
   * True for a failure that does NOT ease with time: an exhausted billing
   * quota, a dead API key.
   *
   * The whole backoff ladder below is premised on the condition clearing on
   * its own — that is what a 429 does. A spent wallet does not. Routed through
   * the same ladder, an exhausted provider is re-enabled after 30s, called,
   * fails, backs off 60s, is re-enabled, fails … for the rest of the run,
   * never giving up and never getting anywhere. Every one of those is a wasted
   * round trip, and on some providers it also burns the separate
   * requests-per-minute allowance while doing it.
   *
   * router/provider-errors.ts has drawn this distinction from the start
   * ('rate_limit' — "systemic, but eases with time"; 'quota_exhausted' —
   * "systemic, does NOT ease"); nothing that made a routing decision had ever
   * asked it.
   */
  permanent: boolean;
  /**
   * The full user-facing explanation, when there is one — the provider's own
   * words plus what to do about them. `reason` stays a short label for the
   * failure report; this is what gets raised when a call is refused because
   * the provider is out.
   */
  detail?: string;
  /** Ordering stamp — see FailoverManager.recordSuccess. */
  seq: number;
}

export class FailoverManager {
  // Keyed by SCOPE (see failureScopeOf), not by provider type.
  private failures: Map<string, FailoverState> = new Map();
  private selector: ModelSelector;

  // Exponential backoff: 30s → 60s → 120s → 300s
  private readonly BACKOFF_STEPS = [30_000, 60_000, 120_000, 300_000];

  /** Verdict sequence, for ordering against calls already in flight. */
  /**
   * Monotonic stamp for ordering verdicts against calls already in flight.
   * A counter rather than a timestamp because two events in the same
   * millisecond must still be ordered.
   */
  private seq = 0;

  constructor(selector: ModelSelector) {
    this.selector = selector;
  }

  /**
   * @param opts.permanent this failure will not clear on its own — see
   *        FailoverState.permanent. Sticky: once a provider has earned a
   *        permanent verdict, a later ordinary failure must not downgrade it
   *        back onto the retry ladder.
   */
  recordFailure(
    provider: ProviderType,
    reason: string,
    opts: { permanent?: boolean; detail?: string; scope?: string } = {},
  ): void {
    const scope = opts.scope ?? provider;
    const existing = this.failures.get(scope);
    // Increment failure count and use it as the backoff step index so that
    // repeated failures correctly escalate through the full backoff ladder.
    const failureCount = (existing?.failureCount ?? 0) + 1;
    const step = Math.min(failureCount - 1, this.BACKOFF_STEPS.length - 1);
    const retryAfterMs = this.BACKOFF_STEPS[step] ?? 30_000;

    this.failures.set(scope, {
      scope,
      provider,
      failedAt: Date.now(),
      reason,
      retryAfterMs,
      failureCount,
      permanent: opts.permanent === true || existing?.permanent === true,
      // Keep the first explanation. A later, vaguer failure on an already-dead
      // provider must not overwrite the one that actually says what happened.
      detail: existing?.detail ?? opts.detail,
      seq: ++this.seq,
    });

    // Only pull the WHOLE provider when the verdict is about the whole
    // provider. A deployment-scoped one must leave its siblings selectable;
    // the router's model veto is what keeps that single deployment out.
    if (scope === provider) this.selector.markProviderUnavailable(provider);
  }

  /**
   * A token for "now", taken before a call is submitted and handed back to
   * recordSuccess. See recordSuccess for why a success needs to prove when it
   * started.
   */
  admissionToken(): number {
    return this.seq;
  }

  /** True when this credential is out for the run — quota gone, key dead. */
  isPermanentlyFailed(scope: string): boolean {
    return this.failures.get(scope)?.permanent === true;
  }

  /** Why this credential is out, in the user-facing wording. */
  permanentReason(scope: string): string | null {
    const f = this.failures.get(scope);
    return f?.permanent ? (f.detail ?? f.reason) : null;
  }

  /**
   * Drop every permanent verdict and hand its provider back to the selector.
   *
   * Called at each run boundary, because "run-scoped" has to be enforced by
   * something. The router and this manager outlive a single `run()` in the
   * REPL and the desktop app, so without this a verdict recorded once lasts
   * the whole PROCESS: a user who tops up their account, or pastes a working
   * key, would keep getting routed around the provider until they restarted.
   * That is precisely the failure a persisted TTL was rejected for.
   *
   * The transient backoff ladder is deliberately left alone. It is keyed to
   * wall-clock time and stays correct across a run boundary; clearing it would
   * send the next run straight back into a provider that is still throttling.
   */
  clearPermanentVerdicts(): void {
    for (const [scope, state] of [...this.failures]) {
      if (!state.permanent) continue;
      this.failures.delete(scope);
      // Only hand back what was taken. A deployment-scoped verdict never
      // removed the provider, so re-adding it here would resurrect a provider
      // that some OTHER, still-standing verdict had legitimately pulled.
      if (scope === state.provider) this.selector.markProviderAvailable(state.provider);
    }
  }

  isProviderAvailable(scope: string): boolean {
    const failure = this.failures.get(scope);
    if (!failure) return true;

    // The clock is not evidence. A timer expiring says only that time passed,
    // which is precisely what does not refill a spent quota — so a permanent
    // verdict is never lifted here. It can still be lifted by recordSuccess
    // (a call that actually worked) or clearFailure (the user acting), both of
    // which are real evidence rather than the absence of it.
    if (failure.permanent) return false;

    if (Date.now() - failure.failedAt >= failure.retryAfterMs) {
      // Retry window passed — re-enable provider in both the failure map and
      // the selector so the model priority chain can route to it again.
      this.failures.delete(scope);
      if (scope === failure.provider) this.selector.markProviderAvailable(failure.provider);
      return true;
    }
    return false;
  }

  /**
   * Call after a successful generation to immediately re-enable a provider
   * that had previously been marked unavailable. This allows fast recovery
   * when a transient rate-limit clears before the backoff window expires,
   * preventing unnecessary routing to more expensive fallback models.
   *
   * This clears a PERMANENT verdict too, and deliberately so. The verdict says
   * "time alone will not fix this" — it does not say the provider can never
   * work again. A call that actually succeeded is direct evidence the quota is
   * not in fact spent (topped up mid-run, or a deployment billed separately),
   * and that is a far stronger signal than the timer this same verdict exists
   * to ignore. In practice it fires rarely: an unavailable provider is out of
   * the selector's pool, so only an explicit per-subtask model pin can reach
   * one. That makes this a self-healing valve against a false lockout rather
   * than a routine path.
   *
   * Note it only ever clears the provider that succeeded. Failing over from an
   * exhausted Gemini to Azure calls recordSuccess('azure'), which leaves the
   * Gemini verdict exactly where it is.
   */
  recordSuccess(scope: string, admittedAt?: number): void {
    const failure = this.failures.get(scope);
    if (!failure) return;
    // A success is evidence about a verdict only if it STARTED after that
    // verdict existed. In a concurrent wave, call A can already be at the
    // provider when call B comes back with insufficient_quota; A completing
    // afterwards says nothing about the account's balance, because A was
    // admitted when the account still looked fine. Clearing on it would
    // resurrect the dead provider and send the whole rest of the wave back to
    // it. `admittedAt` is the token taken before the call was submitted.
    if (failure.permanent && admittedAt !== undefined && admittedAt < failure.seq) return;
    this.failures.delete(scope);
    if (scope === failure.provider) this.selector.markProviderAvailable(failure.provider);
  }

  getFallbackModel(currentModel: ModelInfo, tier: TierRole): ModelInfo | null {
    return this.selector.getNextFallback(currentModel.id, tier);
  }

  getFailureReport(): Record<string, string> {
    const report: Record<string, string> = {};
    for (const [scope, state] of this.failures) {
      const provider = scope;
      if (state.permanent) {
        // No countdown, because there is nothing to count down to. Promising a
        // retry that will never be attempted is worse than saying so.
        report[provider] = `Failed (${state.failureCount}x): ${state.reason}. Not retrying this run`;
        continue;
      }
      const remainingMs = state.retryAfterMs - (Date.now() - state.failedAt);
      report[provider] =
        `Failed (${state.failureCount}x): ${state.reason}. Retry in ${Math.ceil(remainingMs / 1000)}s`;
    }
    return report;
  }

  getFailureCount(scope: string): number {
    return this.failures.get(scope)?.failureCount ?? 0;
  }

  clearFailure(scope: string): void {
    const failure = this.failures.get(scope);
    this.failures.delete(scope);
    // Sync the selector so that manually cleared providers can be routed to
    // immediately without waiting for the backoff window to expire. A
    // deployment-scoped verdict never removed the provider, so there is
    // nothing to hand back for one.
    const provider = failure?.provider ?? (scope as ProviderType);
    if (!failure || scope === failure.provider) this.selector.markProviderAvailable(provider);
  }
}
