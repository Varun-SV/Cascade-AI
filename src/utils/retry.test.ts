// ─────────────────────────────────────────────
//  Cascade AI — Retry Utility Tests
// ─────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { withRetry, withTimeout, withTimeoutAbort, CascadeToolError } from './retry.js';

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

describe('withTimeoutAbort', () => {
  it('cancels the operation instead of merely racing it', async () => {
    // withTimeout races a promise it did not create, so it cannot stop the
    // work: for a model call the request kept generating and kept billing,
    // with its usage never reported anywhere.
    let seen: AbortSignal | undefined;
    const p = withTimeoutAbort(
      (signal) => { seen = signal; return new Promise<never>(() => { /* never settles */ }); },
      10,
      'timed out',
    );
    await expect(p).rejects.toThrow('timed out');
    expect(seen?.aborted).toBe(true);
  });

  it('aborts BEFORE the rejection reaches the caller', async () => {
    // The caller's catch may start a fallback immediately; the first request
    // has to be on its way down by then, or both are in flight at once.
    let abortedWhenRejected: boolean | undefined;
    let seen: AbortSignal | undefined;
    try {
      await withTimeoutAbort(
        (signal) => { seen = signal; return new Promise<never>(() => {}); },
        10,
        'timed out',
      );
    } catch {
      abortedWhenRejected = seen?.aborted;
    }
    expect(abortedWhenRejected).toBe(true);
  });

  it('passes a live signal through and leaves it unaborted on success', async () => {
    let seen: AbortSignal | undefined;
    const value = await withTimeoutAbort(
      (signal) => { seen = signal; return Promise.resolve('ok'); },
      1_000,
      'timed out',
    );
    expect(value).toBe('ok');
    expect(seen?.aborted).toBe(false);
  });

  it('chains an outer signal, so a cancelled run aborts what is beneath it', async () => {
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    const p = withTimeoutAbort(
      (signal) => { seen = signal; return new Promise<never>(() => {}); },
      10_000,
      'timed out',
      outer.signal,
    );
    outer.abort(new Error('run cancelled'));
    expect(seen?.aborted).toBe(true);
    // The inner promise never settles on its own; the provider is what rejects
    // on abort in real use, so just assert the signal propagated.
    void p.catch(() => {});
  });

  it('returns control promptly when the outer signal aborts', async () => {
    // Aborting the inner controller is a request to the operation, not a
    // guarantee it settles — and some operations ignore a signal entirely.
    // Without racing an explicit rejection, cancelling a run left the caller
    // waiting out the full inference timeout for a call nobody wanted.
    const outer = new AbortController();
    const p = withTimeoutAbort(
      // Deliberately ignores the signal, like a provider that does not honour one.
      () => new Promise<never>(() => {}),
      60_000,
      'timed out',
      outer.signal,
    );
    outer.abort(new Error('run cancelled'));
    await expect(p).rejects.toThrow('run cancelled');
  });

  it('rejects an already-aborted outer signal without waiting for the timeout', async () => {
    const p = withTimeoutAbort(
      () => new Promise<never>(() => {}),
      60_000,
      'timed out',
      AbortSignal.abort(new Error('already gone')),
    );
    await expect(p).rejects.toThrow('already gone');
  });

  it('aborts immediately when the outer signal is already aborted', async () => {
    const outer = AbortSignal.abort(new Error('already gone'));
    let seen: AbortSignal | undefined;
    const p = withTimeoutAbort(
      (signal) => { seen = signal; return new Promise<never>(() => {}); },
      10_000,
      'timed out',
      outer,
    );
    expect(seen?.aborted).toBe(true);
    void p.catch(() => {});
  });
});
