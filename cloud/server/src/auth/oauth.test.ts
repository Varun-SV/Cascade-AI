import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { githubAuthUrl, googleAuthUrl, exchangeGithubCode, exchangeGoogleCode } from './oauth.js';
import type { CloudEnv } from '../env.js';

const baseEnv: CloudEnv = {
  PORT: 8787,
  SESSION_SECRET: 'x'.repeat(20),
  DATA_DIR: './data',
  WEB_ORIGIN: 'http://localhost:5173',
  OAUTH_REDIRECT_BASE_URL: 'https://cascadeai.in',
  GITHUB_CLIENT_ID: 'gh-client-id',
  GITHUB_CLIENT_SECRET: 'gh-client-secret',
  GOOGLE_CLIENT_ID: 'gg-client-id',
  GOOGLE_CLIENT_SECRET: 'gg-client-secret',
  CLOUD_DEV_BYPASS: false,
  MAX_COST_PER_RUN_USD: 0.5,
};

describe('auth URL builders', () => {
  it('githubAuthUrl includes the client id, callback redirect, and state', () => {
    const url = new URL(githubAuthUrl('state123', baseEnv));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cascadeai.in/auth/github/callback');
    expect(url.searchParams.get('state')).toBe('state123');
  });

  it('googleAuthUrl includes the client id, callback redirect, and state', () => {
    const url = new URL(googleAuthUrl('state456', baseEnv));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('gg-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cascadeai.in/auth/google/callback');
    expect(url.searchParams.get('state')).toBe('state456');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('exchangeGithubCode', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('exchanges a code for a token and fetches the profile, falling back to the emails endpoint', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gh-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 42, login: 'octocat', name: 'The Octocat', avatar_url: 'https://x/avatar.png', email: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ email: 'octo@cat.com', primary: true, verified: true }],
      });

    const profile = await exchangeGithubCode('the-code', baseEnv);
    expect(profile).toEqual({ providerId: '42', email: 'octo@cat.com', name: 'The Octocat', avatar: 'https://x/avatar.png' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws when the token exchange fails', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    await expect(exchangeGithubCode('bad-code', baseEnv)).rejects.toThrow(/GitHub token exchange failed/);
  });
});

describe('exchangeGoogleCode', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('exchanges a code for a token and fetches the userinfo profile', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gg-token' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sub: 'sub-123', email: 'user@gmail.com', name: 'Google User', picture: 'https://x/pic.png' }),
      });

    const profile = await exchangeGoogleCode('the-code', baseEnv);
    expect(profile).toEqual({ providerId: 'sub-123', email: 'user@gmail.com', name: 'Google User', avatar: 'https://x/pic.png' });
  });

  it('throws when the userinfo fetch fails', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gg-token' }) })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(exchangeGoogleCode('the-code', baseEnv)).rejects.toThrow(/Google profile fetch failed/);
  });
});
