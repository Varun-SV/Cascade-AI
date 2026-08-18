import { describe, expect, it } from 'vitest';
import { applyEndpointEdit, applySettingsCredentials, credentialDispositionForEdit, priorAzureRow } from './settings-merge.js';
import { applyProviderCredential, sameCredentialEndpoint, sameAzureEndpoint } from '../../src/index.js';

describe('credentialDispositionForEdit', () => {
  it('keeps the key when the endpoint has not moved', () => {
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.groq.com/openai/v1/',
      undefined,
      sameCredentialEndpoint,
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
      sameCredentialEndpoint,
    )).toBe('clear');
  });

  it('drops the key when the endpoint is cleared', () => {
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' }, '', undefined, sameCredentialEndpoint,
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
      sameCredentialEndpoint,
    )).toBe('replaced');
    // …and likewise when the endpoint did not move at all.
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.groq.com/openai/v1',
      'new-key',
      sameCredentialEndpoint,
    )).toBe('replaced');
  });

  it('retires a public-host key when a gateway is typed in beside it', () => {
    // This previously asserted 'keep', on the reasoning that a row with no
    // baseUrl "is not endpoint-scoped". It is: for anthropic/openai/gemini a
    // missing baseUrl means the provider's own PUBLIC host, which is where the
    // client sends. Keeping the key while writing in a corporate gateway sent a
    // console.anthropic.com key to that gateway on the next request.
    expect(credentialDispositionForEdit(
      { type: 'anthropic' }, 'https://corp-gateway.example', undefined, sameCredentialEndpoint,
    )).toBe('clear');
  });

  it('keeps a key when the edit does not change where requests go', () => {
    // Anthropic's optional /v1 suffix names the same API root — anthropicApiRoot()
    // says so and its tests assert it — so this edit must not retire anything.
    expect(credentialDispositionForEdit(
      { type: 'anthropic', baseUrl: 'https://gw.example' },
      'https://gw.example/v1',
      undefined,
      sameCredentialEndpoint,
    )).toBe('keep');
    // …and writing the public host explicitly over an implicit one is a no-op.
    expect(credentialDispositionForEdit(
      { type: 'anthropic' }, 'https://api.anthropic.com', undefined, sameCredentialEndpoint,
    )).toBe('keep');
  });

  it('retires a key when an endpoint appears on a type with no default', () => {
    // openai-compatible has no canonical host, so "none → some" is still a host
    // being introduced where the credential was not scoped to one.
    expect(credentialDispositionForEdit(
      { type: 'openai-compatible' }, 'https://openrouter.ai/api/v1', undefined, sameCredentialEndpoint,
    )).toBe('clear');
  });
});

describe('priorAzureRow', () => {
  const prior = [
    { deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', apiKey: 'key-a' },
    { deploymentName: 'dev', baseUrl: 'https://resource-b.openai.azure.com', apiKey: 'key-b' },
  ];

  it('inherits the key when the deployment stays on its resource', () => {
    expect(priorAzureRow(prior, {
      deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com/',
    }, sameAzureEndpoint)?.apiKey).toBe('key-a');
  });

  it('inherits nothing when the deployment moves to another resource', () => {
    // Azure keys are resource-scoped; matching on the deployment name alone
    // copied resource A's key onto resource B.
    expect(priorAzureRow(prior, {
      deploymentName: 'prod', baseUrl: 'https://resource-b.openai.azure.com',
    }, sameAzureEndpoint)).toBeUndefined();
  });

  it('inherits nothing for a deployment with no name to match on', () => {
    expect(priorAzureRow(prior, { baseUrl: 'https://resource-a.openai.azure.com' }, sameAzureEndpoint))
      .toBeUndefined();
  });
});

describe('applySettingsCredentials — the real save sequence', () => {
  // The unit above is not enough on its own: the defect was in how the two
  // halves compose, and the composition lived inside `ipcMain.handle` where no
  // test could reach it.
  // The SDK's real key write, not a stand-in. A hand-rolled fake here would be
  // a second implementation of the very rule under test, and the composition
  // could then pass against a helper the desktop does not actually use.
  const deps = { applyProviderCredential, sameCredentialEndpoint };

  it('keeps a key and endpoint saved together', () => {
    // The reported P1: typing a new key alongside a new endpoint wrote the key
    // and then deleted it, so Settings appeared to discard what the user typed.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': 'new-key' },
      endpoints: { 'openai-compatible': 'https://api.deepseek.com/v1' },
    }, deps);

    expect(providers[0]).toMatchObject({ apiKey: 'new-key', baseUrl: 'https://api.deepseek.com/v1' });
  });

  it('keeps a key saved with no endpoint change at all', () => {
    const providers = [{ type: 'openai-compatible', apiKey: 'old', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': 'new-key' },
      endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1' },
    }, deps);

    expect(providers[0]?.apiKey).toBe('new-key');
  });

  it('still retires a key when the host moves and nothing was typed', () => {
    // The behaviour the disposition exists to preserve.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      endpoints: { 'openai-compatible': 'https://api.deepseek.com/v1' },
    }, deps);

    expect(providers[0]?.apiKey).toBeUndefined();
    expect(providers[0]?.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('leaves a blank key field meaning "keep it" when the host is unchanged', () => {
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': '' },
      endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1/' },
    }, deps);

    expect(providers[0]?.apiKey).toBe('groq-key');
  });

  it('creates a row for an endpoint typed against a provider with none', () => {
    const providers: Array<{ type: string; apiKey?: string; baseUrl?: string }> = [];
    applySettingsCredentials(providers, { endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1' } }, deps);
    expect(providers).toEqual([{ type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' }]);
  });

  it('retires a stored gateway when the payload carries a key but no endpoint for it', () => {
    // The exact Settings payload: `SettingsView.save()` sends endpoint fields
    // only for `openai-compatible` and `ollama`, so an Anthropic key never
    // reaches the endpoint loop below at all. Writing it with a plain
    // `applyProviderApiKey` replaced the secret and left the corporate gateway
    // attached, and the next request sent the new public-host key there. No
    // amount of care in the endpoint loop could have caught it — the key write
    // has to hold the rule itself.
    const providers = [{ type: 'anthropic', apiKey: 'old-gateway-key', baseUrl: 'https://corp-gateway.example' }];
    applySettingsCredentials(providers, {
      keys: { anthropic: 'sk-ant-public', openai: undefined, gemini: undefined, 'openai-compatible': undefined },
      endpoints: { 'openai-compatible': undefined, ollama: undefined },
    }, deps);

    expect(providers[0]?.apiKey).toBe('sk-ant-public');
    expect(providers[0]?.baseUrl).toBeUndefined();
  });

  it('leaves an untouched provider alone when another provider is re-keyed', () => {
    // The retirement is scoped to the row whose key was typed. A save that
    // re-keys Anthropic must not disturb a configured OpenAI-compatible host.
    const providers = [
      { type: 'anthropic', apiKey: 'old', baseUrl: 'https://corp-gateway.example' },
      { type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' },
    ];
    applySettingsCredentials(providers, {
      keys: { anthropic: 'sk-ant-public' },
      endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1', ollama: undefined },
    }, deps);

    expect(providers[0]).toMatchObject({ apiKey: 'sk-ant-public' });
    expect(providers[0]?.baseUrl).toBeUndefined();
    expect(providers[1]).toMatchObject({ apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' });
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
    }, deps);

    expect(providers[0]?.local).toBeUndefined();
    expect(providers[0]).toMatchObject({ apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' });
  });

  it('never touches azure, which has its own field', () => {
    const providers = [{ type: 'azure', apiKey: 'az', baseUrl: 'https://r1.openai.azure.com' }];
    applySettingsCredentials(providers, { endpoints: { azure: 'https://r2.openai.azure.com' } }, deps);
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
    applyEndpointEdit(row, 'https://api.groq.com/openai/v1', undefined, { sameCredentialEndpoint });

    expect(row.apiKey).toBeUndefined();
    expect(row.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('keeps the key when onboarding supplies one with the endpoint', () => {
    const row = { type: 'openai-compatible', apiKey: 'old', baseUrl: 'https://openrouter.ai/api/v1' };
    applyEndpointEdit(row, 'https://api.groq.com/openai/v1', 'groq-key', { sameCredentialEndpoint });
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
    applyEndpointEdit(row, 'https://api.groq.com/openai/v1', 'groq-key', { sameCredentialEndpoint });

    expect(row.local).toBeUndefined();
    expect(row.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('keeps `local` when the endpoint has not actually moved', () => {
    // An explicit `local` is a user statement about THIS host — a self-hosted
    // box on a public-looking domain, say. Re-saving the same URL must not
    // silently discard it.
    const row = { type: 'openai-compatible', apiKey: 'k', baseUrl: 'https://llm.internal.example/v1', local: true };
    applyEndpointEdit(row, 'https://llm.internal.example/v1/', undefined, { sameCredentialEndpoint });

    expect(row.local).toBe(true);
  });
});

describe('both desktop save paths are actually wired to the shared rule', () => {
  // A source-level check, deliberately. The tests above prove `applyEndpointEdit`
  // is correct; they say nothing about whether `main.ts` calls it, and the bug
  // was precisely that one save path did not. Reverting the call site left every
  // other test green. `desktop-core-contract.test.ts` already checks desktop
  // wiring from source for the same reason.
  it('cascade:setConfig does not assign baseUrl without the credential rule', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, 'main.ts'), 'utf-8');

    // The shape the finding described: an endpoint written straight onto an
    // existing row, leaving whatever credential was there attached to a new host.
    expect(source).not.toMatch(/if \(baseUrl\) existing\.baseUrl = baseUrl;/);
    // Both save paths reach the shared rule.
    expect(source).toMatch(/applyEndpointEdit\(existing, baseUrl, cfg\.apiKey/);
    // …and the KEYED branch reaches the provider-aware write, not applyProviderApiKey direct.
    expect(source).not.toMatch(/applyProviderApiKey\(cascadeConfig\.providers, type, cfg\.apiKey/);
    expect(source).toMatch(/applyProviderCredential\(cascadeConfig\.providers, type, cfg\.apiKey, baseUrl\)/);
    expect(source).toMatch(/applySettingsCredentials\(cascadeConfig\.providers, data/);
  });

});
