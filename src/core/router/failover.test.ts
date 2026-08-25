// ─────────────────────────────────────────────
//  Cascade AI — FailoverManager Tests
// ─────────────────────────────────────────────

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FailoverManager } from './failover.js';
import type { ModelSelector } from './selector.js';

function makeSelector(): ModelSelector {
  return {
    markProviderUnavailable: vi.fn(),
    markProviderAvailable: vi.fn(),
    getNextFallback: vi.fn().mockReturnValue(null),
  } as unknown as ModelSelector;
}

describe('FailoverManager', () => {
  let selector: ModelSelector;
  let mgr: FailoverManager;

  beforeEach(() => {
    selector = makeSelector();
    mgr = new FailoverManager(selector);
  });

  it('reports providers as available initially', () => {
    expect(mgr.isProviderAvailable('anthropic')).toBe(true);
  });

  it('marks a provider unavailable after first failure', () => {
    mgr.recordFailure('anthropic', 'timeout');
    expect(mgr.isProviderAvailable('anthropic')).toBe(false);
    expect(selector.markProviderUnavailable).toHaveBeenCalledWith('anthropic');
  });

  it('uses 30s backoff on first failure', () => {
    vi.useFakeTimers();
    mgr.recordFailure('openai', 'connection refused');

    // Still unavailable just before retry window
    vi.advanceTimersByTime(29_999);
    expect(mgr.isProviderAvailable('openai')).toBe(false);

    // Available after retry window
    vi.advanceTimersByTime(1);
    expect(mgr.isProviderAvailable('openai')).toBe(true);
    vi.useRealTimers();
  });

  it('escalates backoff on rapid consecutive failures (window not cleared)', () => {
    // When a provider fails multiple times before the backoff window clears,
    // each recordFailure increments the step: 30s → 60s → 120s → 300s
    vi.useFakeTimers();

    mgr.recordFailure('gemini', '1st');   // failureCount=1, step=0 → 30s
    mgr.recordFailure('gemini', '2nd');   // failureCount=2, step=1 → 60s
    expect(mgr.getFailureCount('gemini')).toBe(2);

    // Not yet past 60s window
    vi.advanceTimersByTime(59_999);
    expect(mgr.isProviderAvailable('gemini')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(mgr.isProviderAvailable('gemini')).toBe(true);
    vi.useRealTimers();
  });

  it('resets to 30s backoff after a full recovery', () => {
    // Once a provider fully recovers (window clears), the next failure should
    // restart the backoff ladder from the beginning (30s), not continue from
    // where it left off.
    vi.useFakeTimers();

    mgr.recordFailure('gemini', 'overload');   // step 0 → 30s
    vi.advanceTimersByTime(30_000);            // window clears → fully recovered
    expect(mgr.isProviderAvailable('gemini')).toBe(true);

    mgr.recordFailure('gemini', 'transient');  // fresh start: failureCount=1, step=0 → 30s
    expect(mgr.getFailureCount('gemini')).toBe(1);

    vi.advanceTimersByTime(29_999);
    expect(mgr.isProviderAvailable('gemini')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(mgr.isProviderAvailable('gemini')).toBe(true);
    vi.useRealTimers();
  });

  it('increments failure count on each consecutive failure without clearing', () => {
    vi.useFakeTimers();

    mgr.recordFailure('ollama', '1st');
    expect(mgr.getFailureCount('ollama')).toBe(1);

    // Do NOT advance timers — failure window is still active
    mgr.recordFailure('ollama', '2nd');
    expect(mgr.getFailureCount('ollama')).toBe(2);

    mgr.recordFailure('ollama', '3rd');
    expect(mgr.getFailureCount('ollama')).toBe(3);

    mgr.recordFailure('ollama', '4th');
    expect(mgr.getFailureCount('ollama')).toBe(4);

    vi.useRealTimers();
  });

  it('caps backoff at 300s (step index 3)', () => {
    vi.useFakeTimers();

    // Five failures — step should cap at 3 (300s)
    for (let i = 0; i < 5; i++) {
      mgr.recordFailure('azure', `failure ${i + 1}`);
    }

    // Still unavailable just before 300s
    vi.advanceTimersByTime(299_999);
    expect(mgr.isProviderAvailable('azure')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(mgr.isProviderAvailable('azure')).toBe(true);
    vi.useRealTimers();
  });

  it('clearFailure resets the provider state and re-enables it in selector', () => {
    mgr.recordFailure('openai-compatible', 'error');
    expect(mgr.isProviderAvailable('openai-compatible')).toBe(false);

    mgr.clearFailure('openai-compatible');
    expect(mgr.isProviderAvailable('openai-compatible')).toBe(true);
    expect(mgr.getFailureCount('openai-compatible')).toBe(0);
    expect(selector.markProviderAvailable).toHaveBeenCalledWith('openai-compatible');
  });

  it('isProviderAvailable re-enables provider in selector when timeout expires', () => {
    vi.useFakeTimers();

    mgr.recordFailure('anthropic', 'rate_limit');
    expect(selector.markProviderUnavailable).toHaveBeenCalledWith('anthropic');

    // Advance past the 30s backoff window
    vi.advanceTimersByTime(30_001);
    expect(mgr.isProviderAvailable('anthropic')).toBe(true);

    // Selector should have been re-enabled
    expect(selector.markProviderAvailable).toHaveBeenCalledWith('anthropic');
    vi.useRealTimers();
  });

  it('recordSuccess clears failure state and re-enables provider immediately', () => {
    vi.useFakeTimers();

    mgr.recordFailure('openai', 'rate_limit');
    expect(mgr.isProviderAvailable('openai')).toBe(false);
    expect(mgr.getFailureCount('openai')).toBe(1);

    // A successful call clears the backoff without waiting for the window
    mgr.recordSuccess('openai');
    expect(mgr.isProviderAvailable('openai')).toBe(true);
    expect(mgr.getFailureCount('openai')).toBe(0);
    expect(selector.markProviderAvailable).toHaveBeenCalledWith('openai');

    vi.useRealTimers();
  });

  it('recordSuccess is a no-op for providers without active failures', () => {
    // Should not throw or mutate selector when provider was never failed
    expect(() => mgr.recordSuccess('gemini')).not.toThrow();
    expect(selector.markProviderAvailable).not.toHaveBeenCalled();
  });

  describe('permanent verdicts (quota exhausted / dead key)', () => {
    it('never re-enables a permanently failed provider, however long it waits', () => {
      // The whole point. A spent wallet routed through the ordinary ladder is
      // re-enabled after 30s, called, fails, backs off 60s, is re-enabled …
      // for the rest of the run. Advance well past the 300s cap: still out.
      vi.useFakeTimers();

      mgr.recordFailure('gemini', 'quota exhausted', { permanent: true });
      expect(mgr.isProviderAvailable('gemini')).toBe(false);

      vi.advanceTimersByTime(30_000);
      expect(mgr.isProviderAvailable('gemini')).toBe(false);

      vi.advanceTimersByTime(300_000);
      expect(mgr.isProviderAvailable('gemini')).toBe(false);

      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(mgr.isProviderAvailable('gemini')).toBe(false);

      // And it never quietly re-enabled the provider in the selector on the way
      // past any of those windows — the check above would still read false if
      // the verdict held here but the selector had been told otherwise.
      expect(selector.markProviderAvailable).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('is sticky — a later ordinary failure does not downgrade it to the retry ladder', () => {
      vi.useFakeTimers();

      mgr.recordFailure('openai', 'quota exhausted', { permanent: true });
      // A transient blip on the same provider afterwards (a pinned call that
      // slipped through, say). Recording it must not hand the provider back to
      // the clock.
      mgr.recordFailure('openai', 'rate limit');

      expect(mgr.isPermanentlyFailed('openai')).toBe(true);
      vi.advanceTimersByTime(600_000);
      expect(mgr.isProviderAvailable('openai')).toBe(false);
      vi.useRealTimers();
    });

    it('succeeding on a DIFFERENT provider leaves the verdict standing', () => {
      // The failover path itself: Gemini's quota dies, work moves to Azure, and
      // every subsequent Azure success calls recordSuccess('azure'). If that
      // cleared Gemini, the run would go straight back to the dead account.
      mgr.recordFailure('gemini', 'quota exhausted', { permanent: true });

      mgr.recordSuccess('azure');
      mgr.recordSuccess('azure');

      expect(mgr.isProviderAvailable('gemini')).toBe(false);
      expect(mgr.isPermanentlyFailed('gemini')).toBe(true);
    });

    it('succeeding on the provider ITSELF clears the verdict', () => {
      // A call that actually worked is evidence the quota is not spent — topped
      // up mid-run, or a separately-billed deployment reached via an explicit
      // pin. That outranks a verdict whose only claim is "time will not fix
      // this", and prevents a false lockout lasting the whole run.
      mgr.recordFailure('gemini', 'quota exhausted', { permanent: true });
      expect(mgr.isProviderAvailable('gemini')).toBe(false);

      mgr.recordSuccess('gemini');

      expect(mgr.isProviderAvailable('gemini')).toBe(true);
      expect(mgr.isPermanentlyFailed('gemini')).toBe(false);
      expect(selector.markProviderAvailable).toHaveBeenCalledWith('gemini');
    });

    it('clearFailure lifts it too, so the user can act without restarting', () => {
      mgr.recordFailure('anthropic', 'authentication failed', { permanent: true });
      expect(mgr.isProviderAvailable('anthropic')).toBe(false);

      mgr.clearFailure('anthropic');

      expect(mgr.isProviderAvailable('anthropic')).toBe(true);
      expect(mgr.isPermanentlyFailed('anthropic')).toBe(false);
    });

    it('reports no retry countdown, because there is no retry', () => {
      mgr.recordFailure('gemini', 'quota exhausted', { permanent: true });
      const report = mgr.getFailureReport();
      expect(report['gemini']).toMatch(/Not retrying this run/);
      expect(report['gemini']).not.toMatch(/Retry in/);
    });

    it('leaves ordinary failures on the retry ladder', () => {
      // Guard against the fix over-reaching: a 429 must still recover on its
      // own, which is the behaviour the ladder exists for.
      vi.useFakeTimers();

      mgr.recordFailure('openai', 'rate limit');
      expect(mgr.isPermanentlyFailed('openai')).toBe(false);

      vi.advanceTimersByTime(30_001);
      expect(mgr.isProviderAvailable('openai')).toBe(true);
      vi.useRealTimers();
    });

    it('clearPermanentVerdicts hands the provider back at a run boundary', () => {
      // "Run-scoped" has to be enforced by something. The router and this
      // manager outlive one run() in the REPL and the desktop app, so without
      // a clear at the boundary a verdict lasts the whole PROCESS — and a user
      // who tops up their account stays routed around the provider until they
      // restart, which is the exact failure a persisted TTL was rejected for.
      mgr.recordFailure('gemini', 'quota exhausted', { permanent: true });
      expect(mgr.isProviderAvailable('gemini')).toBe(false);

      mgr.clearPermanentVerdicts();

      expect(mgr.isProviderAvailable('gemini')).toBe(true);
      expect(mgr.isPermanentlyFailed('gemini')).toBe(false);
      expect(selector.markProviderAvailable).toHaveBeenCalledWith('gemini');
    });

    it('a run boundary leaves the transient backoff ladder alone', () => {
      // The ladder is keyed to wall-clock time and stays correct across runs.
      // Clearing it here would send the next run straight back into a provider
      // that is still throttling.
      vi.useFakeTimers();
      mgr.recordFailure('openai', 'rate limit');

      mgr.clearPermanentVerdicts();

      expect(mgr.isProviderAvailable('openai')).toBe(false);
      vi.advanceTimersByTime(30_001);
      expect(mgr.isProviderAvailable('openai')).toBe(true);
      vi.useRealTimers();
    });

    it('carries the full explanation, so a refused call can say what happened', () => {
      mgr.recordFailure('gemini', 'quota exhausted', {
        permanent: true,
        detail: 'Quota or billing limit reached on gemini-2.5-flash. This will not recover on its own.',
      });

      expect(mgr.permanentReason('gemini')).toMatch(/will not recover on its own/);
      // The short label is what the failure report shows, not the long text.
      expect(mgr.getFailureReport()['gemini']).toMatch(/quota exhausted/);
    });

    it('keeps the FIRST explanation when a vaguer failure follows', () => {
      mgr.recordFailure('gemini', 'quota exhausted', { permanent: true, detail: 'the useful one' });
      mgr.recordFailure('gemini', 'rate limit');

      expect(mgr.permanentReason('gemini')).toBe('the useful one');
    });

    it('permanentReason is null for a provider on the ordinary ladder', () => {
      mgr.recordFailure('openai', 'rate limit');
      expect(mgr.permanentReason('openai')).toBeNull();
    });

    it('isPermanentlyFailed is false for a provider that never failed', () => {
      expect(mgr.isPermanentlyFailed('ollama')).toBe(false);
    });
  });

  it('getFailureReport includes failure count and retry countdown', () => {
    vi.useFakeTimers();
    mgr.recordFailure('anthropic', 'rate limited');
    const report = mgr.getFailureReport();
    expect(report['anthropic']).toMatch(/\(1x\)/);
    expect(report['anthropic']).toMatch(/Retry in/);
    vi.useRealTimers();
  });
});
