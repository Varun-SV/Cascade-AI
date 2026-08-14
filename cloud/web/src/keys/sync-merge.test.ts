import { describe, expect, it } from 'vitest';
import { mergeProviders } from './AccountSyncPanel.js';
import type { ProviderConfig } from '../lib/types.js';

// The merge itself, not just the filter it calls. The browser has its own merge
// path — the SDK's applySyncBundle never runs here — so the filtering has to be
// proven at THIS call site or the surface stays uncovered.
describe('browser sync merge', () => {
  it('does not let a revoked incoming row replace a working local key', () => {
    const local: ProviderConfig[] = [{ type: 'anthropic', apiKey: 'sk-ant-local-good' }];
    // Same providerSig ('anthropic' with no baseUrl/deployment/label), so the
    // incoming row would win the collision outright.
    const incoming = [{ type: 'anthropic', authToken: 'sk-ant-oat01-dead' }] as unknown as ProviderConfig[];

    const { merged, revoked } = mergeProviders(local, incoming);
    expect(revoked).toBe(1);
    expect(merged).toEqual([{ type: 'anthropic', apiKey: 'sk-ant-local-good' }]);
  });

  it('takes the replacement key when the incoming row carries one', () => {
    const local: ProviderConfig[] = [{ type: 'anthropic', apiKey: 'sk-ant-old' }];
    const incoming = [
      { type: 'anthropic', authToken: 'sk-ant-oat01-dead', apiKey: 'sk-ant-new' },
    ] as unknown as ProviderConfig[];

    const { merged, revoked } = mergeProviders(local, incoming);
    expect(revoked).toBe(1);
    expect(merged).toEqual([{ type: 'anthropic', apiKey: 'sk-ant-new' }]);
  });

  it('still merges an ordinary bundle and keeps local-only entries', () => {
    const local: ProviderConfig[] = [{ type: 'openai', apiKey: 'sk-o' }];
    const incoming: ProviderConfig[] = [{ type: 'anthropic', apiKey: 'sk-a' }];

    const { merged, revoked, removed } = mergeProviders(local, incoming);
    expect(revoked).toBe(0);
    expect(removed).toEqual([]);
    expect(merged).toHaveLength(2);
  });
});
