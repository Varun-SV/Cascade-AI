import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.js';
import { CloudStore } from './db.js';
import type { CloudEnv } from './env.js';
import { SESSION_COOKIE_NAME } from './auth/session.js';

function extractCookie(res: Response, name: string): string | null {
  // Node's fetch Headers only exposes one "set-cookie" value via get(); use
  // getSetCookie() (Node 20+) for the full list.
  const values = typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];
  for (const raw of values) {
    // `[^;]*` (not `+`) — a cleared cookie's Set-Cookie has an EMPTY value
    // ("name=; Expires=..."), and callers need that empty cookie back to
    // verify logout actually clears the session.
    const match = raw.match(new RegExp(`${name}=([^;]*)`));
    if (match) return `${name}=${match[1]}`;
  }
  return null;
}

describe('cloud/server app', () => {
  let dir: string;
  let store: CloudStore;
  let server: http.Server;
  let baseUrl: string;
  const env: CloudEnv = {
    PORT: 0,
    SESSION_SECRET: 'test-session-secret-value',
    DATA_DIR: './data',
    WEB_ORIGIN: 'http://localhost:5173',
    OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787',
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    CLOUD_DEV_BYPASS: true,
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-app-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    const app = createApp(env, store);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    store.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /api/me with no session cookie returns a null user', async () => {
    const res = await fetch(`${baseUrl}/api/me`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it('GET /api/conversations without a session is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/conversations`);
    expect(res.status).toBe(401);
  });

  it('dev-login sets a session cookie and /api/me resolves the logged-in user', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractCookie(loginRes, SESSION_COOKIE_NAME);
    expect(cookie).toBeTruthy();

    const meRes = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie! } });
    const body = (await meRes.json()) as { user: { name: string; provider: string } | null };
    expect(body.user?.name).toBe('Ada');
    expect(body.user?.provider).toBe('dev');
  });

  it('logout clears the session so /api/me goes back to null', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    });
    const cookie = extractCookie(loginRes, SESSION_COOKIE_NAME)!;

    const logoutRes = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    const clearedCookie = extractCookie(logoutRes, SESSION_COOKIE_NAME);
    expect(clearedCookie).toBe(`${SESSION_COOKIE_NAME}=`);
    // clearCookie re-sets with an empty value / past expiry — sending it back
    // to /api/me must not resolve to a session.
    const meRes = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: clearedCookie! } });
    expect(await meRes.json()).toEqual({ user: null });
  });

  it('rejects the GitHub OAuth callback when the state cookie does not match the query state', async () => {
    const res = await fetch(`${baseUrl}/auth/github/callback?code=abc&state=mismatched`, {
      redirect: 'manual',
      headers: { Cookie: 'cascade_oauth_state=different' },
    });
    expect(res.status).toBe(400);
  });

  it('returns 503 from /auth/github when GitHub OAuth is not configured', async () => {
    const res = await fetch(`${baseUrl}/auth/github`, { redirect: 'manual' });
    expect(res.status).toBe(503);
  });

  it('echoes the configured WEB_ORIGIN on CORS headers', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe(env.WEB_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('rate-limits repeated hits on unauthenticated /auth endpoints', async () => {
    const requests = Array.from({ length: 21 }, () => fetch(`${baseUrl}/auth/logout`, { method: 'POST' }));
    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('a user cannot list another user\'s conversations', async () => {
    const aliceLogin = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    const aliceCookie = extractCookie(aliceLogin, SESSION_COOKIE_NAME)!;

    const bobLogin = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    });
    const bobCookie = extractCookie(bobLogin, SESSION_COOKIE_NAME)!;

    const aliceMe = (await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: aliceCookie } })).json()) as {
      user: { id: string };
    };

    // Create a conversation directly via the store (run pipeline lands in #26).
    store.createConversation(aliceMe.user!.id, 'Alice private convo');

    const bobConversations = (await (
      await fetch(`${baseUrl}/api/conversations`, { headers: { Cookie: bobCookie } })
    ).json()) as { conversations: unknown[] };
    expect(bobConversations.conversations).toEqual([]);

    const aliceConversations = (await (
      await fetch(`${baseUrl}/api/conversations`, { headers: { Cookie: aliceCookie } })
    ).json()) as { conversations: unknown[] };
    expect(aliceConversations.conversations).toHaveLength(1);
  });
});
