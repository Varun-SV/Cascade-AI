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

  it('getFailureReport includes failure count and retry countdown', () => {
    vi.useFakeTimers();
    mgr.recordFailure('anthropic', 'rate limited');
    const report = mgr.getFailureReport();
    expect(report['anthropic']).toMatch(/\(1x\)/);
    expect(report['anthropic']).toMatch(/Retry in/);
    vi.useRealTimers();
  });
});
