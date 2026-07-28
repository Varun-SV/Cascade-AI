// ─────────────────────────────────────────────
//  Cascade AI — Run breaker + provider error classification
// ─────────────────────────────────────────────
//
//  These pin the two decisions that turn a dead API key from "twelve worker
//  calls and an apology" into "three calls and a sentence you can act on":
//  whether a failure will repeat on every worker, and whether the run should
//  stop paying to confirm it.

import { describe, expect, it } from 'vitest';
import { RunBreaker, DEFAULT_FAILURE_THRESHOLD } from './run-breaker.js';
import { classifyProviderError, describeProviderError, isSystemicKind } from './router/provider-errors.js';

/** Shape an SDK error the way the vendors actually throw them. */
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe('provider error classification', () => {
  it('reads the status code ahead of the message wording', () => {
    // Every vendor words a 429 differently; the number is the reliable part.
    expect(classifyProviderError(httpError(429, 'Resource has been exhausted')).kind).toBe('rate_limit');
    expect(classifyProviderError(httpError(401, 'nope')).kind).toBe('auth');
    expect(classifyProviderError(httpError(403, 'forbidden')).kind).toBe('auth');
    expect(classifyProviderError(httpError(404, 'nope')).kind).toBe('model_unavailable');
  });

  it('splits a 429 into throttling vs a spent budget', () => {
    // Same status, opposite user action: one says slow down, the other says
    // go pay someone. Collapsing them would give the wrong advice half the time.
    expect(classifyProviderError(httpError(429, 'Too Many Requests')).kind).toBe('rate_limit');
    expect(classifyProviderError(httpError(429, 'You exceeded your current quota')).kind).toBe('quota_exhausted');
  });

  it('falls back to the message when the SDK flattened the status away', () => {
    expect(classifyProviderError(new Error('rate limit exceeded')).kind).toBe('rate_limit');
    expect(classifyProviderError(new Error('Invalid API key provided')).kind).toBe('auth');
    expect(classifyProviderError(new Error('model gemini-9-ultra does not exist')).kind).toBe('model_unavailable');
    expect(classifyProviderError(new Error('maximum context length is 8192 tokens')).kind).toBe('context_length');
    expect(classifyProviderError(new Error('blocked by the safety filter')).kind).toBe('content_filter');
    expect(classifyProviderError(new Error('fetch failed: ECONNRESET')).kind).toBe('network');
  });

  it('digs the status out of the nested shapes the SDKs use', () => {
    expect(classifyProviderError({ response: { status: 429 }, message: 'slow down' }).kind).toBe('rate_limit');
    expect(classifyProviderError({ error: { code: 403, message: 'permission denied' } }).kind).toBe('auth');
  });

  it('treats anything unrecognised as per-task, so the run still retries it', () => {
    // Being wrong this way costs one extra call. Being wrong the other way
    // would abort a healthy run over a blip.
    const c = classifyProviderError(new Error('something weird happened'));
    expect(c.kind).toBe('unknown');
    expect(c.systemic).toBe(false);
  });

  it('marks exactly the kinds that will hit every worker as systemic', () => {
    expect(isSystemicKind('rate_limit')).toBe(true);
    expect(isSystemicKind('quota_exhausted')).toBe(true);
    expect(isSystemicKind('auth')).toBe(true);
    expect(isSystemicKind('model_unavailable')).toBe(true);
    // These are properties of one subtask, not of the model.
    expect(isSystemicKind('context_length')).toBe(false);
    expect(isSystemicKind('content_filter')).toBe(false);
    expect(isSystemicKind('network')).toBe(false);
  });

  it('quotes the provider verbatim instead of paraphrasing it', () => {
    // Someone debugging a dead key needs the literal string to search for.
    const c = classifyProviderError(httpError(401, 'API key not valid. Please pass a valid API key.'));
    const msg = describeProviderError(c, 'gemini-2.0-flash');
    expect(msg).toContain('API key not valid. Please pass a valid API key.');
    expect(msg).toContain('gemini-2.0-flash');
    expect(msg).toMatch(/Settings > Providers/);
  });
});

describe('run breaker', () => {
  it('stays closed while failures are per-task, however many there are', () => {
    const b = new RunBreaker(3);
    for (let i = 0; i < 10; i++) {
      expect(b.record(new Error('blocked by the safety filter'), 'gemini-2.0-flash')).toBeNull();
    }
    expect(b.isOpen()).toBe(false);
  });

  it('opens on a streak of the same systemic failure against one model', () => {
    const b = new RunBreaker(3);
    expect(b.record(httpError(429, 'quota exceeded'), 'gemini-2.0-flash')).toBeNull();
    expect(b.record(httpError(429, 'quota exceeded'), 'gemini-2.0-flash')).toBeNull();
    const trip = b.record(httpError(429, 'quota exceeded'), 'gemini-2.0-flash');
    expect(trip).not.toBeNull();
    expect(trip!.kind).toBe('quota_exhausted');
    expect(trip!.modelId).toBe('gemini-2.0-flash');
    expect(trip!.failures).toBe(3);
    expect(b.isOpen()).toBe(true);
  });

  it('counts per model, so one dead tier does not abort a healthy one', () => {
    // This is the T1/T2-fine, T3-broken case from the bug report: the planner
    // models were answering perfectly while every worker died.
    const b = new RunBreaker(3);
    b.record(httpError(401, 'bad key'), 'gemini-2.0-flash');
    b.record(httpError(401, 'bad key'), 'gpt-4o-mini');
    b.record(httpError(401, 'bad key'), 'gemini-2.0-flash');
    expect(b.isOpen()).toBe(false);
    b.record(httpError(401, 'bad key'), 'gemini-2.0-flash');
    expect(b.isOpen()).toBe(true);
    expect(b.reason()!.modelId).toBe('gemini-2.0-flash');
  });

  it('restarts the streak when a different systemic kind appears', () => {
    // Alternating 429/404 is not three of anything, and naming one of them as
    // "the" cause would send the user to fix the wrong thing.
    const b = new RunBreaker(3);
    b.record(httpError(429, 'slow down'), 'm');
    b.record(httpError(404, 'no such model'), 'm');
    b.record(httpError(429, 'slow down'), 'm');
    expect(b.isOpen()).toBe(false);
  });

  it('resets a streak when the model proves it is reachable', () => {
    // A per-task failure is evidence the model answered — which is exactly what
    // a systemic streak claims it cannot do.
    const b = new RunBreaker(3);
    b.record(httpError(429, 'slow down'), 'm');
    b.record(httpError(429, 'slow down'), 'm');
    b.record(new Error('maximum context length is 8192 tokens'), 'm');
    b.record(httpError(429, 'slow down'), 'm');
    expect(b.isOpen()).toBe(false);
  });

  it('keeps the first reason once open, and reports it in the skip message', () => {
    const b = new RunBreaker(2);
    b.record(httpError(401, 'API key not valid'), 'gemini-2.0-flash');
    b.record(httpError(401, 'API key not valid'), 'gemini-2.0-flash');
    expect(b.isOpen()).toBe(true);
    // A later, different failure must not rewrite the diagnosis.
    expect(b.record(httpError(429, 'slow down'), 'other-model')).toBeNull();
    expect(b.reason()!.kind).toBe('auth');

    const skip = b.skipMessage();
    expect(skip).toContain('gemini-2.0-flash');
    expect(skip).toContain('API key not valid');
    // Says the work was skipped deliberately, not that it failed on its merits.
    expect(skip).toMatch(/^Skipped/);
  });

  it('defaults to a threshold low enough to save money, high enough to absorb a blip', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(3);
    const b = new RunBreaker();
    b.record(httpError(429, 'quota exceeded'), 'm');
    b.record(httpError(429, 'quota exceeded'), 'm');
    expect(b.isOpen()).toBe(false);
    b.record(httpError(429, 'quota exceeded'), 'm');
    expect(b.isOpen()).toBe(true);
  });

  it('never divides by an absent model id', () => {
    const b = new RunBreaker(2);
    b.record(httpError(401, 'bad key'), undefined);
    const trip = b.record(httpError(401, 'bad key'), undefined);
    expect(trip!.modelId).toBe('unknown-model');
  });
});
