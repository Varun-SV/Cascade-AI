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

  it('does not let a gateway bearer take away the browser\'s API key', () => {
    // A legitimate gateway authToken is NOT revoked, so it survives the filter
    // and the incoming row wins the collision — but the browser can only use
    // `apiKey`, and the restored value is persisted, so the local key would be
    // gone for good and the next chat would have no credential.
    const local: ProviderConfig[] = [{ type: 'anthropic', apiKey: 'sk-ant-browser' }];
    const incoming = [
      { type: 'anthropic', authToken: 'gw-token' },
    ] as unknown as ProviderConfig[];

    const { merged, revoked } = mergeProviders(local, incoming);
    expect(revoked).toBe(0);                                   // nothing was revoked
    expect(merged[0]?.apiKey).toBe('sk-ant-browser');          // the usable key survives
    // …and the gateway's own fields ride along, so a later push still carries them.
    expect((merged[0] as { authToken?: string }).authToken).toBe('gw-token');
  });

  it('lets an incoming API key replace the local one, as a sync should', () => {
    const local: ProviderConfig[] = [{ type: 'anthropic', apiKey: 'sk-ant-old' }];
    const incoming: ProviderConfig[] = [{ type: 'anthropic', apiKey: 'sk-ant-new' }];
    expect(mergeProviders(local, incoming).merged[0]?.apiKey).toBe('sk-ant-new');
  });

  it('still merges an ordinary bundle and keeps local-only entries', () => {
    const local: ProviderConfig[] = [{ type: 'openai', apiKey: 'sk-o' }];
    const incoming: ProviderConfig[] = [{ type: 'anthropic', apiKey: 'sk-a' }];

    const { merged, revoked, removed } = mergeProviders(local, incoming);
    expect(revoked).toBe(0);
    expect(removed).toEqual([]);
    expect(merged).toHaveLength(2);
  });

  it('drops a bearer-only row when the vault has nothing to fall back on', () => {
    // The empty-vault pull: a legitimate desktop/CLI gateway row arrives, there
    // is no local key to keep, so the row entered the vault with no credential
    // the browser can send. KeyVault then showed it as a configured provider
    // and useChatSession put it in `providers`, where the hosted
    // ChatRunPayloadSchema — which has no `authToken` field — stripped the
    // bearer and the server got a keyless Anthropic provider. The restore
    // reported success for something that could not run.
    const local: ProviderConfig[] = [];
    const incoming: ProviderConfig[] = [
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' } as ProviderConfig,
    ];

    const { merged, unusable } = mergeProviders(local, incoming);
    expect(merged).toHaveLength(0);
    expect(unusable).toEqual(['anthropic']);
  });

  it('keeps a bearer row that also carries a usable API key', () => {
    // Only the UNUSABLE case is dropped. A row the browser can actually send
    // is kept whole, bearer and all, so a later push still carries it.
    const local: ProviderConfig[] = [];
    const incoming: ProviderConfig[] = [
      { type: 'anthropic', apiKey: 'sk-ant-real', authToken: 'gw-token' } as ProviderConfig,
    ];

    const { merged, unusable } = mergeProviders(local, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.apiKey).toBe('sk-ant-real');
    expect(unusable).toEqual([]);
  });

  it('does not drop an unrelated local provider when one incoming row is unusable', () => {
    const local: ProviderConfig[] = [{ type: 'openai', apiKey: 'sk-o' }];
    const incoming: ProviderConfig[] = [
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' } as ProviderConfig,
    ];

    const { merged, unusable } = mergeProviders(local, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.type).toBe('openai');
    expect(unusable).toEqual(['anthropic']);
  });
});
