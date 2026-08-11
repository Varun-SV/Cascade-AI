// ─────────────────────────────────────────────
//  Cascade AI — Per-Provider Token Bucket (TPM)
// ─────────────────────────────────────────────

import type { ProviderType } from '../../types.js';

/**
 * Default tokens-per-minute per provider. These are conservative floors that
 * match free-tier quotas; users can override via config.rateLimits.providerTpm.
 */
export const DEFAULT_PROVIDER_TPM: Record<ProviderType, number> = {
  anthropic: 40_000,
  openai: 30_000,
  gemini: 60_000,
  azure: 30_000,
  'openai-compatible': 30_000,
  ollama: Number.POSITIVE_INFINITY,
};

interface Bucket {
  tokensPerMinute: number;
  available: number;
  lastRefillMs: number;
}

/**
 * Token bucket rate limiter keyed by provider type.
 *
 * Each call to `acquire(provider, cost)` refills the bucket based on time
 * elapsed since the last refill, then waits (via setTimeout) until enough
 * tokens are available. Setting TPM to Infinity disables limiting for that
 * provider (used for local Ollama by default).
 */
/** The reason a signal carries, as an Error the caller can act on. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Aborted while waiting for rate-limit capacity');
}

/** setTimeout that also wakes on abort, and always cleans up after itself. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class TpmLimiter {
  private buckets: Map<ProviderType, Bucket> = new Map();

  constructor(overrides: Partial<Record<ProviderType, number>> = {}) {
    for (const [type, tpm] of Object.entries({ ...DEFAULT_PROVIDER_TPM, ...overrides })) {
      const limit = tpm ?? DEFAULT_PROVIDER_TPM[type as ProviderType];
      this.buckets.set(type as ProviderType, {
        tokensPerMinute: limit,
        available: limit,
        lastRefillMs: Date.now(),
      });
    }
  }

  /**
   * Block until `estimatedTokens` can be subtracted from the provider's
   * bucket. Estimated cost is best-effort — actual tokens used in the call
   * are reported back via `refund` when short, or simply settled at the next
   * refill.
   */
  async acquire(provider: ProviderType, estimatedTokens: number, signal?: AbortSignal): Promise<void> {
    const bucket = this.buckets.get(provider);
    if (!bucket || bucket.tokensPerMinute === Number.POSITIVE_INFINITY) return;
    // A caller can be held here for most of a refill interval. When the reason
    // it was waiting has gone away — the run cancelled, or its budget spent by
    // a sibling — it should stop waiting rather than sit out the full window
    // for a call that will be thrown away the moment it is admitted.
    if (signal?.aborted) throw abortReason(signal);

    // Clamp a single request to the bucket capacity so it can never be
    // impossible to fulfil.
    const want = Math.min(estimatedTokens, bucket.tokensPerMinute);

    for (;;) {
      this.refill(bucket);
      if (bucket.available >= want) {
        bucket.available -= want;
        return;
      }
      const deficit = want - bucket.available;
      // Wait just long enough to accumulate the deficit.
      const waitMs = Math.max(50, Math.ceil((deficit / bucket.tokensPerMinute) * 60_000));
      await sleepUnlessAborted(waitMs, signal);
      if (signal?.aborted) throw abortReason(signal);
    }
  }

  /**
   * Return unused estimated tokens back to the bucket after the call
   * resolved with fewer actual tokens than estimated.
   */
  refund(provider: ProviderType, tokens: number): void {
    const bucket = this.buckets.get(provider);
    if (!bucket || bucket.tokensPerMinute === Number.POSITIVE_INFINITY) return;
    bucket.available = Math.min(bucket.tokensPerMinute, bucket.available + Math.max(0, tokens));
  }

  setLimit(provider: ProviderType, tokensPerMinute: number): void {
    const existing = this.buckets.get(provider);
    if (existing) {
      existing.tokensPerMinute = tokensPerMinute;
      if (existing.available > tokensPerMinute) existing.available = tokensPerMinute;
    } else {
      this.buckets.set(provider, {
        tokensPerMinute,
        available: tokensPerMinute,
        lastRefillMs: Date.now(),
      });
    }
  }

  /** Internal: top up the bucket based on elapsed time. */
  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillMs;
    if (elapsedMs <= 0) return;
    const refill = (elapsedMs / 60_000) * bucket.tokensPerMinute;
    bucket.available = Math.min(bucket.tokensPerMinute, bucket.available + refill);
    bucket.lastRefillMs = now;
  }

  /** Diagnostics — returns current available budget per provider. */
  snapshot(): Record<string, { tokensPerMinute: number; available: number }> {
    const out: Record<string, { tokensPerMinute: number; available: number }> = {};
    for (const [k, v] of this.buckets) {
      this.refill(v);
      out[k] = { tokensPerMinute: v.tokensPerMinute, available: Math.round(v.available) };
    }
    return out;
  }
}
