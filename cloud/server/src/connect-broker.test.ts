import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';
import {
  getBrokerProvider, brokerConfigured, brokeredConnectorIds,
  brokerCallbackUrl, brokerAuthorizeUrl, brokerExchangeCode, BrokerFlows,
} from './connect-broker.js';

const base = { SESSION_SECRET: 'x'.repeat(16), OAUTH_REDIRECT_BASE_URL: 'https://api.example.com' };
const configured = loadEnv({ ...base, CONNECT_GITHUB_CLIENT_ID: 'cid', CONNECT_GITHUB_CLIENT_SECRET: 'sec' });
const unconfigured = loadEnv({ ...base });

/** A one-shot fetch stub returning a JSON body with the given ok/status. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body })) as unknown as typeof fetch;
}

describe('connect broker — providers', () => {
  it('knows github and rejects unknown ids', () => {
    const gh = getBrokerProvider('github');
    expect(gh).toBeDefined();
    expect(gh!.mcpUrl).toBe('https://api.githubcopilot.com/mcp/');
    expect(gh!.scope).toContain('repo');
    expect(getBrokerProvider('nope')).toBeUndefined();
  });

  it('is "brokered" only when both client id and secret are set', () => {
    expect(brokerConfigured(configured, 'github')).toBe(true);
    expect(brokerConfigured(unconfigured, 'github')).toBe(false);
    expect(brokerConfigured(configured, 'unknown')).toBe(false);
    expect(brokeredConnectorIds(configured)).toEqual(['github']);
    expect(brokeredConnectorIds(unconfigured)).toEqual([]);
  });

  it('derives the callback URL from the redirect base', () => {
    expect(brokerCallbackUrl(configured, 'github')).toBe('https://api.example.com/api/connect/github/callback');
  });

  it('builds an authorize URL with client id, scope, state and callback', () => {
    const gh = getBrokerProvider('github')!;
    const url = new URL(brokerAuthorizeUrl(configured, gh, 'st4te'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(gh.scope);
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.com/api/connect/github/callback');
  });
});

describe('connect broker — code exchange', () => {
  const gh = getBrokerProvider('github')!;

  it('returns tokens on success (defaulting token_type to Bearer)', async () => {
    const tokens = await brokerExchangeCode(configured, gh, 'code123', stubFetch({ access_token: 'gho_abc', scope: 'repo' }));
    expect(tokens.access_token).toBe('gho_abc');
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('repo');
  });

  it('throws the provider error when no token is issued', async () => {
    await expect(
      brokerExchangeCode(configured, gh, 'bad', stubFetch({ error: 'bad_verification_code', error_description: 'The code is incorrect.' })),
    ).rejects.toThrow(/incorrect/i);
  });

  it('throws on a non-2xx token response', async () => {
    await expect(
      brokerExchangeCode(configured, gh, 'x', stubFetch({}, { ok: false, status: 500 })),
    ).rejects.toThrow(/500/);
  });
});

describe('connect broker — pending flows', () => {
  it('mints a single-use state bound to user + provider', () => {
    const flows = new BrokerFlows();
    const state = flows.create('user-1', 'github');
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    const taken = flows.take(state);
    expect(taken).toEqual({ userId: 'user-1', providerId: 'github', createdAt: expect.any(Number) });
    // single-use: a second take (replay) finds nothing
    expect(flows.take(state)).toBeUndefined();
  });

  it('returns undefined for an unknown state', () => {
    expect(new BrokerFlows().take('deadbeef')).toBeUndefined();
  });
});
