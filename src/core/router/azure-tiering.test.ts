import { describe, it, expect } from 'vitest';
import { inferModelCapability, azureModelForTier } from './index.js';

describe('inferModelCapability', () => {
  it('ranks a full model above its mini sibling', () => {
    // The reported case: gpt-5.4 deployments should outrank gpt-5-mini.
    expect(inferModelCapability('gpt-5.4')).toBeGreaterThan(inferModelCapability('gpt-5-mini'));
    expect(inferModelCapability('gpt-5')).toBeGreaterThan(inferModelCapability('gpt-5-mini'));
  });

  it('orders by version and size keywords', () => {
    expect(inferModelCapability('gpt-5.4')).toBeGreaterThan(inferModelCapability('gpt-4o'));
    expect(inferModelCapability('gpt-4o')).toBeGreaterThan(inferModelCapability('gpt-35-turbo'));
    expect(inferModelCapability('my-pro-deploy')).toBeGreaterThan(inferModelCapability('my-mini-deploy'));
  });
});

describe('azureModelForTier', () => {
  const ranked = ['strong', 'mid', 'weak']; // capability-descending

  it('assigns strongest to T1, cheapest to T3, middle to T2', () => {
    expect(azureModelForTier('T1', ranked)).toBe('strong');
    expect(azureModelForTier('T2', ranked)).toBe('mid');
    expect(azureModelForTier('T3', ranked)).toBe('weak');
  });

  it('reuses neighbours when fewer than three deployments', () => {
    expect(azureModelForTier('T1', ['a', 'b'])).toBe('a');
    expect(azureModelForTier('T2', ['a', 'b'])).toBe('b');
    expect(azureModelForTier('T3', ['a', 'b'])).toBe('b');
    expect(azureModelForTier('T1', ['only'])).toBe('only');
    expect(azureModelForTier('T3', ['only'])).toBe('only');
    expect(azureModelForTier('T2', [])).toBeUndefined();
  });
});
