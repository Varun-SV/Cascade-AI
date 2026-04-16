// ─────────────────────────────────────────────
//  Cascade AI — Retry Utility Tests
// ─────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { withRetry, withTimeout, CascadeToolError } from './retry.js';

// ── withRetry ─────────────────────────────────

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('econnreset'))
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { baseDelayMs: 0, jitter: false });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('rate limit exceeded'));

    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 0, jitter: false }),
    ).rejects.toThrow('rate limit exceeded');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('validation failed'));

    await expect(
      withRetry(fn, { baseDelayMs: 0 }),
    ).rejects.toThrow('validation failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects custom isRetryable predicate', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('custom retryable'))
      .mockResolvedValue('done');

    const result = await withRetry(fn, {
      baseDelayMs: 0,
      jitter: false,
      isRetryable: (e) => e.message.includes('custom retryable'),
    });

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable CascadeToolError', async () => {
    const fn = vi.fn().mockRejectedValue(
      new CascadeToolError('permission denied', new Error('403'), false),
    );

    await expect(withRetry(fn, { baseDelayMs: 0 })).rejects.toThrow('permission denied');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable CascadeToolError', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new CascadeToolError('rate limit', new Error('429'), true))
      .mockResolvedValue('success');

    const result = await withRetry(fn, { baseDelayMs: 0, jitter: false });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fires onRetry callback with attempt and delay', async () => {
    const retries: Array<{ attempt: number; delay: number }> = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue('ok');

    await withRetry(fn, {
      baseDelayMs: 0,
      jitter: false,
      onRetry: (attempt, _err, delay) => retries.push({ attempt, delay }),
    });

    expect(retries).toHaveLength(1);
    expect(retries[0]!.attempt).toBe(1);
  });

  it('caps delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('502'))
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue('ok');

    await withRetry(fn, {
      baseDelayMs: 10_000,
      maxDelayMs: 500,
      jitter: false,
      maxAttempts: 3,
      onRetry: (_a, _e, delay) => delays.push(delay),
    });

    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(500);
    }
  });
});

// ── withTimeout ───────────────────────────────

describe('withTimeout', () => {
  it('resolves when the promise completes in time', async () => {
    const p = Promise.resolve('fast');
    const result = await withTimeout(p, 1_000);
    expect(result).toBe('fast');
  });

  it('rejects with timeout error when promise is too slow', async () => {
    const neverResolves = new Promise<never>(() => {/* intentionally pending */});

    await expect(
      withTimeout(neverResolves, 10, 'custom timeout message'),
    ).rejects.toThrow('custom timeout message');
  });

  it('propagates rejection from the original promise', async () => {
    const failing = Promise.reject(new Error('original error'));
    await expect(withTimeout(failing, 1_000)).rejects.toThrow('original error');
  });
});
