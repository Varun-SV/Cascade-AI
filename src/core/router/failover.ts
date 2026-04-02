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
    const step = existing ? Math.min(this.BACKOFF_STEPS.length - 1, 1) : 0;
    const retryAfterMs = this.BACKOFF_STEPS[step] ?? 30_000;

    this.failures.set(provider, {
      provider,
      failedAt: Date.now(),
      reason,
      retryAfterMs,
    });

    this.selector.markProviderUnavailable(provider);
  }

  isProviderAvailable(provider: ProviderType): boolean {
    const failure = this.failures.get(provider);
    if (!failure) return true;

    if (Date.now() - failure.failedAt >= failure.retryAfterMs) {
      // Retry window passed — mark as potentially available again
      this.failures.delete(provider);
      return true;
    }
    return false;
  }

  getFallbackModel(currentModel: ModelInfo, tier: TierRole): ModelInfo | null {
    return this.selector.getNextFallback(currentModel.id, tier);
  }

  getFailureReport(): Record<string, string> {
    const report: Record<string, string> = {};
    for (const [provider, state] of this.failures) {
      const remainingMs = state.retryAfterMs - (Date.now() - state.failedAt);
      report[provider] = `Failed: ${state.reason}. Retry in ${Math.ceil(remainingMs / 1000)}s`;
    }
    return report;
  }

  clearFailure(provider: ProviderType): void {
    this.failures.delete(provider);
  }
}
