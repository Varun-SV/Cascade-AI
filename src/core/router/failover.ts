// ─────────────────────────────────────────────
//  Cascade AI — Provider Failover Manager
// ─────────────────────────────────────────────

import type { ModelInfo, ProviderType, TierRole } from '../../types.js';
import type { ModelSelector } from './selector.js';

interface FailoverState {
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
}

export class FailoverManager {
  private failures: Map<ProviderType, FailoverState> = new Map();
  private selector: ModelSelector;

  // Exponential backoff: 30s → 60s → 120s → 300s
  private readonly BACKOFF_STEPS = [30_000, 60_000, 120_000, 300_000];

  constructor(selector: ModelSelector) {
    this.selector = selector;
  }

  /**
   * @param opts.permanent this failure will not clear on its own — see
   *        FailoverState.permanent. Sticky: once a provider has earned a
   *        permanent verdict, a later ordinary failure must not downgrade it
   *        back onto the retry ladder.
   */
  recordFailure(provider: ProviderType, reason: string, opts: { permanent?: boolean } = {}): void {
    const existing = this.failures.get(provider);
    // Increment failure count and use it as the backoff step index so that
    // repeated failures correctly escalate through the full backoff ladder.
    const failureCount = (existing?.failureCount ?? 0) + 1;
    const step = Math.min(failureCount - 1, this.BACKOFF_STEPS.length - 1);
    const retryAfterMs = this.BACKOFF_STEPS[step] ?? 30_000;

    this.failures.set(provider, {
      provider,
      failedAt: Date.now(),
      reason,
      retryAfterMs,
      failureCount,
      permanent: opts.permanent === true || existing?.permanent === true,
    });

    this.selector.markProviderUnavailable(provider);
  }

  /** True when this provider is out for the run — quota gone, key dead. */
  isPermanentlyFailed(provider: ProviderType): boolean {
    return this.failures.get(provider)?.permanent === true;
  }

  isProviderAvailable(provider: ProviderType): boolean {
    const failure = this.failures.get(provider);
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
      this.failures.delete(provider);
      this.selector.markProviderAvailable(provider);
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
  recordSuccess(provider: ProviderType): void {
    if (this.failures.has(provider)) {
      this.failures.delete(provider);
      this.selector.markProviderAvailable(provider);
    }
  }

  getFallbackModel(currentModel: ModelInfo, tier: TierRole): ModelInfo | null {
    return this.selector.getNextFallback(currentModel.id, tier);
  }

  getFailureReport(): Record<string, string> {
    const report: Record<string, string> = {};
    for (const [provider, state] of this.failures) {
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

  getFailureCount(provider: ProviderType): number {
    return this.failures.get(provider)?.failureCount ?? 0;
  }

  clearFailure(provider: ProviderType): void {
    this.failures.delete(provider);
    // Sync the selector so that manually cleared providers can be routed to
    // immediately without waiting for the backoff window to expire.
    this.selector.markProviderAvailable(provider);
  }
}
