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

  it('strips a stored subscription token already in the vault', () => {
    // Before 0.75 the browser merge stored incoming rows verbatim, so a desktop
    // bundle could put this straight into localStorage. Cleaning only on the
    // next account pull left it being sent in every chat:run until the user
    // happened to sync again — which many never will.
    localStorage.setItem('cascade-cloud-keys', JSON.stringify([
      { type: 'anthropic', authToken: 'sk-ant-oat01-dead' },
      { type: 'openai', apiKey: 'sk-o' },
    ]));

    const loaded = loadKeys();
    expect(loaded).toEqual([{ type: 'openai', apiKey: 'sk-o' }]);
    expect(localStorage.getItem('cascade-cloud-keys')).not.toContain('sk-ant-oat01-dead');
  });

  it('drops a stored bearer-only row and persists the cleaned vault', () => {
    localStorage.setItem('cascade-cloud-keys', JSON.stringify([
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' },
    ]));

    expect(loadKeys()).toEqual([]);
    expect(localStorage.getItem('cascade-cloud-keys')).not.toContain('gw-token');
  });

  it('strips a bearer from a row that also has a usable key, and persists that', () => {
    // The row stays — it works here — but the token must not survive to be
    // pushed back, where a native pull would prefer it over the key.
    localStorage.setItem('cascade-cloud-keys', JSON.stringify([
      { type: 'anthropic', apiKey: 'sk-ant-real', authToken: 'gw-token' },
    ]));

    expect(loadKeys()).toEqual([{ type: 'anthropic', apiKey: 'sk-ant-real' }]);
    expect(localStorage.getItem('cascade-cloud-keys')).not.toContain('gw-token');
  });

  it('leaves a locally-addressed endpoint the user typed alone', () => {
    // KeyVault does not validate the URL field, so this is a row the user may
    // have entered themselves. The RESTORE path refuses to introduce one; a
    // migration that deleted it on the next page load would be data loss.
    const row = { type: 'openai-compatible' as const, baseUrl: 'http://localhost:8000/v1' };
    localStorage.setItem('cascade-cloud-keys', JSON.stringify([row]));
    expect(loadKeys()).toEqual([row]);
  });
});
