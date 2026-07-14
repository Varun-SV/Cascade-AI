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
    MAX_COST_PER_RUN_USD: 0.5,
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-app-'));
    // Keep per-tenant upload writes inside the throwaway temp dir, not ./data.
    env.DATA_DIR = dir;
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

  it('GET /api/config reports dev-login enabled and OAuth providers unconfigured', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(await res.json()).toEqual({
      githubEnabled: false,
      googleEnabled: false,
      googleClientId: null,
      devLoginEnabled: true,
    });
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

  it('GET /api/usage without a session is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/usage`);
    expect(res.status).toBe(401);
  });

  it('GET /api/usage reports plan and today\'s usage for a signed-in user', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Usage Checker' }),
    });
    const cookie = extractCookie(loginRes, SESSION_COOKIE_NAME)!;

    const res = await fetch(`${baseUrl}/api/usage`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: 'free', dailyRuns: 0, dailyRunLimit: 20, maxConcurrentRuns: 1 });
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

  // A 1×1 transparent PNG.
  const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  async function login(name: string): Promise<string> {
    const res = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return extractCookie(res, SESSION_COOKIE_NAME)!;
  }

  it('GET /api/skills returns the catalog without leaking system prompts', async () => {
    const res = await fetch(`${baseUrl}/api/skills`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<Record<string, unknown>> };
    expect(body.skills.length).toBeGreaterThan(0);
    expect(body.skills[0]).toHaveProperty('id');
    expect(body.skills[0]).toHaveProperty('name');
    expect(body.skills[0]).not.toHaveProperty('systemPrompt');
  });

  it('memories: add, list, update, delete — scoped to the owner', async () => {
    const alice = await login('Alice');
    const bob = await login('Bob');

    const added = (await (await fetch(`${baseUrl}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ content: 'Prefers TypeScript' }),
    })).json()) as { memory: { id: string; content: string } };
    expect(added.memory.content).toBe('Prefers TypeScript');

    // Bob cannot see Alice's memory.
    const bobList = (await (await fetch(`${baseUrl}/api/memories`, { headers: { Cookie: bob } })).json()) as { memories: unknown[] };
    expect(bobList.memories).toEqual([]);

    // Bob cannot update or delete Alice's memory.
    const bobUpdate = await fetch(`${baseUrl}/api/memories/${added.memory.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: bob },
      body: JSON.stringify({ content: 'hacked' }),
    });
    expect(bobUpdate.status).toBe(404);

    const updated = (await (await fetch(`${baseUrl}/api/memories/${added.memory.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ content: 'Prefers Rust' }),
    })).json()) as { memory: { content: string } };
    expect(updated.memory.content).toBe('Prefers Rust');

    const del = await fetch(`${baseUrl}/api/memories/${added.memory.id}`, { method: 'DELETE', headers: { Cookie: alice } });
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    const aliceList = (await (await fetch(`${baseUrl}/api/memories`, { headers: { Cookie: alice } })).json()) as { memories: unknown[] };
    expect(aliceList.memories).toEqual([]);
  });

  it('POST /api/memories rejects blank and over-long content', async () => {
    const alice = await login('Alice');
    const blank = await fetch(`${baseUrl}/api/memories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice }, body: JSON.stringify({ content: '   ' }),
    });
    expect(blank.status).toBe(400);
    const tooLong = await fetch(`${baseUrl}/api/memories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice }, body: JSON.stringify({ content: 'x'.repeat(2001) }),
    });
    expect(tooLong.status).toBe(400);
  });

  it('custom skills: create, list (with usage + systemPrompt), edit, delete — owner-scoped', async () => {
    const alice = await login('Alice');
    const bob = await login('Bob');

    const created = (await (await fetch(`${baseUrl}/api/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ name: 'SQL Tutor', description: 'teaches SQL', systemPrompt: 'You teach SQL.' }),
    })).json()) as { skill: { id: string; custom: boolean; usageCount: number } };
    expect(created.skill.custom).toBe(true);

    // Alice's catalog now includes her custom skill WITH its systemPrompt (she owns it).
    const aliceList = (await (await fetch(`${baseUrl}/api/skills`, { headers: { Cookie: alice } })).json()) as {
      skills: Array<{ id: string; custom: boolean; usageCount: number; systemPrompt?: string }>;
    };
    const mine = aliceList.skills.find((s) => s.id === created.skill.id)!;
    expect(mine.systemPrompt).toBe('You teach SQL.');

    // Bob only sees built-ins (custom:false), never Alice's skill.
    const bobList = (await (await fetch(`${baseUrl}/api/skills`, { headers: { Cookie: bob } })).json()) as {
      skills: Array<{ id: string; custom: boolean }>;
    };
    expect(bobList.skills.some((s) => s.id === created.skill.id)).toBe(false);
    expect(bobList.skills.every((s) => s.custom === false)).toBe(true);

    // Bob cannot edit or delete Alice's skill.
    const bobEdit = await fetch(`${baseUrl}/api/skills/${created.skill.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: bob },
      body: JSON.stringify({ name: 'Hijacked', description: '', systemPrompt: 'x' }),
    });
    expect(bobEdit.status).toBe(404);

    const edited = (await (await fetch(`${baseUrl}/api/skills/${created.skill.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ name: 'SQL Coach', description: 'coaches SQL', systemPrompt: 'You coach SQL.' }),
    })).json()) as { skill: { name: string } };
    expect(edited.skill.name).toBe('SQL Coach');

    const del = await fetch(`${baseUrl}/api/skills/${created.skill.id}`, { method: 'DELETE', headers: { Cookie: alice } });
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('POST /api/skills rejects a blank name or missing instructions', async () => {
    const alice = await login('Alice');
    const noName = await fetch(`${baseUrl}/api/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ name: '  ', systemPrompt: 'x' }),
    });
    expect(noName.status).toBe(400);
    const noPrompt = await fetch(`${baseUrl}/api/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ name: 'Nameless', systemPrompt: '   ' }),
    });
    expect(noPrompt.status).toBe(400);
  });

  it('memories: round-trips a category', async () => {
    const alice = await login('Alice');
    const added = (await (await fetch(`${baseUrl}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ content: 'Ships on Fridays', category: 'PROJECT' }),
    })).json()) as { memory: { category: string | null } };
    expect(added.memory.category).toBe('PROJECT');
  });

  it('uploads: accepts a valid image, serves it back to the owner, and denies others', async () => {
    const alice = await login('Alice');
    const bob = await login('Bob');

    const upload = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: 'image/png', dataBase64: TINY_PNG_BASE64 }),
    });
    expect(upload.status).toBe(200);
    const { id } = (await upload.json()) as { id: string };

    // Owner can fetch the bytes back.
    const owned = await fetch(`${baseUrl}/api/uploads/${id}`, { headers: { Cookie: alice } });
    expect(owned.status).toBe(200);
    expect(owned.headers.get('content-type')).toContain('image/png');

    // A different user cannot.
    const foreign = await fetch(`${baseUrl}/api/uploads/${id}`, { headers: { Cookie: bob } });
    expect(foreign.status).toBe(404);
  });

  it('POST /api/uploads rejects a non-image mime and missing data', async () => {
    const alice = await login('Alice');
    const badMime = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: 'application/pdf', dataBase64: TINY_PNG_BASE64 }),
    });
    expect(badMime.status).toBe(400);
    const noData = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: 'image/png' }),
    });
    expect(noData.status).toBe(400);
  });
});
