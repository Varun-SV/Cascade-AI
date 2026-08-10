// The per-tier max-tokens knob had no upper bound anywhere on this side: the
// input was `min={1}` with no max, and the store accepted anything above zero.
// The SERVER caps it at 200_000 (TierParamSchema in cloud/server/src/runs.ts),
// so a larger value saved happily and then failed validation on EVERY message
// — with an error that did not name the field, leaving no way to connect the
// broken chat to a number three scrolls down in a settings panel.

import { describe, it, expect, beforeEach } from 'vitest';
import { tierParams, setTierParams, MAX_TIER_MAX_TOKENS } from './prefs.js';

const KEY = 'cascade-cloud-tier-params';

describe('tierParams', () => {
  beforeEach(() => { localStorage.clear(); });

  it('round-trips values within range', () => {
    setTierParams({ t1: { maxTokens: 8_000, temperature: 0.7 } });
    expect(tierParams()).toEqual({ t1: { maxTokens: 8_000, temperature: 0.7 } });
  });

  it('clamps an out-of-range value on save', () => {
    setTierParams({ t2: { maxTokens: 2_000_000 } });
    expect(tierParams().t2?.maxTokens).toBe(MAX_TIER_MAX_TOKENS);
  });

  it('heals a bad value that is ALREADY stored', () => {
    // The case that matters for anyone already broken. Their 2,000,000 is in
    // localStorage and is only ever READ — setTierParams does not run again
    // unless they reopen settings and save — so clamping the writer alone
    // would leave them failing every message after the fix shipped, and no
    // amount of redeploying the server would touch a value in their browser.
    localStorage.setItem(KEY, JSON.stringify({
      t1: { maxTokens: 2_000_000 }, t2: { maxTokens: 2_000_000 }, t3: { maxTokens: 2_000_000 },
    }));
    const p = tierParams();
    expect(p.t1?.maxTokens).toBe(MAX_TIER_MAX_TOKENS);
    expect(p.t2?.maxTokens).toBe(MAX_TIER_MAX_TOKENS);
    expect(p.t3?.maxTokens).toBe(MAX_TIER_MAX_TOKENS);
  });

  it('leaves temperature alone and still drops out-of-range ones', () => {
    localStorage.setItem(KEY, JSON.stringify({ t1: { temperature: 1.5 }, t2: { temperature: 9 } }));
    const p = tierParams();
    expect(p.t1?.temperature).toBe(1.5);
    expect(p.t2).toBeUndefined();
  });

  it('drops non-positive and non-numeric maxTokens rather than clamping them', () => {
    localStorage.setItem(KEY, JSON.stringify({ t1: { maxTokens: 0 }, t2: { maxTokens: '9000' } }));
    expect(tierParams()).toEqual({});
  });

  it('floors a fractional value, as before', () => {
    setTierParams({ t1: { maxTokens: 1024.9 } });
    expect(tierParams().t1?.maxTokens).toBe(1024);
  });

  it('returns an empty object on corrupt JSON', () => {
    localStorage.setItem(KEY, '{not json');
    expect(tierParams()).toEqual({});
  });
});
