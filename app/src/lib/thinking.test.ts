import { describe, expect, it } from 'vitest';
import { loadThinkingLevel, saveThinkingLevel, thinkingField, thinkingUnavailable } from './thinking.js';

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}

describe('the desktop thinking level', () => {
  it('is auto until chosen, keeps a chosen level, and stores nothing for auto', () => {
    const s = memoryStore();
    expect(loadThinkingLevel(s)).toBe('auto');
    saveThinkingLevel('high', s);
    expect(loadThinkingLevel(s)).toBe('high');
    saveThinkingLevel('auto', s);
    expect(s.m.size).toBe(0);
  });

  it('reads anything unknown as auto', () => {
    const s = memoryStore();
    s.setItem('cascade.desktop.thinkingLevel', 'max');
    expect(loadThinkingLevel(s)).toBe('auto');
    expect(loadThinkingLevel(null)).toBe('auto');
  });

  it('is unavailable only when every provider is an Azure deployment', () => {
    expect(thinkingUnavailable(['azure'])).toBe(true);
    expect(thinkingUnavailable(['azure', 'anthropic'])).toBe(false);
    expect(thinkingUnavailable([])).toBe(false);
    expect(thinkingUnavailable(undefined)).toBe(false);
  });

  it('goes in the run payload only when it would do something', () => {
    expect(thinkingField('medium', false)).toEqual({ thinking: 'medium' });
    expect(thinkingField('auto', false)).toEqual({});
    expect(thinkingField('high', true)).toEqual({});
  });
});
