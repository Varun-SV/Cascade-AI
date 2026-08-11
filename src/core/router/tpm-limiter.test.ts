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

describe('cancellation', () => {
  it('stops waiting when the signal aborts, instead of sitting out the refill', async () => {
    // A caller can be held here for most of a refill interval. When the run
    // that was waiting has already been cancelled or has spent its budget,
    // waiting out the window admits a call that is thrown away immediately.
    const limiter = new TpmLimiter({ anthropic: 1_000 });
    await limiter.acquire('anthropic', 1_000);          // drain the bucket

    const ac = new AbortController();
    const blocked = limiter.acquire('anthropic', 1_000, ac.signal);
    ac.abort(new Error('run budget spent'));
    await expect(blocked).rejects.toThrow('run budget spent');
  });

  it('refuses immediately when the signal is already aborted', async () => {
    const limiter = new TpmLimiter({ anthropic: 1_000 });
    await expect(limiter.acquire('anthropic', 10, AbortSignal.abort(new Error('gone'))))
      .rejects.toThrow('gone');
  });

  it('is unaffected when no signal is supplied', async () => {
    const limiter = new TpmLimiter({ anthropic: 1_000 });
    await expect(limiter.acquire('anthropic', 10)).resolves.toBeUndefined();
  });
});
