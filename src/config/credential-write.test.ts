import { describe, expect, it } from 'vitest';
import {
  applyEndpointEdit, applyProviderCredential, applySettingsCredentials,
  credentialDispositionForEdit, endpointFromSettingsPayload,
} from './credential-write.js';
import { priorAzureRow } from './settings-payload.js';

describe('credentialDispositionForEdit', () => {
  it('keeps the key when the endpoint has not moved', () => {
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.groq.com/openai/v1/',
      undefined,
    )).toBe('keep');
  });

  it('drops the key when the host changes and no replacement was typed', () => {
    // The reported shape: `{ baseUrl: Groq, apiKey: groqKey }` edited to another
    // host became `{ baseUrl: otherHost, apiKey: groqKey }`, because a blank key
    // field means "keep the existing key" and the two fields were handled
    // independently.
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.deepseek.com/v1',
      undefined,
    )).toBe('clear');
  });

  it('drops the key when the endpoint is cleared', () => {
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' }, '', undefined,
    )).toBe('clear');
  });

  it('reports a typed key as a REPLACEMENT, never as a clear', () => {
    // This returned `false` — the same value as "clear" — and the caller
    // deleted the credential on `false`. So a save carrying a new key and a new
    // endpoint installed the key and immediately removed it.
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.deepseek.com/v1',
      'new-key',
    )).toBe('replaced');
    // …and likewise when the endpoint did not move at all.
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.groq.com/openai/v1',
      'new-key',
    )).toBe('replaced');
  });

  it('retires a public-host key when a gateway is typed in beside it', () => {
    // This previously asserted 'keep', on the reasoning that a row with no
    // baseUrl "is not endpoint-scoped". It is: for anthropic/openai/gemini a
    // missing baseUrl means the provider's own PUBLIC host, which is where the
    // client sends. Keeping the key while writing in a corporate gateway sent a
    // console.anthropic.com key to that gateway on the next request.
    expect(credentialDispositionForEdit(
      { type: 'anthropic' }, 'https://corp-gateway.example', undefined,
    )).toBe('clear');
  });

  it('keeps a key when the edit does not change where requests go', () => {
    // Anthropic's optional /v1 suffix names the same API root — anthropicApiRoot()
    // says so and its tests assert it — so this edit must not retire anything.
    expect(credentialDispositionForEdit(
      { type: 'anthropic', baseUrl: 'https://gw.example' },
      'https://gw.example/v1',
      undefined,
    )).toBe('keep');
    // …and writing the public host explicitly over an implicit one is a no-op.
    expect(credentialDispositionForEdit(
      { type: 'anthropic' }, 'https://api.anthropic.com', undefined,
    )).toBe('keep');
  });

  it('retires a key when an endpoint appears on a type with no default', () => {
    // openai-compatible has no canonical host, so "none → some" is still a host
    // being introduced where the credential was not scoped to one.
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible' }, 'https://openrouter.ai/api/v1', undefined,
    )).toBe('clear');
  });
});

describe('applySettingsCredentials — the real save sequence', () => {
  // The unit above is not enough on its own: the defect was in how the two
  // halves compose, and the composition lived inside `ipcMain.handle` where no
  // test could reach it.

  it('keeps a key and endpoint saved together', () => {
    // The reported P1: typing a new key alongside a new endpoint wrote the key
    // and then deleted it, so Settings appeared to discard what the user typed.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': 'new-key' },
      endpoints: { 'openai-compatible': 'https://api.deepseek.com/v1' },
    });

    expect(providers[0]).toMatchObject({ apiKey: 'new-key', baseUrl: 'https://api.deepseek.com/v1' });
  });

  it('keeps a key saved with no endpoint change at all', () => {
    const providers = [{ type: 'openai-compatible', apiKey: 'old', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': 'new-key' },
      endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1' },
    });

    expect(providers[0]?.apiKey).toBe('new-key');
  });

  it('still retires a key when the host moves and nothing was typed', () => {
    // The behaviour the disposition exists to preserve.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      endpoints: { 'openai-compatible': 'https://api.deepseek.com/v1' },
    });

    expect(providers[0]?.apiKey).toBeUndefined();
    expect(providers[0]?.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('leaves a blank key field meaning "keep it" when the host is unchanged', () => {
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': '' },
      endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1/' },
    });

    expect(providers[0]?.apiKey).toBe('groq-key');
  });

  it('creates a row for an endpoint typed against a provider with none', () => {
    const providers: Array<{ type: string; apiKey?: string; baseUrl?: string }> = [];
    applySettingsCredentials(providers, { endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1' } });
    expect(providers).toEqual([{ type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' }]);
  });

  it('refuses a key the payload gives no way to scope, and says so', () => {
    // The payload a panel WITHOUT gateway fields sends: no `anthropic` entry in
    // `endpoints` at all. Cascade cannot tell whether the new key belongs to
    // the stored gateway or to Anthropic, so it stores neither answer — and the
    // refusal is returned rather than swallowed, because a key that was typed
    // and not saved must not look like one that was.
    const providers = [{ type: 'anthropic', apiKey: 'old-gateway-key', baseUrl: 'https://corp-gateway.example' }];
    const result = applySettingsCredentials(providers, {
      keys: { anthropic: 'unknown-scope-key', openai: undefined, gemini: undefined, 'openai-compatible': undefined },
      endpoints: { 'openai-compatible': undefined, ollama: undefined },
    });

    expect(result.refused).toEqual([{ type: 'anthropic', reason: 'ambiguous-scope' }]);
    expect(providers[0]).toMatchObject({ apiKey: 'old-gateway-key', baseUrl: 'https://corp-gateway.example' });
  });

  it('saves the rotated gateway key once the payload can name the gateway', () => {
    // The same rotation through a panel that HAS the field — which is why the
    // field was added. The ambiguity is gone, so nothing has to be guessed or
    // refused.
    const providers = [{ type: 'anthropic', apiKey: 'old-gateway-key', baseUrl: 'https://corp-gateway.example' }];
    const result = applySettingsCredentials(providers, {
      keys: { anthropic: 'rotated-gateway-key' },
      endpoints: { anthropic: 'https://corp-gateway.example', 'openai-compatible': undefined, ollama: undefined },
    });

    expect(result.refused).toEqual([]);
    expect(providers[0]).toMatchObject({
      apiKey: 'rotated-gateway-key',
      baseUrl: 'https://corp-gateway.example',
    });
  });

  it('DOES retire the gateway when the surface has the field and it was left blank', () => {
    // The other half of the same rule, and the reason intent is declared rather
    // than inferred: an empty field the user was actually shown IS a claim.
    const providers = [{ type: 'anthropic', apiKey: 'old-gateway-key', baseUrl: 'https://corp-gateway.example' }];
    applySettingsCredentials(providers, {
      keys: { anthropic: 'sk-ant-public' },
      endpoints: { anthropic: undefined },
    });

    expect(providers[0]?.apiKey).toBe('sk-ant-public');
    expect(providers[0]?.baseUrl).toBeUndefined();
  });

  it('leaves an untouched provider alone when another provider is re-keyed', () => {
    const providers = [
      { type: 'anthropic', apiKey: 'old', baseUrl: 'https://corp-gateway.example' },
      { type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' },
    ];
    applySettingsCredentials(providers, {
      keys: { anthropic: 'rotated' },
      endpoints: { anthropic: 'https://corp-gateway.example', 'openai-compatible': 'https://api.groq.com/openai/v1', ollama: undefined },
    });

    expect(providers[0]).toMatchObject({ apiKey: 'rotated', baseUrl: 'https://corp-gateway.example' });
    expect(providers[1]).toMatchObject({ apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' });
  });

  it('treats a present-but-undefined endpoint as the explicit clear it is', () => {
    // The Settings payload represents a CLEARED OpenAI-compatible URL as the
    // property being present with value `undefined` — `ocUrl.trim() ||
    // undefined`. Skipping those entries meant emptying the URL with the key
    // box left blank changed nothing: the keys loop skipped the blank key and
    // the endpoint loop skipped the blank URL, so the stale host kept its
    // credential. `openai-compatible` has no public host to fall back to, so
    // the pair is retired together.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': undefined },
      endpoints: { 'openai-compatible': undefined, ollama: undefined },
    });

    expect(providers[0]?.baseUrl).toBeUndefined();
    expect(providers[0]?.apiKey).toBeUndefined();
  });

  it('does not read an ABSENT endpoint property as a clear', () => {
    // The other side of the same distinction: a surface with no field for this
    // provider sends no entry, and that must leave the row alone.
    const providers = [{ type: 'anthropic', apiKey: 'gw-key', baseUrl: 'https://corp-gateway.example' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': undefined },
      endpoints: { 'openai-compatible': undefined, ollama: undefined },
    });

    expect(providers[0]).toMatchObject({ apiKey: 'gw-key', baseUrl: 'https://corp-gateway.example' });
  });

  it('clears an Anthropic gateway when its field is emptied, retiring the key with it', () => {
    const providers = [{ type: 'anthropic', apiKey: 'gw-key', baseUrl: 'https://corp-gateway.example' }];
    applySettingsCredentials(providers, {
      keys: {},
      endpoints: { anthropic: undefined },
    });

    expect(providers[0]?.baseUrl).toBeUndefined();
    expect(providers[0]?.apiKey).toBeUndefined();
  });

  it('applies an endpoint-only edit, which the dashboard used to drop on the floor', () => {
    // Key field blank, URL changed. The live backend ran a key-only loop, so it
    // persisted a config in which nothing had moved while telling the user the
    // save succeeded — and never retired the old host's key.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': undefined },
      endpoints: { 'openai-compatible': 'https://api.deepseek.com/v1', ollama: undefined },
    });

    expect(providers[0]?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(providers[0]?.apiKey).toBeUndefined();
  });

  it('drops `local` when the Settings payload moves a self-hosted endpoint', () => {
    // Through the real save, not just the helper: this is the shape the panel
    // sends when someone points an OpenAI-compatible row at a hosted service.
    const providers = [{
      type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://localhost:8000/v1', local: true,
    }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': 'groq-key' },
      endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1', ollama: undefined },
    });

    expect(providers[0]?.local).toBeUndefined();
    expect(providers[0]).toMatchObject({ apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' });
  });

  it('never touches azure, which has its own field', () => {
    const providers = [{ type: 'azure', apiKey: 'az', baseUrl: 'https://r1.openai.azure.com' }];
    applySettingsCredentials(providers, { endpoints: { azure: 'https://r2.openai.azure.com' } });
    expect(providers[0]).toMatchObject({ apiKey: 'az', baseUrl: 'https://r1.openai.azure.com' });
  });

});

describe('applyEndpointEdit — shared by both desktop save paths', () => {
  // `cascade:setConfig`, the key-optional onboarding save, wrote an endpoint
  // through its own branch and bypassed applySettingsCredentials entirely — so
  // an OpenAI-compatible row could have its endpoint changed with a blank key
  // and keep the previous host's key attached.
  it('clears the key when onboarding repoints a compatible provider', () => {
    const row = {
      type: 'openai-compatible',
      apiKey: 'openrouter-key',
      baseUrl: 'https://openrouter.ai/api/v1',
    };
    applyEndpointEdit(row, 'https://api.groq.com/openai/v1', undefined);

    expect(row.apiKey).toBeUndefined();
    expect(row.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('keeps the key when onboarding supplies one with the endpoint', () => {
    const row = { type: 'openai-compatible', apiKey: 'old', baseUrl: 'https://openrouter.ai/api/v1' };
    applyEndpointEdit(row, 'https://api.groq.com/openai/v1', 'groq-key');
    // The caller writes the replacement; this must not delete it.
    expect(row.apiKey).toBe('old');
    expect(row.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('drops `local` when a self-hosted endpoint becomes a paid one', () => {
    // `local` is a statement about the endpoint being replaced, and
    // `isLocalEndpoint()` gives it precedence over the URL — so carrying it
    // across priced every model discovered at the new host at zero and slipped
    // the budget caps entirely. `cascade link` has dropped it since the same
    // defect was found there; this helper's parameter type did not even
    // include the field.
    const row = { type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://localhost:8000/v1', local: true };
    applyEndpointEdit(row, 'https://api.groq.com/openai/v1', 'groq-key');

    expect(row.local).toBeUndefined();
    expect(row.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('keeps `local` when the endpoint has not actually moved', () => {
    // An explicit `local` is a user statement about THIS host — a self-hosted
    // box on a public-looking domain, say. Re-saving the same URL must not
    // silently discard it.
    const row = { type: 'openai-compatible', apiKey: 'k', baseUrl: 'https://llm.internal.example/v1', local: true };
    applyEndpointEdit(row, 'https://llm.internal.example/v1/', undefined);

    expect(row.local).toBe(true);
  });
});

describe('endpointFromSettingsPayload — presence of the KEY is the signal', () => {
  // The two absences this whole module exists to tell apart. Both send no URL;
  // one is a claim and the other is silence, and only the payload's shape says
  // which — a surface that can address a provider's endpoint sends an entry for
  // it even when the field is blank.
  it('reads a missing entry as "this surface has no field"', () => {
    expect(endpointFromSettingsPayload({ 'openai-compatible': 'https://x' }, 'anthropic'))
      .toEqual({ kind: 'preserve' });
    expect(endpointFromSettingsPayload(undefined, 'anthropic')).toEqual({ kind: 'preserve' });
  });

  it('reads a present-but-empty entry as "the field was shown and left blank"', () => {
    expect(endpointFromSettingsPayload({ anthropic: undefined }, 'anthropic'))
      .toEqual({ kind: 'cleared' });
    expect(endpointFromSettingsPayload({ anthropic: '   ' }, 'anthropic'))
      .toEqual({ kind: 'cleared' });
  });

  it('reads a filled entry as the host itself', () => {
    expect(endpointFromSettingsPayload({ anthropic: ' https://gw.example ' }, 'anthropic'))
      .toEqual({ kind: 'at', baseUrl: 'https://gw.example' });
  });
});

describe('applyProviderCredential — intent decides, absence never does', () => {
  it('REFUSES a replacement key it cannot scope, rather than guessing', () => {
    // The row names a custom host; the surface has no way to say whether the
    // new key came from that host or from Anthropic directly. Keeping the host
    // sends a public key to the gateway; dropping it sends a gateway key to the
    // public API. Both shipped as leaks, so neither is guessed: nothing is
    // written and the old credential is left exactly as it was.
    const providers = [{ type: 'anthropic', apiKey: 'old-gw', baseUrl: 'https://corp-gateway.example' }];
    const outcome = applyProviderCredential(providers, 'anthropic', 'unknown-scope-key', { kind: 'preserve' });

    expect(outcome).toEqual({ written: false, reason: 'ambiguous-scope' });
    expect(providers[0]).toMatchObject({ apiKey: 'old-gw', baseUrl: 'https://corp-gateway.example' });
  });

  it('writes on preserve when the row names no custom host to be ambiguous about', () => {
    const providers = [{ type: 'anthropic', apiKey: 'old' }];
    expect(applyProviderCredential(providers, 'anthropic', 'sk-ant-new', { kind: 'preserve' }))
      .toEqual({ written: true });
    expect(providers[0]).toMatchObject({ apiKey: 'sk-ant-new' });
    expect(providers[0]?.baseUrl).toBeUndefined();
  });

  it('retires it when the caller HAS the field and it was empty', () => {
    const providers = [{ type: 'anthropic', apiKey: 'old-gw', baseUrl: 'https://corp-gateway.example' }];
    applyProviderCredential(providers, 'anthropic', 'sk-ant-public', { kind: 'cleared' });
    expect(providers[0]?.apiKey).toBe('sk-ant-public');
    expect(providers[0]?.baseUrl).toBeUndefined();
  });

  it('retires the whole pairing when a no-default provider has its endpoint cleared', () => {
    // The user emptied a field they were shown, and `openai-compatible` has no
    // public host — the row addresses nothing now. Writing the key anyway is
    // not a harmless no-op: an endpointless compatible row hands `baseURL:
    // undefined` to the OpenAI SDK, which defaults to api.openai.com, so a Groq
    // key would be sent to OpenAI.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    const outcome = applyProviderCredential(providers, 'openai-compatible', 'new-key', { kind: 'cleared' });

    expect(outcome).toEqual({ written: false, reason: 'unroutable' });
    expect(providers[0]?.apiKey).toBeUndefined();
    expect(providers[0]?.baseUrl).toBeUndefined();
  });

  it('writes the host it was given', () => {
    const providers = [{ type: 'anthropic', apiKey: 'old', baseUrl: 'https://old-gw.example' }];
    applyProviderCredential(providers, 'anthropic', 'gw-key', { kind: 'at', baseUrl: 'https://new-gw.example' });
    expect(providers[0]).toMatchObject({ apiKey: 'gw-key', baseUrl: 'https://new-gw.example' });
  });

  it('still clears a bearer the key replaces', () => {
    // AnthropicProvider prefers authToken when both are set, so a surviving
    // bearer would make the key the user just typed silently unused.
    const providers = [{ type: 'anthropic', authToken: 'stale', baseUrl: 'https://corp-gateway.example' }];
    applyProviderCredential(providers, 'anthropic', 'sk-ant-public', { kind: 'cleared' });
    expect(providers[0]?.authToken).toBeUndefined();
    expect(providers[0]?.baseUrl).toBeUndefined();
  });

  it('creates the entry when the provider is not configured yet', () => {
    const providers: Array<{ type: string; apiKey?: string; baseUrl?: string }> = [];
    applyProviderCredential(providers, 'openai', 'sk-new', { kind: 'preserve' });
    expect(providers).toEqual([{ type: 'openai', apiKey: 'sk-new' }]);
  });

  it('drops `local` when the host changes, and keeps it when it does not', () => {
    const moved = [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://localhost:8000/v1', local: true }];
    applyProviderCredential(moved, 'openai-compatible', 'groq-key', { kind: 'at', baseUrl: 'https://api.groq.com/openai/v1' });
    expect(moved[0]?.local).toBeUndefined();

    const stayed = [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://localhost:8000/v1', local: true }];
    applyProviderCredential(stayed, 'openai-compatible', 'k2', { kind: 'preserve' });
    expect(stayed[0]?.local).toBe(true);
  });
});

describe('priorAzureRow — a key is inherited only within its resource', () => {
  const prior = [
    { deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', apiKey: 'a-key' },
    { deploymentName: 'chat', baseUrl: 'https://resource-b.openai.azure.com', apiKey: 'b-key' },
  ];

  it('matches on deployment name AND resource', () => {
    expect(priorAzureRow(prior, { deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com/' }))
      .toMatchObject({ apiKey: 'a-key' });
  });

  it('inherits nothing when the deployment moved to another resource', () => {
    // An Azure key is resource-scoped, so matching the name alone copied
    // resource A's key onto resource B.
    expect(priorAzureRow(prior, { deploymentName: 'prod', baseUrl: 'https://resource-b.openai.azure.com' }))
      .toBeUndefined();
  });

  it('inherits nothing for a row with no deployment name', () => {
    expect(priorAzureRow(prior, { baseUrl: 'https://resource-a.openai.azure.com' })).toBeUndefined();
  });
});

describe('a NEW row is held to the same routability rule as an existing one', () => {
  // Onboarding used to create rows by pushing an object literal, so every rule
  // in this module applied to edits and to nothing else. The first key a user
  // ever enters is exactly the one that skipped them.
  it('refuses a fresh compatible key that names no host', () => {
    const providers: Array<{ type: string; apiKey?: string; baseUrl?: string }> = [];
    const outcome = applyProviderCredential(providers, 'openai-compatible', 'groq-key', { kind: 'cleared' });

    expect(outcome).toEqual({ written: false, reason: 'unroutable' });
    // …and no half-configured row is left behind.
    expect(providers).toEqual([]);
  });

  it('creates it when the host is named', () => {
    const providers: Array<{ type: string; apiKey?: string; baseUrl?: string }> = [];
    expect(applyProviderCredential(
      providers, 'openai-compatible', 'groq-key', { kind: 'at', baseUrl: 'https://api.groq.com/openai/v1' },
    )).toEqual({ written: true });
    expect(providers).toEqual([
      { type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' },
    ]);
  });

  it('creates a fresh public-host row for a provider that HAS a default', () => {
    // Anthropic with no endpoint is not unroutable — it has somewhere to go.
    const providers: Array<{ type: string; apiKey?: string; baseUrl?: string }> = [];
    expect(applyProviderCredential(providers, 'anthropic', 'sk-ant', { kind: 'preserve' }))
      .toEqual({ written: true });
    expect(providers).toEqual([{ type: 'anthropic', apiKey: 'sk-ant' }]);
  });
});

describe('every settings surface is actually wired to the shared rules', () => {
  // Source-level, deliberately. The tests above prove these helpers are
  // correct; they say nothing about whether the save handlers call them, and
  // that is the defect that kept recurring — a surface would grow its own copy
  // and diverge, leaving every other test in the suite green.
  //
  // Comments are stripped first so the prose in these files, which necessarily
  // names the function it stopped calling, cannot fail the check.
  const stripComments = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const read = async (rel: string): Promise<string> => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const nodePath = await import('node:path');
    const here = nodePath.dirname(url.fileURLToPath(import.meta.url));
    return stripComments(await fs.readFile(nodePath.join(here, rel), 'utf-8'));
  };

  it('the desktop onboarding save states its endpoint intent', async () => {
    const source = await read('../../app/electron/main.ts');
    // The shape the original finding described: an endpoint written straight
    // onto an existing row, leaving whatever credential was there attached.
    expect(source).not.toMatch(/if \(baseUrl\) existing\.baseUrl = baseUrl;/);
    expect(source).toMatch(/applyEndpointEdit\(existing, baseUrl, cfg\.apiKey\)/);
    // Creation goes through the rule too — it used to push an object literal,
    // so a first-run key was the one credential no rule applied to. Asserted as
    // the UNCONDITIONAL branch: re-adding `&& existing` reintroduces exactly
    // that gap while leaving a "does not push a literal" check green, which is
    // how the first version of this assertion missed it.
    expect(source).not.toMatch(/providers\.push\(\{\s*type,\s*\.\.\.\(cfg\.apiKey/);
    expect(source).toMatch(/if \(cfg\.apiKey\) \{/);
    expect(source).not.toMatch(/if \(cfg\.apiKey && existing\)/);
    // Intent is DECLARED, never inferred from an absent field.
    expect(source).toMatch(/kind: 'preserve'/);
    expect(source).not.toMatch(/applyProviderApiKey\(/);
  });

  it('the renderer states its endpoint intent and never reads an omission as a clear', async () => {
    // Renderer behaviour with no test harness of its own, so asserted from
    // source. Each of these is a defect that shipped: the panel blanking
    // gateway fields from a PARTIAL snapshot, the wizard carrying one
    // provider's draft to another, and the wizard re-deriving which providers
    // it had shown a field for.
    const settings = await read('../../app/src/views/SettingsView.tsx');
    expect(settings).toMatch(/addressableEndpoints\(/);
    // Endpoints are applied only from a payload that actually carries them,
    // and a late one does not overwrite what the user already typed.
    expect(settings).toMatch(/if \(cfg\.endpoints\) \{/);
    expect(settings).toMatch(/hydrateEndpoints\(/);
    // Every endpoint input MARKS ITS FIELD DIRTY. The wrapper existed and
    // nothing called it, so `touched` was always empty: a gateway typed before
    // the snapshot landed was dropped from the payload, and the helper's own
    // tests could not see it because they build `touched` by hand.
    for (const type of ['anthropic', 'openai', 'gemini', 'openai-compatible', 'ollama']) {
      expect(settings, type).toMatch(new RegExp(`touchEndpoint\\('${type}'`));
    }
    expect(settings).not.toMatch(/setUrl: setAnthropicUrl/);
    expect(settings).not.toMatch(/onChange=\{\(e\) => setOcUrl\(/);
    // The socket save is AWAITED, and a MISSING acknowledgement is not an empty
    // one — resolving a timeout as `{}` reported success over a socket that had
    // confirmed nothing.
    expect(settings).toMatch(/socket\?\.connected/);
    expect(settings).toMatch(/ack === null/);
    expect(settings).toMatch(/ack\.refused/);

    const onboarding = await read('../../app/src/views/OnboardingView.tsx');
    expect(onboarding).toMatch(/endpointOffered/);
    // Switching provider starts a new draft rather than inheriting a secret.
    expect(onboarding).toMatch(/chooseProvider/);
    expect(onboarding).not.toMatch(/onClick=\{\(\) => setSelectedProvider\(p\)\}/);
  });

  it('both live save handlers run the one shared implementation', async () => {
    for (const rel of ['../../app/electron/main.ts', '../dashboard/server.ts']) {
      const source = await read(rel);
      // The WHOLE payload, not just its credential half. Applying the rest
      // separately is how the socket path came to support four fields fewer
      // than the panel offered on it.
      expect(source, rel).toMatch(/applySettingsPayload\(/);
      // No hand-rolled key loop beside it — that is how the dashboard drifted
      // into writing keys without endpoints and ignoring `endpoints` entirely.
      expect(source, rel).not.toMatch(/applyProviderApiKey\(/);
      // …and no private copy of the non-credential halves either. Matched on
      // the ASSIGNMENT: both files still legitimately READ budget fields to
      // build their redacted snapshots, and that is not a second writer.
      expect(source, rel).not.toMatch(/budget\.maxCostPerRunUsd\s*=/);
      expect(source, rel).not.toMatch(/budget\.dailyBudgetUsd\s*=/);
    }
  });
});
