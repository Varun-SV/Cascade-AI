import { describe, it, expect, beforeEach } from 'vitest';
import { loadKeys, saveKeys } from './store.js';
import type { ProviderConfig } from '../lib/types.js';

describe('keys/store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty array when nothing is stored', () => {
    expect(loadKeys()).toEqual([]);
  });

  it('round-trips provider configs through localStorage', () => {
    const keys: ProviderConfig[] = [
      { type: 'anthropic', apiKey: 'sk-ant-x' },
      { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1' },
    ];
    saveKeys(keys);
    expect(loadKeys()).toEqual(keys);
  });

  it('falls back to an empty array on corrupt JSON', () => {
    localStorage.setItem('cascade-cloud-keys', '{not valid json');
    expect(loadKeys()).toEqual([]);
  });

  it('falls back to an empty array when the stored value is not an array', () => {
    localStorage.setItem('cascade-cloud-keys', JSON.stringify({ type: 'anthropic' }));
    expect(loadKeys()).toEqual([]);
  });
});
