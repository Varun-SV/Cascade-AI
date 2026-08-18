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
    // The bearer does NOT ride along. This previously asserted it did, on the
    // reasoning that a later push should still carry the gateway's own fields —
    // but that is exactly the round trip that undid the fix: the pushed bundle
    // handed the token back to a desktop pull, and anthropicAuth() prefers a
    // bearer, so the browser key this branch protected was shadowed again.
    expect((merged[0] as { authToken?: string }).authToken).toBeUndefined();
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
    expect(unusable.map((u) => u.type)).toEqual(['anthropic']);
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
    expect(unusable.map((u) => u.type)).toEqual(['anthropic']);
  });

  it('keeps a keyless openai-compatible endpoint, which is key-optional', () => {
    // The bearer quarantine keyed off "no apiKey", but keyless is not the same
    // as unusable: OpenAICompatibleProvider substitutes `not-required` when no
    // key is set, and the vault accepts a row with just a baseUrl.
    //
    // Uses a HOSTED url. This case originally used http://localhost:8000/v1,
    // which was the wrong example: keyless is fine, but a hosted run executes
    // on the cloud server, so a loopback endpoint is unreachable there whether
    // it has a key or not. That is covered separately below.
    const local: ProviderConfig[] = [];
    const incoming: ProviderConfig[] = [
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
    ];

    const { merged, unusable } = mergeProviders(local, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(unusable).toEqual([]);
  });

  it('drops a keyless ollama row — a hosted page cannot reach a local daemon', () => {
    // Previously asserted the opposite, as part of "keep every keyless row".
    // KeyVault deliberately excludes Ollama from the types a user can add here
    // for this exact reason; a restore must not put one in behind that.
    const { merged, unusable } = mergeProviders([], [{ type: 'ollama' }]);
    expect(merged).toHaveLength(0);
    expect(unusable.map((u) => u.reason)).toEqual(['local-endpoint']);
  });

  it('still quarantines a bearer-only row alongside a kept keyless one', () => {
    const incoming: ProviderConfig[] = [
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' } as ProviderConfig,
    ];

    const { merged, unusable } = mergeProviders([], incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.type).toBe('openai-compatible');
    expect(unusable.map((u) => u.type)).toEqual(['anthropic']);
  });

  it('drops a synced endpoint only the user\u2019s own machine can reach', () => {
    // A hosted run executes on the cloud server, so `localhost` resolves in the
    // SERVER's network — it cannot reach the user's box, and it may address
    // something server-local. KeyVault already refuses to let anyone create
    // such a provider here; a restore must not introduce one behind that.
    const incoming: ProviderConfig[] = [
      { type: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' },
      { type: 'openai-compatible', baseUrl: 'http://192.168.1.50:11434/v1', apiKey: 'k' },
      { type: 'ollama' },
    ];

    const { merged, unusable } = mergeProviders([], incoming);
    expect(merged).toHaveLength(0);
    expect(unusable.every((u) => u.reason === 'local-endpoint')).toBe(true);
    expect(unusable).toHaveLength(3);
  });

  it('keeps a hosted openai-compatible endpoint, keyless or not', () => {
    const { merged, unusable } = mergeProviders([], [
      { type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
    ]);
    expect(merged).toHaveLength(1);
    expect(unusable).toEqual([]);
  });

  it('strips the bearer when it preserves the local API key', () => {
    // `{ ...i, apiKey: prior.apiKey }` also carried the runtime-only authToken,
    // so the vault held both and a later PUSH sent both back. A desktop pull
    // then took that row and anthropicAuth() prefers the bearer — so the token
    // this branch refused to let displace the browser key displaced it anyway,
    // one web→native round trip later.
    const local: ProviderConfig[] = [{ type: 'anthropic', apiKey: 'good-key' }];
    const incoming: ProviderConfig[] = [
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' } as ProviderConfig,
    ];

    const { merged } = mergeProviders(local, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.apiKey).toBe('good-key');
    expect((merged[0] as { authToken?: string }).authToken).toBeUndefined();
    // …and therefore a push built from this vault cannot carry it back.
    expect(JSON.stringify(merged)).not.toContain('gw-token');
  });

  it('strips a bearer riding along on a row that has its own key', () => {
    const { merged } = mergeProviders([], [
      { type: 'anthropic', apiKey: 'sk-ant-real', authToken: 'gw-token' } as ProviderConfig,
    ]);
    expect(merged[0]?.apiKey).toBe('sk-ant-real');
    expect((merged[0] as { authToken?: string }).authToken).toBeUndefined();
  });

  it('recognises private endpoint forms the first filter missed', () => {
    // WHATWG URL.hostname serialises an IPv6 literal WITH brackets, so
    // `http://[::1]:8080` yields `[::1]` and matched nothing. Unique-local
    // (fc00::/7), link-local (fe80::/10) and a trailing DNS dot were all
    // unhandled too, so these could still be restored into a hosted vault.
    const forms = [
      'http://[::1]:8080/v1',
      'http://[fd00::1]:8080/v1',
      'http://[fe80::1]:8080/v1',
      'http://localhost./v1',
      'http://[::ffff:127.0.0.1]:8080/v1',
    ];
    for (const baseUrl of forms) {
      const { merged, unusable } = mergeProviders([], [{ type: 'openai-compatible', baseUrl, apiKey: 'k' }]);
      expect(merged, baseUrl).toHaveLength(0);
      expect(unusable.map((u) => u.reason), baseUrl).toEqual(['local-endpoint']);
    }
  });

  it('does not mistake a public IPv6 host for a private one', () => {
    const { merged, unusable } = mergeProviders([], [
      { type: 'openai-compatible', baseUrl: 'https://[2606:4700::1111]/v1', apiKey: 'k' },
    ]);
    expect(merged).toHaveLength(1);
    expect(unusable).toEqual([]);
  });

  it('drops a subscription token that arrives in apiKey', () => {
    // The browser classifier checked `authToken` only, so a row with the token
    // in the wrong field was stored and sent.
    const { merged, revoked } = mergeProviders([], [
      { type: 'anthropic', apiKey: 'sk-ant-oat01-dead' } as ProviderConfig,
    ]);
    expect(merged).toHaveLength(0);
    expect(revoked).toBe(1);
  });
});
