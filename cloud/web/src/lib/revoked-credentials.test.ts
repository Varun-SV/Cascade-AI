import { describe, expect, it } from 'vitest';
import {
  describeRevokedRemoval, isRevokedSubscriptionCredential, isSubscriptionToken,
  stripRevokedCredentials,
} from './revoked-credentials.js';

describe('revoked subscription credentials in the browser', () => {
  it('recognises a subscription token by its mint prefix', () => {
    expect(isSubscriptionToken('sk-ant-oat01-abc')).toBe(true);
    expect(isSubscriptionToken('sk-ant-api03-real')).toBe(false);
    expect(isSubscriptionToken(undefined)).toBe(false);
  });

  it('recognises a row by the source `cascade link` stamped on it', () => {
    expect(isRevokedSubscriptionCredential({
      type: 'anthropic', authToken: 'opaque', credentialSource: 'Claude Code',
    })).toBe(true);
  });

  it('leaves a gateway bearer and an API key alone', () => {
    expect(isRevokedSubscriptionCredential({
      type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gw',
    })).toBe(false);
    expect(isRevokedSubscriptionCredential({ type: 'anthropic', apiKey: 'sk-ant-real' })).toBe(false);
    expect(isRevokedSubscriptionCredential({ type: 'openai', authToken: 'sk-ant-oat01-x' })).toBe(false);
  });

  it('drops a row whose only credential was the dead token', () => {
    // The browser cannot use `authToken` at all — it is not a field the web
    // sends — so a row left holding one would overwrite a working local key and
    // then be pushed back on the next sync.
    const { kept, removed } = stripRevokedCredentials([
      { type: 'anthropic', authToken: 'sk-ant-oat01-dead' },
    ]);
    expect(removed).toBe(1);
    expect(kept).toEqual([]);
  });

  it('keeps a row that still carries the replacement API key', () => {
    const { kept, removed } = stripRevokedCredentials([
      { type: 'anthropic', authToken: 'sk-ant-oat01-dead', apiKey: 'sk-ant-good' },
    ]);
    expect(removed).toBe(1);
    expect(kept).toEqual([{ type: 'anthropic', apiKey: 'sk-ant-good' }]);
  });

  it('passes an ordinary vault through untouched', () => {
    const providers = [{ type: 'openai', apiKey: 'sk-o' }, { type: 'anthropic', apiKey: 'sk-a' }];
    const { kept, removed } = stripRevokedCredentials(providers);
    expect(removed).toBe(0);
    expect(kept).toEqual(providers);
  });

  it('explains the removal in terms of the credential, not the provider', () => {
    const note = describeRevokedRemoval();
    expect(note).toMatch(/Claude subscription token/);
    expect(note).toMatch(/API key/);
    expect(note).not.toMatch(/no longer supported/);
  });
});
