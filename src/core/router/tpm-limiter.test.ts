import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TpmLimiter, DEFAULT_PROVIDER_TPM } from './tpm-limiter.js';

describe('TpmLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests within the per-minute budget without waiting', async () => {
    const limiter = new TpmLimiter({ openai: 1000 });
    await limiter.acquire('openai', 400);
    await limiter.acquire('openai', 500);
    // Remaining should be ~100
    const snap = limiter.snapshot();
    expect(snap['openai']!.available).toBeLessThanOrEqual(100);
  });

  it('refills the bucket over time', async () => {
    const limiter = new TpmLimiter({ openai: 600 }); // 10/sec
    await limiter.acquire('openai', 600);
    expect(limiter.snapshot()['openai']!.available).toBeLessThan(10);

    vi.setSystemTime(Date.now() + 30_000); // 30s → +300 tokens
    const snap = limiter.snapshot();
    expect(snap['openai']!.available).toBeGreaterThanOrEqual(290);
    expect(snap['openai']!.available).toBeLessThanOrEqual(310);
  });

  it('skips limiting when TPM is Infinity (ollama default)', async () => {
    const limiter = new TpmLimiter();
    const start = Date.now();
    await limiter.acquire('ollama', 10_000_000);
    expect(Date.now()).toBe(start); // no wait
  });

  it('refund returns unused tokens to the bucket', async () => {
    const limiter = new TpmLimiter({ openai: 1000 });
    await limiter.acquire('openai', 500);
    limiter.refund('openai', 200);
    expect(limiter.snapshot()['openai']!.available).toBeGreaterThanOrEqual(700);
  });

  it('setLimit adjusts both the cap and the available budget', () => {
    const limiter = new TpmLimiter({ openai: 1000 });
    limiter.setLimit('openai', 500);
    const snap = limiter.snapshot();
    expect(snap['openai']!.tokensPerMinute).toBe(500);
    expect(snap['openai']!.available).toBeLessThanOrEqual(500);
  });

  it('exposes sensible provider defaults', () => {
    expect(DEFAULT_PROVIDER_TPM['anthropic']).toBeGreaterThan(0);
    expect(DEFAULT_PROVIDER_TPM['ollama']).toBe(Number.POSITIVE_INFINITY);
  });
});
