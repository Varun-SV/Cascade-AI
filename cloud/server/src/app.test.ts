import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { buildMediaSink } from './runs.js';
import { CloudStore } from './db.js';
import { DOCX_MIME, expandingDocx } from './test-support/expanding-docx.js';
import { MAX_CONCURRENT_EXTRACTIONS, MAX_QUEUED_EXTRACTION_BYTES, withExtractionSlot } from './documents.js';
import { limitsForPlan, ORPHAN_UPLOAD_TTL_MS } from './entitlements.js';
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

// createApp() checks whether cloud/web's build output exists and, if so,
// registers static-serving routes for it — a decision made once, synchronously,
// at createApp() call time. So this fixture has to exist BEFORE the per-test
// beforeEach below ever calls createApp(), which means beforeAll/afterAll here,
// not a nested describe's beforeEach (which would run AFTER the outer one).
const webDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const HASHED_ASSET = 'assets/app-testfixturehash.js';

describe('cloud/server app', () => {
  let dir: string;
  let store: CloudStore;
  let server: http.Server;
  let baseUrl: string;
  let webDistPreexisted = false;
  let originalIndexHtml: string | null = null;

  beforeAll(async () => {
    webDistPreexisted = await fs.access(webDistDir).then(() => true, () => false);
    originalIndexHtml = webDistPreexisted
      ? await fs.readFile(path.join(webDistDir, 'index.html'), 'utf-8').catch(() => null)
      : null;
    await fs.mkdir(path.join(webDistDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(webDistDir, 'index.html'), '<!doctype html><html><body>fixture</body></html>');
    await fs.writeFile(path.join(webDistDir, HASHED_ASSET), 'console.log("fixture");');
  });

  afterAll(async () => {
    if (!webDistPreexisted) { await fs.rm(webDistDir, { recursive: true, force: true }); return; }
    if (originalIndexHtml !== null) await fs.writeFile(path.join(webDistDir, 'index.html'), originalIndexHtml);
    await fs.rm(path.join(webDistDir, HASHED_ASSET), { force: true });
  });

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

  /** Rebuild the app with extra env, for settings `createApp` closes over. */
  async function restartWith(extra: Partial<CloudEnv>): Promise<void> {
    await new Promise((resolve) => server.close(resolve));
    const app = createApp({ ...env, ...extra } as CloudEnv, store);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

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
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      githubEnabled: false,
      googleEnabled: false,
      googleClientId: null,
      devLoginEnabled: true,
    });
  });

  it('GET /api/config advertises the browser only where one can be built', async () => {
    // The flag exists so a deployment that cannot serve a browser does not show
    // a switch for one. Reading it off `REMOTE_BROWSER_PROVIDER` alone put the
    // inert switch straight back: a `cdp` provider with a missing or
    // non-websocket URL passes the env schema and then fails at `buildProvider`.
    //
    // Exercised through the ENDPOINT rather than the helper it calls, because
    // the helper already had tests and the wiring did not — reverting this very
    // line changed no test at all.
    const away = async () => {
      const res = await fetch(`${baseUrl}/api/config`);
      return (await res.json() as { remoteBrowserEnabled?: boolean }).remoteBrowserEnabled;
    };

    expect(await away(), 'nothing configured').toBe(false);

    await restartWith({ REMOTE_BROWSER_PROVIDER: 'cdp' });
    expect(await away(), 'cdp with no endpoint cannot be driven').toBe(false);

    await restartWith({ REMOTE_BROWSER_PROVIDER: 'cdp', REMOTE_BROWSER_URL: 'https://browser.example' });
    expect(await away(), 'an http endpoint is the likely mistake, not a browser').toBe(false);

    await restartWith({ REMOTE_BROWSER_PROVIDER: 'cdp', REMOTE_BROWSER_URL: 'ws://browser.internal:3000' });
    expect(await away(), 'this one can actually be driven').toBe(true);

    // This assertion used to read `steel defaults its own endpoint` and expect
    // TRUE, which encoded the bug rather than the rule: defaulting the URL is
    // not the same as being able to reach a browser, because the hosted API
    // refuses an unauthenticated request. The switch was advertised and the
    // first action failed on authentication — the third shape of the same
    // inert control, after cdp-with-no-endpoint and steel-with-a-bad-URL.
    await restartWith({ REMOTE_BROWSER_PROVIDER: 'steel' });
    expect(await away(), 'the hosted API cannot be reached without a key').toBe(false);

    await restartWith({ REMOTE_BROWSER_PROVIDER: 'steel', REMOTE_BROWSER_API_KEY: 'sk-test' });
    expect(await away(), 'hosted, with a credential').toBe(true);

    // A self-hosted Steel behind a private network or its own gateway
    // legitimately has no key. Requiring one to guard the DEFAULT would break
    // a working deployment.
    await restartWith({
      CASCADE_DEPLOYMENT_MODE: 'hosted',
      REMOTE_BROWSER_PROVIDER: 'steel',
      REMOTE_BROWSER_URL: 'https://steel.internal',
    });
    expect(await away(), 'a URL the operator supplied is their business').toBe(true);
  });

  it('GET /api/config serves the Azure base-model list from the SDK', async () => {
    // The web used to hard-code this list and it silently went stale — gpt-5.4
    // and gpt-5.5 shipped in routing and pricing while the picker still ended
    // at gpt-5, so those deployments were scored and priced as something else.
    // Serving it means the picker cannot drift from what routing knows.
    const res = await fetch(`${baseUrl}/api/config`);
    const { azureBaseModels } = await res.json() as { azureBaseModels?: string[] };
    expect(Array.isArray(azureBaseModels)).toBe(true);
    expect(azureBaseModels!.length).toBeGreaterThan(0);
    // The families whose absence was the bug.
    expect(azureBaseModels).toEqual(expect.arrayContaining(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']));
  });

  // Regression: a browser tab left open across a redeploy could silently keep
  // running an old bundle forever — no error, no visible sign anything was
  // wrong — because index.html and hashed assets were served with the same
  // (effectively cacheable) default headers. A stale index.html means the
  // client never learns about the NEW hashed filenames, so it never re-fetches
  // anything, even on a hard navigation.
  it('serves a hashed SPA asset with a long, immutable Cache-Control', async () => {
    const res = await fetch(`${baseUrl}/${HASHED_ASSET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves index.html — and any other SPA route — with no-cache, so a redeploy is always picked up', async () => {
    const root = await fetch(`${baseUrl}/`);
    expect(root.headers.get('cache-control')).toBe('no-cache');
    expect(await root.text()).toContain('fixture');

    // A client-side route (e.g. after a page reload on /chat/abc) falls through
    // to the same catch-all handler, not express.static's own index-serving.
    const spaRoute = await fetch(`${baseUrl}/chat/some-conversation-id`);
    expect(spaRoute.headers.get('cache-control')).toBe('no-cache');
    expect(await spaRoute.text()).toContain('fixture');
  });

  it('renames a conversation (owner-scoped) via PATCH /api/conversations/:id/title', async () => {
    const alice = await login('Alice');
    const bob = await login('Bob');
    const conv = (await (await fetch(`${baseUrl}/api/conversations`, { headers: { Cookie: alice } })).json()) as {
      conversations: Array<{ id: string }>;
    };
    // Alice has no conversations yet — create one directly through the store path
    // by posting a run is heavy; instead seed via the store is not reachable here,
    // so exercise the 404 (foreign/absent id) and the validation branches.
    expect(conv.conversations).toEqual([]);

    // Blank title → 400.
    const blank = await fetch(`${baseUrl}/api/conversations/whatever/title`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: alice }, body: JSON.stringify({ title: '  ' }),
    });
    expect(blank.status).toBe(400);

    // Unknown / not-owned id → 404 (also covers Bob renaming Alice's).
    const missing = await fetch(`${baseUrl}/api/conversations/nope/title`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: bob }, body: JSON.stringify({ title: 'Hi' }),
    });
    expect(missing.status).toBe(404);
  });

  it('native write API: create a cloud conversation, append turns, branch, and delete', async () => {
    const alice = await login('Alice');
    const bob = await login('Bob');
    const j = { 'Content-Type': 'application/json' };

    // Create a cloud-backed session.
    const created = (await (await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST', headers: { ...j, Cookie: alice }, body: JSON.stringify({ title: 'From the CLI' }),
    })).json()) as { conversation: { id: string; title: string } };
    const cid = created.conversation.id;
    expect(created.conversation.title).toBe('From the CLI');

    // Append a locally-executed turn.
    const append = (msg: Record<string, unknown>) =>
      fetch(`${baseUrl}/api/conversations/${cid}/turns`, { method: 'POST', headers: { ...j, Cookie: alice }, body: JSON.stringify(msg) });
    const t1 = (await (await append({ userContent: 'q1', assistant: { content: 'a1', tier: 'T3' } })).json()) as {
      messages: Array<{ id: string; role: string; content: string; parentId: string | null; siblingIds: string[] }>;
    };
    expect(t1.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const u1 = t1.messages[0]!;

    // Edit q1 → a sibling branch; original preserved, active path shows the edit.
    const t2 = (await (await append({ userContent: 'q1 edited', assistant: { content: 'a1b' }, editOfMessageId: u1.id })).json()) as {
      messages: Array<{ id: string; content: string; siblingIds: string[] }>;
    };
    expect(t2.messages.map((m) => m.content)).toEqual(['q1 edited', 'a1b']);
    expect(t2.messages[0]!.siblingIds).toHaveLength(2);

    // Switch back to the original branch via select-branch.
    const back = (await (await fetch(`${baseUrl}/api/conversations/${cid}/select-branch`, {
      method: 'POST', headers: { ...j, Cookie: alice }, body: JSON.stringify({ messageId: u1.id }),
    })).json()) as { messages: Array<{ content: string }> };
    expect(back.messages.map((m) => m.content)).toEqual(['q1', 'a1']);

    // Delete the original subtree → only the edited branch remains.
    const del = await fetch(`${baseUrl}/api/conversations/${cid}/messages/${u1.id}`, { method: 'DELETE', headers: { Cookie: alice } });
    const delBody = (await del.json()) as { messages: Array<{ content: string }> };
    expect(delBody.messages.map((m) => m.content)).toEqual(['q1 edited', 'a1b']);

    // Owner-scoping: Bob cannot append to Alice's conversation.
    const bobAppend = await fetch(`${baseUrl}/api/conversations/${cid}/turns`, {
      method: 'POST', headers: { ...j, Cookie: bob }, body: JSON.stringify({ userContent: 'x', assistant: { content: 'y' } }),
    });
    expect(bobAppend.status).toBe(404);
  });

  it('native write API: rejects a turn missing user or assistant content', async () => {
    const alice = await login('Alice');
    const created = (await (await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice }, body: JSON.stringify({}),
    })).json()) as { conversation: { id: string } };
    const bad = await fetch(`${baseUrl}/api/conversations/${created.conversation.id}/turns`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice }, body: JSON.stringify({ userContent: 'q' }),
    });
    expect(bad.status).toBe(400);
  });

  it('GET /api/billing reports not-configured when Razorpay env is absent', async () => {
    const alice = await login('Alice');
    const body = (await (await fetch(`${baseUrl}/api/billing`, { headers: { Cookie: alice } })).json()) as {
      configured: boolean; plan: string; keyId: string | null;
    };
    expect(body.configured).toBe(false);
    expect(body.keyId).toBeNull();
    expect(body.plan).toBe('free');
  });

  it('billing mutations are 503 and the webhook rejects a bad signature when unconfigured', async () => {
    const alice = await login('Alice');
    const sub = await fetch(`${baseUrl}/api/billing/subscribe`, { method: 'POST', headers: { Cookie: alice } });
    expect(sub.status).toBe(503);
    const hook = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'bad' }, body: '{}',
    });
    expect(hook.status).toBe(503);
  });

  it('does not 500 on a rate-limited route when X-Forwarded-For is set (trust proxy)', async () => {
    // Behind Railway's proxy every request carries X-Forwarded-For; without
    // `trust proxy` express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
    // and the endpoint 500s. /api/config is under the /api rate limiter.
    const res = await fetch(`${baseUrl}/api/config`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(res.status).toBe(200);
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
    // A deployment whose browser sessions are billed, so they are rationed.
    await restartWith({
      CASCADE_DEPLOYMENT_MODE: 'hosted',
      REMOTE_BROWSER_PROVIDER: 'steel',
      REMOTE_BROWSER_URL: 'https://steel.internal',
    });
    const loginRes = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Usage Checker' }),
    });
    const cookie = extractCookie(loginRes, SESSION_COOKIE_NAME)!;

    const res = await fetch(`${baseUrl}/api/usage`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    // Browser sessions too, so the chip can be off BEFORE a run is refused.
    expect(await res.json()).toEqual({
      plan: 'free', dailyRuns: 0, dailyRunLimit: 20, maxConcurrentRuns: 1,
      browserSessions: 0, browserSessionLimit: 5,
    });
  });

  it('GET /api/usage counts the browser sessions this user opened today', async () => {
    await restartWith({
      REMOTE_BROWSER_PROVIDER: 'steel',
      REMOTE_BROWSER_URL: 'https://api.steel.dev',
      REMOTE_BROWSER_API_KEY: 'sk-test',
    });
    const loginRes = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Browser User' }),
    });
    const cookie = extractCookie(loginRes, SESSION_COOKIE_NAME)!;
    const me = (await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).json()) as { user: { id: string } };
    const today = new Date().toISOString().slice(0, 10);
    store.incrementBrowserSessions(me.user.id, today);
    store.incrementBrowserSessions(me.user.id, today);

    const res = await fetch(`${baseUrl}/api/usage`, { headers: { Cookie: cookie } });
    const body = (await res.json()) as { browserSessions: number; browserSessionLimit: number };
    expect(body.browserSessions).toBe(2);
    expect(body.browserSessionLimit).toBe(5);
  });

  it('GET /api/usage reports no browser allowance where nothing rations one', async () => {
    // No browser, or the operator's own CDP endpoint, which opens no session:
    // a limit reported there is one nothing enforces, and the chip would show
    // it counting down.
    const fields = async () => {
      const loginRes = await fetch(`${baseUrl}/auth/dev-login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'No Ration' }),
      });
      const cookie = extractCookie(loginRes, SESSION_COOKIE_NAME)!;
      const body = await (await fetch(`${baseUrl}/api/usage`, { headers: { Cookie: cookie } })).json() as Record<string, unknown>;
      return ['browserSessions', 'browserSessionLimit'].filter((k) => k in body);
    };
    expect(await fields(), 'no browser at all').toEqual([]);
    await restartWith({ REMOTE_BROWSER_PROVIDER: 'cdp', REMOTE_BROWSER_URL: 'ws://browser.internal:3000' });
    expect(await fields(), 'a CDP endpoint').toEqual([]);
    await restartWith({
      CASCADE_DEPLOYMENT_MODE: 'self-hosted',
      REMOTE_BROWSER_PROVIDER: 'steel',
      REMOTE_BROWSER_URL: 'https://steel.internal',
    });
    expect(await fields(), 'self-hosted Cascade + Steel').toEqual([]);
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

  it('handoff: a transcript round-trips through a code with no session, open CORS', async () => {
    // Create — unauthenticated, as the keyless desktop app would.
    const created = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Ported chat',
        skillId: 'general',
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
        ],
      }),
    });
    expect(created.status).toBe(200);
    // The courier is reachable cross-origin but never with credentials.
    expect(created.headers.get('access-control-allow-origin')).toBe('*');
    expect(created.headers.get('access-control-allow-credentials')).toBeNull();
    const { code } = (await created.json()) as { code: string };
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Redeem — also unauthenticated, dash/case-insensitive.
    const read = await fetch(`${baseUrl}/api/handoff/${encodeURIComponent(code.toLowerCase())}`);
    expect(read.status).toBe(200);
    const snap = (await read.json()) as { title: string; skillId: string; messages: Array<{ role: string; content: string }> };
    expect(snap.title).toBe('Ported chat');
    expect(snap.skillId).toBe('general');
    expect(snap.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
  });

  it('handoff: carries a transcript larger than the default body limit', async () => {
    // The per-message bound is 500,000 characters, but both handoff routes ran
    // through the app-level express.json() default of 100kb — so a long chat
    // 413'd at the middleware and the validator never got to say anything. The
    // raised limit was unreachable until these routes got a parser sized to it.
    const long = 'a'.repeat(150_000);
    const created = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: long }] }),
    });
    expect(created.status).toBe(200);

    const { code } = (await created.json()) as { code: string };
    const read = await fetch(`${baseUrl}/api/handoff/${code}`);
    const snap = (await read.json()) as { messages: Array<{ content: string }> };
    // Carried whole, not trimmed to fit.
    expect(snap.messages[0]!.content).toHaveLength(150_000);
  });

  it('handoff: accepts a transcript whose JSON encoding is far larger than its length', async () => {
    // A limit the product advertises has to be one it can actually accept.
    // JSON renders a low control character as a six-byte \u0000, so a
    // transcript the validator calls valid can reach ~2.9 MiB on the wire —
    // past the first parser ceiling chosen for typical text, which would have
    // 413'd a transfer that passes every documented bound.
    const controlHeavy = '\u0000'.repeat(400_000);
    const created = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: controlHeavy }] }),
    });
    expect(created.status).toBe(200);
  });

  it('handoff: the trailing-slash URL gets the same body limit', async () => {
    // Express routing is non-strict, so /api/handoff/ reaches the same handler
    // — but req.path keeps the slash, so the exact-match parser exemption
    // missed it and the 100kb default 413'd a long transcript on one of two
    // URLs Express otherwise treats as identical.
    const long = 'a'.repeat(150_000);
    const created = await fetch(`${baseUrl}/api/handoff/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: long }] }),
    });
    expect(created.status).toBe(200);
  });

  it('handoff: rejects an empty transcript and 404s an unknown code', async () => {
    const empty = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }),
    });
    expect(empty.status).toBe(400);

    const missing = await fetch(`${baseUrl}/api/handoff/ZZZZ-ZZZZ`);
    expect(missing.status).toBe(404);
  });

  it('conversation import: seeds an owner-scoped conversation from a transcript', async () => {
    const alice = await login('Alice');
    const imported = await fetch(`${baseUrl}/api/conversations/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({
        title: 'Brought from desktop',
        messages: [
          { role: 'user', content: 'ported prompt' },
          { role: 'assistant', content: 'ported reply' },
          { role: 'system', content: 'should be dropped' },
        ],
      }),
    });
    expect(imported.status).toBe(200);
    const { conversation } = (await imported.json()) as { conversation: { id: string; title: string } };
    expect(conversation.title).toBe('Brought from desktop');

    // It shows in the owner's list and its transcript reads back (system dropped).
    const list = (await (await fetch(`${baseUrl}/api/conversations`, { headers: { Cookie: alice } })).json()) as {
      conversations: Array<{ id: string }>;
    };
    expect(list.conversations.map((c) => c.id)).toContain(conversation.id);

    const msgs = (await (await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, { headers: { Cookie: alice } })).json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(msgs.messages).toEqual([
      { role: 'user', content: 'ported prompt' },
      { role: 'assistant', content: 'ported reply' },
    ].map((m) => expect.objectContaining(m)));
  });

  it('conversation import without a session is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(res.status).toBe(401);
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

  // ── Generated media: free until saved ──
  // Drives the REAL sink a hosted run uses, so these cover the whole loop the
  // user sees: the model makes a picture → it costs nothing → they press Save
  // → it costs quota.

  /** The signed-in user's id (routes are cookie-scoped; the store is not). */
  async function userIdFor(cookie: string): Promise<string> {
    const me = (await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).json()) as { user: { id: string } };
    return me.user.id;
  }

  /** Generate media exactly the way a run does, and report where it landed. */
  async function generateMedia(
    cookie: string,
    opts: { bytes?: Buffer; name?: string; mime?: string } = {},
  ): Promise<{ id: string; location: string; userId: string; size: number }> {
    const userId = await userIdFor(cookie);
    const convo = store.createConversation(userId);
    const sink = buildMediaSink({
      env, store, userId, conversationId: convo.id,
      socket: { emit: () => undefined },
    });
    const data = opts.bytes ?? Buffer.from(TINY_PNG_BASE64, 'base64');
    const location = await sink({
      kind: 'image', data, mimeType: opts.mime ?? 'image/png',
      filename: opts.name ?? 'cascade-image.png', modelId: 'gpt-image-1',
    } as Parameters<typeof sink>[0]);
    return { id: location.slice('/api/files/'.length), location, userId, size: data.length };
  }

  it('generated media costs no storage until it is saved, and is served meanwhile', async () => {
    const alice = await login('Alice');
    const { id, size } = await generateMedia(alice);

    // Nothing metered: the Files list and the usage bar are untouched.
    const files = await (await fetch(`${baseUrl}/api/files`, { headers: { Cookie: alice } })).json();
    expect(files.files).toHaveLength(0);
    expect(files.usedBytes).toBe(0);

    // …but it IS listed as pending, with an expiry the UI can badge.
    const pending = await (await fetch(`${baseUrl}/api/pending-media`, { headers: { Cookie: alice } })).json();
    expect(pending.media).toHaveLength(1);
    expect(pending.media[0]).toMatchObject({ id, name: 'cascade-image.png', mime: 'image/png', size });
    expect(pending.media[0].expiresAt).toBeGreaterThan(Date.now());
    expect(pending.usedBytes).toBe(size);

    // The URL the model embedded resolves — the same route a saved file uses,
    // so the transcript renders identically before and after a save.
    const served = await fetch(`${baseUrl}/api/files/${id}`, { headers: { Cookie: alice } });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await served.arrayBuffer()).length).toBe(size);
  });

  it('saving generated media promotes it to a real file, charging quota then and only then', async () => {
    const alice = await login('Alice');
    const { id, size, userId } = await generateMedia(alice);
    expect(store.sumUserFileBytes(userId)).toBe(0);

    // The SAME POST /api/files the text/office cards save through.
    const saved = await fetch(`${baseUrl}/api/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ pendingMediaId: id }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    // Same id: the ![alt](/api/files/:id) already written into the transcript
    // must keep working after a save, not point at a swept locator.
    expect(body.file.id).toBe(id);
    expect(body.usedBytes).toBe(size);

    const files = await (await fetch(`${baseUrl}/api/files`, { headers: { Cookie: alice } })).json();
    expect(files.files.map((f: { id: string }) => f.id)).toEqual([id]);
    expect(files.usedBytes).toBe(size);
    // No longer pending — and the bytes moved with the row.
    const pending = await (await fetch(`${baseUrl}/api/pending-media`, { headers: { Cookie: alice } })).json();
    expect(pending.media).toHaveLength(0);
    const served = await fetch(`${baseUrl}/api/files/${id}`, { headers: { Cookie: alice } });
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).length).toBe(size);
  });

  it('a save that would exceed the plan cap is refused, and the media stays pending', async () => {
    const alice = await login('Alice');
    const userId = await userIdFor(alice);
    // Fill the free 10 MB cap with an already-saved file, then try to keep an
    // 8 MB clip. The clip generated fine (quota is not checked then) — it is
    // the SAVE that has to refuse.
    store.addFile({ userId, conversationId: null, name: 'big.bin', mime: 'application/octet-stream', size: 9 * 1024 * 1024 });
    const { id } = await generateMedia(alice, { bytes: Buffer.alloc(8 * 1024 * 1024, 1), name: 'clip.mp4', mime: 'video/mp4' });

    const res = await fetch(`${baseUrl}/api/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ pendingMediaId: id }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/storage full/i);

    // Refused, not destroyed: the user can delete something and try again.
    const pending = await (await fetch(`${baseUrl}/api/pending-media`, { headers: { Cookie: alice } })).json();
    expect(pending.media.map((m: { id: string }) => m.id)).toContain(id);
    expect(store.sumUserFileBytes(userId)).toBe(9 * 1024 * 1024);
  });

  it('pending media is owner-scoped: another tenant can neither read nor save it', async () => {
    const alice = await login('Alice');
    const bob = await login('Bob');
    const { id } = await generateMedia(alice);

    expect((await fetch(`${baseUrl}/api/files/${id}`, { headers: { Cookie: bob } })).status).toBe(404);
    const stolen = await fetch(`${baseUrl}/api/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bob },
      body: JSON.stringify({ pendingMediaId: id }),
    });
    expect(stolen.status).toBe(404);
    expect((await (await fetch(`${baseUrl}/api/pending-media`, { headers: { Cookie: bob } })).json()).media).toHaveLength(0);
  });

  it('discarding pending media deletes it through the same DELETE the Files panel uses', async () => {
    const alice = await login('Alice');
    const { id } = await generateMedia(alice);

    const res = await fetch(`${baseUrl}/api/files/${id}`, { method: 'DELETE', headers: { Cookie: alice } });
    expect(res.status).toBe(200);
    expect((await res.json()).usedBytes).toBe(0);
    expect((await (await fetch(`${baseUrl}/api/pending-media`, { headers: { Cookie: alice } })).json()).media).toHaveLength(0);
    expect((await fetch(`${baseUrl}/api/files/${id}`, { headers: { Cookie: alice } })).status).toBe(404);
  });

  it('a traversal-shaped id on DELETE is refused by the ownership lookup, never reaching the filesystem', async () => {
    // This pins the guard that actually makes DELETE /api/files/:id safe: the
    // store lookup runs BEFORE any path is built, and no traversal string can
    // match a row (addPendingMedia mints ids with randomUUID()), so the fs
    // call is unreachable for an id the caller invented.
    //
    // Worth stating plainly: this test passes both before and after the
    // accompanying `pendingMedia.id` change, and it is NOT a regression test
    // for it. CodeQL flagged that line (high severity, "Uncontrolled data
    // used in path expression") because the raw `:id` param reached a path
    // expression at all — a real taint flow, but one the lookup above already
    // made unexploitable, so no test can fail on it without fabricating a row
    // the application cannot produce. That change is defense in depth and
    // consistency with every other path expression here (see
    // docs/file-generation.md: "paths are derived from a server-generated id,
    // never client input").
    //
    // What this test DOES catch is the guard itself being dropped — e.g. an
    // "optimization" that skips the lookup and unlinks straight from the
    // param. Then the canary below dies and this fails, which is exactly the
    // regression worth owning.
    const alice = await login('Alice');
    const { id } = await generateMedia(alice);
    const canary = path.join(dir, 'canary.txt');
    await fs.writeFile(canary, 'must survive');

    // Escapes the tenant's tmp-media dir and lands exactly on the canary.
    const traversal = encodeURIComponent('../../../canary.txt');
    const res = await fetch(`${baseUrl}/api/files/${traversal}`, { method: 'DELETE', headers: { Cookie: alice } });

    // The route is a no-op for an unknown id, and the file outside the tenant
    // directory is untouched.
    expect(res.status).toBe(200);
    expect(await fs.readFile(canary, 'utf-8')).toBe('must survive');
    // …and the real asset was not collateral damage.
    expect((await (await fetch(`${baseUrl}/api/pending-media`, { headers: { Cookie: alice } })).json()).media)
      .toHaveLength(1);
    expect((await fetch(`${baseUrl}/api/files/${id}`, { headers: { Cookie: alice } })).status).toBe(200);
  });

  it('expired media reads as gone and cannot be saved, even before the sweeper deletes it', async () => {
    const alice = await login('Alice');
    const userId = await userIdFor(alice);
    // Bytes still on disk, row already past its TTL — the state between an
    // expiry and the next sweep. Without the lazy check that window would
    // leave an "expired" asset downloadable and savable.
    const stale = store.addPendingMedia({
      userId, conversationId: null, name: 'yesterday.png', mime: 'image/png',
      size: 4, expiresAt: Date.now() - 1,
    });
    await fs.mkdir(path.join(dir, 'tenants', userId, 'tmp-media'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tenants', userId, 'tmp-media', stale.id), Buffer.from('data'));

    expect((await fetch(`${baseUrl}/api/files/${stale.id}`, { headers: { Cookie: alice } })).status).toBe(404);
    const save = await fetch(`${baseUrl}/api/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ pendingMediaId: stale.id }),
    });
    expect(save.status).toBe(404);
    expect(store.sumUserFileBytes(userId)).toBe(0);
    expect((await (await fetch(`${baseUrl}/api/pending-media`, { headers: { Cookie: alice } })).json()).media).toHaveLength(0);
  });

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

  it('POST /api/uploads rejects an unsupported type and missing data', async () => {
    const alice = await login('Alice');
    // A type that is neither an image nor a supported document.
    const badMime = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: 'application/zip', filename: 'a.zip', dataBase64: TINY_PNG_BASE64 }),
    });
    expect(badMime.status).toBe(400);
    const noData = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: 'image/png' }),
    });
    expect(noData.status).toBe(400);
  });

  it('POST /api/uploads parses a plain-text document and stores its text', async () => {
    const alice = await login('Alice');
    const dataBase64 = Buffer.from('Hello from a text document.', 'utf8').toString('base64');
    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: 'text/plain', filename: 'notes.txt', dataBase64 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('document');
    expect(body.filename).toBe('notes.txt');
    expect(body.charCount).toBeGreaterThan(0);
  });

  it('POST /api/uploads holds a free account to its per-plan document ceiling', async () => {
    // The limit on a document is its SIZE, per plan — not a fixed cut through
    // its text at ingestion. The free ceiling is 5 MB; 6 MB is refused, and the
    // message says which plan it is talking about so the user knows whether the
    // file is wrong or their account is.
    const alice = await login('Alice');
    const dataBase64 = Buffer.alloc(6 * 1024 * 1024, 0x61).toString('base64');
    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: 'text/plain', filename: 'huge.txt', dataBase64 }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/free plan/i);
    expect(body.error).toMatch(/upgrade/i);
  });

  it('POST /api/uploads keeps the whole of a long document, with no truncation notice', async () => {
    // 250k characters — comfortably past the 200,000-char cut that extraction
    // used to make, and comfortably under the 5 MB free ceiling. Every
    // character is stored, and the response carries no `truncated` flag at all,
    // because nothing here shortens a document any more.
    const alice = await login('Alice');
    const chars = 250_000;
    const dataBase64 = Buffer.from('y'.repeat(chars), 'utf8').toString('base64');
    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: 'text/plain', filename: 'long.txt', dataBase64 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.charCount, 'stored whole, not cut at 200k').toBe(chars);
    expect(body.truncated, 'there is no truncation left to report').toBeUndefined();
  });

  // `documentBytes` bounds ONE upload. Nothing bounded what an account
  // accumulates once ingestion stopped cutting every document at 200,000
  // characters, and a DOCX compresses well enough that a few megabytes of
  // upload become tens of megabytes of durable text in the shared database.
  it('POST /api/uploads refuses once the account is at its stored-text ceiling', async () => {
    const alice = await login('Alice');
    const userId = await userIdFor(alice);
    const ceiling = limitsForPlan('free').documentTextChars;
    store.addAttachment({
      userId, messageId: null, kind: 'document', mime: 'text/plain',
      path: path.join(dir, 'seed.txt'), filename: 'seed.txt',
      extractedText: 'x'.repeat(ceiling),
    });

    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({
        mime: 'text/plain', filename: 'one-more.txt',
        dataBase64: Buffer.from('one more line', 'utf8').toString('base64'),
      }),
    });

    expect(res.status, 'a size refusal, with the size status').toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error, 'naming the plan, so the user knows what to change').toMatch(/free plan/i);
    expect(body.error, 'and the remedy').toMatch(/make room/i);
  });

  it('POST /api/uploads sweeps uploads abandoned past the orphan TTL', async () => {
    // An upload starts with message_id NULL and is linked when a run uses it.
    // A row still NULL a week later is one nothing else removes — conversation
    // deletion cascades from `messages`, and an orphan has none — so without
    // this the only way out of the ceiling would be deleting conversations
    // that were never the problem.
    const alice = await login('Alice');
    const userId = await userIdFor(alice);
    const orphanPath = path.join(dir, 'abandoned.bin');
    await fs.writeFile(orphanPath, 'bytes');
    const orphan = store.addAttachment({
      userId, messageId: null, kind: 'document', mime: 'text/plain',
      path: orphanPath, filename: 'abandoned.txt', extractedText: 'x'.repeat(1_000),
    });

    // Only Date is faked: undici still needs real timers to make the request.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + ORPHAN_UPLOAD_TTL_MS + 1_000);
      const res = await fetch(`${baseUrl}/api/uploads`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
        body: JSON.stringify({
          mime: 'text/plain', filename: 'fresh.txt',
          dataBase64: Buffer.from('a week later', 'utf8').toString('base64'),
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }

    expect(store.getOwnedAttachment(orphan.id, userId), 'the abandoned row is gone').toBeNull();
    expect(
      await fs.access(orphanPath).then(() => true, () => false),
      'and its bytes with it',
    ).toBe(false);
    expect(
      store.totalAttachmentChars(userId),
      'so its text stopped counting against the ceiling',
    ).toBeLessThan(1_000);
  });

  it('POST /api/uploads answers 503 when the extraction queue is full', async () => {
    // Busy is not broken. Telling this user the file may be corrupt would send
    // them to fix something that is fine.
    const alice = await login('Alice');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holders = Array.from({ length: MAX_CONCURRENT_EXTRACTIONS }, () =>
      withExtractionSlot(async () => { await held; }));
    await new Promise((r) => setImmediate(r));
    // Claims the whole queue budget, so any upload behind it is refused.
    const filler = withExtractionSlot(async () => { /* admitted later */ }, MAX_QUEUED_EXTRACTION_BYTES);
    await new Promise((r) => setImmediate(r));

    const bytes = await expandingDocx({ runChars: 64, runs: 4 });
    const pending = fetch(`${baseUrl}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: DOCX_MIME, filename: 'queued.docx', dataBase64: bytes.toString('base64') }),
    });
    // Long enough for the route to reach the queue. The slots are then freed
    // BEFORE anything is asserted, so a version that queues the upload instead
    // of refusing it completes and fails on the status rather than hanging.
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([...holders, filler]);

    const res = await pending;
    expect(res.status, 'busy, not broken').toBe(503);
    expect(res.headers.get('retry-after'), 'with something to act on').toBe('5');
    const body = await res.json() as { error: string };
    expect(body.error, 'and no suggestion the document is at fault').not.toMatch(/corrupt/i);
  });

  it('POST /api/uploads refuses a document that explodes when opened, and says so', async () => {
    // The per-plan byte ceiling above cannot catch this one: the file is a few
    // tens of KB, far inside the free allowance, and becomes ~30M characters
    // once DOCX decompression is done with it. Without the extraction ceiling
    // that text goes straight into SQLite and then into every run that reads
    // the attachment.
    const alice = await login('Alice');
    const bytes = await expandingDocx();
    expect(bytes.length, 'size alone would wave this through').toBeLessThan(5 * 1024 * 1024);

    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice },
      body: JSON.stringify({ mime: DOCX_MIME, filename: 'bomb.docx', dataBase64: bytes.toString('base64') }),
    });

    // 413 and a size remedy — NOT the 422 "scanned, encrypted, or corrupt" that
    // the route gives every other parse failure. The file read perfectly well;
    // telling this user to check it for corruption would send them looking for
    // a problem that does not exist.
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/characters of text once extracted/);
    expect(body.error).toMatch(/Split it into smaller files/);
    expect(body.error, 'and not the corruption message').not.toMatch(/corrupt/i);
  }, 60_000);

  it('MCP servers: add validates the URL, redacts auth, lists, toggles, deletes', async () => {
    const alice = await login('Alice');
    const hdr = { 'Content-Type': 'application/json', Cookie: alice };

    // SSRF/loopback rejected.
    const bad = await fetch(`${baseUrl}/api/mcp/servers`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ name: 'Local', url: 'https://127.0.0.1/mcp' }),
    });
    expect(bad.status).toBe(400);

    // Valid add via the github connector preset (fixed url + token).
    const added = await fetch(`${baseUrl}/api/mcp/servers`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ connectorId: 'github', token: 'ghp_secret' }),
    });
    expect(added.status).toBe(200);
    const { server } = await added.json();
    expect(server.hasAuth).toBe(true);

    // Listing never leaks the token.
    const list = await fetch(`${baseUrl}/api/mcp/servers`, { headers: { Cookie: alice } });
    const listText = await list.text();
    expect(listText).not.toContain('ghp_secret');

    // Toggle + delete.
    const patch = await fetch(`${baseUrl}/api/mcp/servers/${server.id}`, {
      method: 'PATCH', headers: hdr, body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    const del = await fetch(`${baseUrl}/api/mcp/servers/${server.id}`, { method: 'DELETE', headers: { Cookie: alice } });
    expect((await del.json()).ok).toBe(true);
  });

  // ── Native auth (desktop/CLI) ──

  async function devLoginCookie(name: string): Promise<string> {
    const res = await fetch(`${baseUrl}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    return extractCookie(res, SESSION_COOKIE_NAME)!;
  }
  const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('device flow: start → approve (web-authed) → poll → tokens → Bearer works → refresh rotates', async () => {
    const cookie = await devLoginCookie('Device Dana');

    const start = await jsonPost('/api/native/device', {});
    expect(start.status).toBe(200);
    const dev = await start.json();
    expect(dev.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(dev.verification_uri).toContain('/activate');

    // Approving requires a web session.
    expect((await jsonPost('/api/native/device/approve', { user_code: dev.user_code })).status).toBe(401);
    const approve = await jsonPost('/api/native/device/approve', { user_code: dev.user_code }, { Cookie: cookie });
    expect((await approve.json()).ok).toBe(true);

    // One poll (first poll is never slow_down) → tokens.
    const tok = await jsonPost('/api/native/device/token', { device_code: dev.device_code });
    expect(tok.status).toBe(200);
    const tokens = await tok.json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // The access token authenticates as a Bearer on an existing route.
    const me = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect((await me.json()).user?.name).toBe('Device Dana');

    // Refresh rotates: old refresh token becomes invalid.
    const refreshed = await jsonPost('/api/native/refresh', { refresh_token: tokens.refresh_token });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next.access_token).toBeTruthy();
    expect((await jsonPost('/api/native/refresh', { refresh_token: tokens.refresh_token })).status).toBe(401);

    // Logout revokes the current refresh token.
    await jsonPost('/api/native/logout', { refresh_token: next.refresh_token });
    expect((await jsonPost('/api/native/refresh', { refresh_token: next.refresh_token })).status).toBe(401);
  });

  it('device poll reports authorization_pending before approval', async () => {
    const dev = await (await jsonPost('/api/native/device', {})).json();
    const poll = await jsonPost('/api/native/device/token', { device_code: dev.device_code });
    expect(poll.status).toBe(428);
    expect((await poll.json()).error).toBe('authorization_pending');
  });

  it('native loopback start validates the redirect + PKCE challenge', async () => {
    // Non-loopback redirect is rejected.
    const bad = await fetch(`${baseUrl}/auth/native/github?redirect_uri=${encodeURIComponent('https://evil.com/cb')}&code_challenge=abc`, { redirect: 'manual' });
    expect(bad.status).toBe(400);
    // A bad one-time code can't be redeemed.
    expect((await jsonPost('/api/native/token', { code: 'nope', code_verifier: 'x' })).status).toBe(400);
  });

  it('GET /activate serves a self-contained page', async () => {
    const res = await fetch(`${baseUrl}/activate`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Activate a device');
  });
});
