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
}

export class FailoverManager {
  private failures: Map<ProviderType, FailoverState> = new Map();
  private selector: ModelSelector;

  // Exponential backoff: 30s → 60s → 120s → 300s
  private readonly BACKOFF_STEPS = [30_000, 60_000, 120_000, 300_000];

  constructor(selector: ModelSelector) {
    this.selector = selector;
  }

  recordFailure(provider: ProviderType, reason: string): void {
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
    });

    this.selector.markProviderUnavailable(provider);
  }

  isProviderAvailable(provider: ProviderType): boolean {
    const failure = this.failures.get(provider);
    if (!failure) return true;

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
