import { describe, expect, it } from 'vitest';
import {
  credentialEndpointIdentity, credentialEndpointsConflict, hasDefaultEndpoint, sameCredentialEndpoint,
} from './endpoint-identity.js';

describe('credentialEndpointIdentity', () => {
  it('resolves a missing endpoint to the provider default, not to "anything"', () => {
    // The assumption three separate paths got wrong: `{ type: 'anthropic',
    // apiKey }` with no baseUrl is a key for Anthropic's PUBLIC host, and
    // treating absence as a wildcard let it stay attached while a corporate
    // gateway was written in beside it.
    expect(credentialEndpointIdentity('anthropic', undefined))
      .toBe(credentialEndpointIdentity('anthropic', 'https://api.anthropic.com'));
  });

  it('has no default for types that genuinely have no canonical host', () => {
    expect(hasDefaultEndpoint('openai-compatible')).toBe(false);
    expect(hasDefaultEndpoint('azure')).toBe(false);
    expect(credentialEndpointIdentity('openai-compatible', undefined)).toBeNull();
  });
});

describe('sameCredentialEndpoint', () => {
  it('treats Anthropic’s optional /v1 suffix as the same host', () => {
    // anthropicApiRoot() deliberately makes these one API root, and its tests
    // assert it — so comparing them as raw paths retired a key across an edit
    // that changed nothing about where requests go.
    expect(sameCredentialEndpoint('anthropic', 'https://gw.example', 'https://gw.example/v1')).toBe(true);
    expect(sameCredentialEndpoint('anthropic', 'https://gw.example/v1/', 'https://gw.example')).toBe(true);
  });

  it('says a public-host key is NOT scoped to a gateway', () => {
    expect(sameCredentialEndpoint('anthropic', undefined, 'https://corp-gateway.example')).toBe(false);
  });

  it('still distinguishes two different gateways', () => {
    expect(sameCredentialEndpoint('anthropic', 'https://gw-a.example', 'https://gw-b.example')).toBe(false);
  });

  it('keeps distinct tenant paths distinct', () => {
    expect(sameCredentialEndpoint('anthropic', 'https://gw.example/TenantA', 'https://gw.example/tenanta'))
      .toBe(false);
  });

  it('is unchanged when neither side names a host and none is implied', () => {
    expect(sameCredentialEndpoint('openai-compatible', undefined, undefined)).toBe(true);
  });

  it('refuses to call an unscoped row the same as a configured one', () => {
    // A host being introduced where there was none is exactly the edit that
    // must retire a credential.
    expect(sameCredentialEndpoint('openai-compatible', undefined, 'https://openrouter.ai/api/v1')).toBe(false);
  });

  it('ignores host case and a trailing slash, as before', () => {
    expect(sameCredentialEndpoint('openai-compatible', 'https://API.Groq.com/openai/v1/', 'https://api.groq.com/openai/v1'))
      .toBe(true);
  });

  it('does NOT collapse /v1 for a provider whose client keeps the path', () => {
    // OpenAICompatibleProvider passes baseUrl straight through as the SDK's
    // baseURL and builds discovery as `base + '/models'`, so these are two
    // different routes. Stripping the suffix for every type let a key survive
    // an edit that moved generation somewhere else.
    expect(sameCredentialEndpoint(
      'openai-compatible', 'https://api.groq.com/openai/v1', 'https://api.groq.com/openai',
    )).toBe(false);
  });
});

describe('credentialEndpointsConflict — the merge question, not the edit question', () => {
  it('finds a conflict when a bare key meets a configured gateway', () => {
    // A global `{ anthropic, apiKey }` with no baseUrl is a PUBLIC-host key.
    // The merge only compared endpoints when both rows had one, so it filled
    // that key into a workspace row pointing at a corporate gateway.
    expect(credentialEndpointsConflict('anthropic', 'https://corp-gateway.example', undefined)).toBe(true);
  });

  it('finds no conflict when the ROW names nothing', () => {
    // The case the global store exists for. A row with no credential and no
    // endpoint is a placeholder, not a claim to the public host — resolving its
    // absence to a default would stop it adopting a stored entry at all.
    expect(credentialEndpointsConflict('azure', undefined, 'https://r1.openai.azure.com')).toBe(false);
    expect(credentialEndpointsConflict('anthropic', undefined, 'https://gw-a.example')).toBe(false);
  });

  it('still finds a conflict between two different configured hosts', () => {
    expect(credentialEndpointsConflict('azure', 'https://r1.openai.azure.com', 'https://r2.openai.azure.com'))
      .toBe(true);
    expect(credentialEndpointsConflict('anthropic', 'https://gw-a.example', 'https://gw-b.example')).toBe(true);
  });

  it('agrees with itself across Anthropic’s two spellings', () => {
    expect(credentialEndpointsConflict('anthropic', 'https://gw.example', 'https://gw.example/v1')).toBe(false);
  });
});
