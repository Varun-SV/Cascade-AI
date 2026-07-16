import { describe, expect, it } from 'vitest';
import { applyTierLimits } from './index.js';
import type { GenerateOptions } from '../../types.js';

const base = (): GenerateOptions => ({ messages: [{ role: 'user', content: 'hi' }] });

describe('applyTierLimits', () => {
  it('returns options unchanged when there are no limits', () => {
    const opts = base();
    expect(applyTierLimits(opts, 'T2', undefined)).toBe(opts);
    expect(applyTierLimits(opts, 'T2', {})).toBe(opts);
  });

  it('fills in a per-tier maxTokens when the call left it unset', () => {
    const out = applyTierLimits(base(), 'T3', { t3MaxTokens: 512 });
    expect(out.maxTokens).toBe(512);
  });

  it('treats maxTokens as a ceiling — lowers a larger request, never raises a smaller one', () => {
    expect(applyTierLimits({ ...base(), maxTokens: 4000 }, 'T1', { t1MaxTokens: 1000 }).maxTokens).toBe(1000);
    // A smaller explicit request is kept (not raised to the limit).
    expect(applyTierLimits({ ...base(), maxTokens: 200 }, 'T1', { t1MaxTokens: 1000 }).maxTokens).toBe(200);
  });

  it('applies a per-tier temperature only when the call did not set one', () => {
    expect(applyTierLimits(base(), 'T2', { t2Temperature: 0.7 }).temperature).toBe(0.7);
    // An explicit temperature (e.g. a deterministic temperature: 0 call) is preserved.
    expect(applyTierLimits({ ...base(), temperature: 0 }, 'T2', { t2Temperature: 0.7 }).temperature).toBe(0);
  });

  it('scopes limits to the matching tier only', () => {
    const out = applyTierLimits(base(), 'T3', { t1MaxTokens: 100, t1Temperature: 0.1, t3Temperature: 0.9 });
    expect(out.maxTokens).toBeUndefined();
    expect(out.temperature).toBe(0.9);
  });

  it('ignores a zero/negative maxTokens limit', () => {
    expect(applyTierLimits(base(), 'T2', { t2MaxTokens: 0 }).maxTokens).toBeUndefined();
  });
});
