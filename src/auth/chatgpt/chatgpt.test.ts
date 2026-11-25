import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import {
  ChatGptAuth, needsRefresh, type ChatGptAuthDeps,
} from './manager.js';
import { buildAuthorizeUrl, exchangeCodeForm, newPkce, pkceChallenge, redactAuthorizeUrl, refreshForm, startLoopback } from './oauth.js';
import { resetDiscoveryCache, validateIdToken } from './oidc.js';
import { getHostId, readStore, updateStore, type ChatGptAccount } from './store.js';
import { withAsyncLock } from './lock.js';
import { ownerToken } from '../../utils/file-lock.js';
import { ChatGptAuthError } from './errors.js';
import { ACCOUNTS_FILE, CHATGPT_RESOURCE, PLAN_USAGE_SCOPE } from './constants.js';

const ISSUER = 'https://auth.openai.com';
const CLIENT = 'oaiapp_test123';
const ALL_SCOPES = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

let dir: string;
let keys: { privateKey: CryptoKey; jwks: JWTVerifyGetKey; other: CryptoKey };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chatgpt-'));
  resetDiscoveryCache();
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'k1', use: 'sig' };
  keys = { privateKey: pair.privateKey, other: other.privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function idToken(o: { sub?: string; aud?: string; nonce?: string; iss?: string; exp?: number; email?: string; key?: CryptoKey } = {}): Promise<string> {
  return new SignJWT({ email: o.email ?? 'ana@example.com', ...(o.nonce !== undefined ? { nonce: o.nonce } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? CLIENT)
    .setSubject(o.sub ?? 'sub-1')
    .setIssuedAt()
    .setExpirationTime(o.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(o.key ?? keys.privateKey);
}

// ── A fake OpenAI: discovery, token, revocation ──

interface Fake {
  fetch: NonNullable<ChatGptAuthDeps['fetch']>;
  calls: Array<{ url: string; body: URLSearchParams }>;
  tokenResponses: Array<() => Response>;
  revocations: Array<() => Response>;
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fake(): Fake {
  const f: Fake = {
    calls: [], tokenResponses: [], revocations: [],
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return json(200, {
          issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`,
          revocation_endpoint: `${ISSUER}/oauth/revoke`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
        });
      }
      const body = new URLSearchParams(String(init?.body ?? ''));
      f.calls.push({ url, body });
      if (url.endsWith('/oauth/revoke')) return (f.revocations.shift() ?? (() => new Response('', { status: 200 })))();
      if (url.endsWith('/oauth/token')) {
        const next = f.tokenResponses.shift();
        if (!next) throw new Error('unexpected token request');
        return next();
      }
      throw new Error(`unexpected ${url}`);
    },
  };
  return f;
}

function auth(f: Fake, extra: Partial<ChatGptAuthDeps> = {}): ChatGptAuth {
  return new ChatGptAuth({
    dir, fetch: f.fetch, jwks: keys.jwks, sleep: async () => undefined,
    loopback: { preferredPort: 0, timeoutMs: 5_000 }, ...extra,
  });
}

/** Plays the browser: opens the authorize URL's redirect with the given callback. */
function browser(reply: (u: URL) => Record<string, string>) {
  const seen: URL[] = [];
  return {
    seen,
    openUrl: async (url: string) => {
      const u = new URL(url);
      seen.push(u);
      const cb = new URL(u.searchParams.get('redirect_uri')!);
      for (const [k, v] of Object.entries(reply(u))) cb.searchParams.set(k, v);
      // After the listener is up and this call returns.
      setTimeout(() => { void fetch(cb).catch(() => undefined); }, 5);
    },
  };
}

// ── Host ID ──

describe('host ID', () => {
  it('is a urn:uuid, stable across calls, and stored 0600', () => {
    const id = getHostId(dir);
    expect(id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(getHostId(dir)).toBe(id);
    expect(fs.statSync(path.join(dir, 'chatgpt-host.json')).mode & 0o777).toBe(0o600);
  });
});

// ── The authorize URL ──

describe('authorize URL', () => {
  const base = { redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 's t', nonce: 'n&1', codeChallenge: 'cc', hostId: 'urn:uuid:abc' };

  it('first registration: dynamic client, agent_name_hint, exact params, encoded', () => {
    const u = new URL(buildAuthorizeUrl({ ...base, agentNameHint: 'Cascade' }));
    expect(`${u.origin}${u.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
    const p = u.searchParams;
    expect(p.get('client_id')).toBe('dynamic_agent_client');
    expect(p.get('agent_name_hint')).toBe('Cascade');
    expect(p.get('ext_agent_host_id')).toBe('urn:uuid:abc');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    expect(p.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    expect(p.get('resource')).toBe('https://api.openai.com/v1');
    expect(p.get('state')).toBe('s t');
    expect(p.get('nonce')).toBe('n&1');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBe('cc');
    expect(p.has('id_token_hint')).toBe(false);
    expect(p.has('prompt')).toBe(false);
    expect(u.search).toContain('state=s+t');
    expect(u.search).toContain('nonce=n%261');
    expect(u.search).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback');
    expect(u.search).not.toContain('localhost');
  });

  it('returning account: saved client ID, hints, and NO agent_name_hint', () => {
    const u = new URL(buildAuthorizeUrl({ ...base, clientId: CLIENT, agentNameHint: 'Cascade', idTokenHint: 'a.b.c', loginHint: 'ana@example.com' }));
    expect(u.searchParams.get('client_id')).toBe(CLIENT);
    expect(u.searchParams.has('agent_name_hint')).toBe(false);
    expect(u.searchParams.get('id_token_hint')).toBe('a.b.c');
    expect(u.searchParams.get('login_hint')).toBe('ana@example.com');
    expect(u.search).toContain('login_hint=ana%40example.com');
  });

  it('asks for consent again only when told to', () => {
    expect(new URL(buildAuthorizeUrl({ ...base, clientId: CLIENT, forceConsent: true })).searchParams.get('prompt')).toBe('consent');
  });

  it('redacts the ID-token hint for logs', () => {
    const url = buildAuthorizeUrl({ ...base, clientId: CLIENT, idTokenHint: 'secret.jwt.value' });
    expect(redactAuthorizeUrl(url)).not.toContain('secret.jwt.value');
    expect(redactAuthorizeUrl(url)).toContain('id_token_hint=%5Bredacted%5D');
  });

  it('PKCE challenge is the unpadded base64url SHA-256 of the verifier', () => {
    const p = newPkce();
    expect(p.challenge).toBe(pkceChallenge(p.verifier));
    expect(p.challenge).not.toMatch(/[=+/]/);
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('loopback listener', () => {
  it('binds 127.0.0.1 with the /auth/callback path and falls back when the port is taken', async () => {
    const first = await startLoopback({ preferredPort: 0, timeoutMs: 2000 });
    const second = await startLoopback({ preferredPort: first.port, timeoutMs: 2000 });
    expect(first.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(second.port).not.toBe(first.port);
    const wrongPath = await fetch(`http://127.0.0.1:${first.port}/callback?code=x`);
    expect(wrongPath.status).toBe(404);
    first.close(); second.close();
  });
});

// ── Token exchange body ──

describe('token requests', () => {
  it('code exchange carries the issued client, verifier, same redirect and the resource, no secret', () => {
    const f = exchangeCodeForm({ clientId: CLIENT, code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:1455/auth/callback' });
    expect(Object.fromEntries(f)).toEqual({
      grant_type: 'authorization_code', client_id: CLIENT, code: 'c', code_verifier: 'v',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: CHATGPT_RESOURCE,
    });
  });
  it('refresh sends the saved client, the refresh token and the resource, and no scope', () => {
    const f = refreshForm({ clientId: CLIENT, refreshToken: 'rt' });
    expect(Object.fromEntries(f)).toEqual({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: 'rt', resource: CHATGPT_RESOURCE });
  });
});

// ── ID-token validation ──

describe('ID-token validation', () => {
  it('accepts a good token', async () => {
    const v = await validateIdToken({ idToken: await idToken({ nonce: 'n' }), clientId: CLIENT, nonce: 'n', jwks: keys.jwks });
    expect(v).toMatchObject({ subject: 'sub-1', email: 'ana@example.com' });
  });
  it('rejects a bad signature', async () => {
    await expect(validateIdToken({ idToken: await idToken({ nonce: 'n', key: keys.other }), clientId: CLIENT, nonce: 'n', jwks: keys.jwks })).rejects.toThrow(ChatGptAuthError);
  });
  it('rejects the wrong audience', async () => {
    await expect(validateIdToken({ idToken: await idToken({ nonce: 'n', aud: 'oaiapp_other' }), clientId: CLIENT, nonce: 'n', jwks: keys.jwks })).rejects.toThrow(/not accepted/);
  });
  it('rejects the wrong issuer', async () => {
    await expect(validateIdToken({ idToken: await idToken({ nonce: 'n', iss: 'https://evil.example' }), clientId: CLIENT, nonce: 'n', jwks: keys.jwks })).rejects.toThrow(/not accepted/);
  });
  it('rejects a nonce mismatch', async () => {
    await expect(validateIdToken({ idToken: await idToken({ nonce: 'other' }), clientId: CLIENT, nonce: 'n', jwks: keys.jwks })).rejects.toThrow(/nonce/);
  });
  it('rejects an expired token', async () => {
    const exp = Math.floor(Date.now() / 1000) - 3600;
    await expect(validateIdToken({ idToken: await idToken({ nonce: 'n', exp }), clientId: CLIENT, nonce: 'n', jwks: keys.jwks })).rejects.toThrow(/not accepted/);
  });
  it('fetches the key set named by discovery when none is injected', async () => {
    const f = fake();
    const jwk = { ...(await exportJWK((await generateKeyPair('RS256')).publicKey)) };
    void jwk;
    const seen: string[] = [];
    await expect(validateIdToken({
      idToken: await idToken({ nonce: 'n' }), clientId: CLIENT, nonce: 'n',
      fetch: async (u, i) => { seen.push(String(u)); return f.fetch(u, i); },
    })).rejects.toBeInstanceOf(ChatGptAuthError); // the fake serves no /jwks
    expect(seen[0]).toContain('/.well-known/openid-configuration');
  });
});

// ── Sign-in, end to end against a fake OpenAI ──

describe('sign-in', () => {
  async function run(reply: (u: URL) => Record<string, string>, opts: { accountId?: string; respond?: (nonce: string) => Promise<Response> } = {}, f = fake()) {
    let nonce = '';
    f.tokenResponses.push(async () => { throw new Error('unused'); });
    f.tokenResponses.length = 0;
    const b = browser(reply);
    const a = auth(f, {
      fetch: async (input, init) => {
        if (String(input).endsWith('/oauth/token') && opts.respond) {
          f.calls.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
          return opts.respond(nonce);
        }
        return f.fetch(input, init);
      },
    });
    const result = a.signIn({
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      openUrl: async (url) => { nonce = new URL(url).searchParams.get('nonce')!; await b.openUrl(url); },
    });
    return { a, f, b, result };
  }
  const goodReply = (u: URL, extra: Record<string, string> = {}) => ({ code: 'code-1', state: u.searchParams.get('state')!, client_id: CLIENT, ...extra });
  const goodTokens = (o: { sub?: string; aud?: string; scope?: string } = {}) => async (nonce: string) => json(200, {
    access_token: 'at-1', refresh_token: 'rt-1', id_token: await idToken({ nonce, sub: o.sub ?? 'sub-1', aud: o.aud ?? CLIENT }),
    token_type: 'Bearer', expires_in: 3600, scope: o.scope ?? ALL_SCOPES,
  });

  it('registers a new account: dynamic client out, issued client saved, welcome due, record shaped per spec, 0600', async () => {
    const { a, f, b, result } = await run((u) => goodReply(u), { respond: goodTokens() });
    const r = await result;
    const u = b.seen[0]!;
    expect(u.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(u.searchParams.get('agent_name_hint')).toBe('Cascade');
    expect(u.searchParams.get('ext_agent_host_id')).toBe(a.hostId());
    expect(new URL(u.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
    expect(new URL(u.searchParams.get('redirect_uri')!).pathname).toBe('/auth/callback');
    // The exchange used the ISSUED client and the same redirect URI.
    expect(f.calls[0]!.body.get('client_id')).toBe(CLIENT);
    expect(f.calls[0]!.body.get('redirect_uri')).toBe(u.searchParams.get('redirect_uri'));
    expect(f.calls[0]!.body.get('code_challenge')).toBeNull();
    expect(pkceChallenge(f.calls[0]!.body.get('code_verifier')!)).toBe(u.searchParams.get('code_challenge'));
    expect(r).toMatchObject({ planUsageEnabled: true, showWelcome: true, newRegistration: true });
    const rec = readStore(dir).accounts[0]!;
    expect(rec).toMatchObject({
      email: 'ana@example.com', issuer: ISSUER, subject: 'sub-1', client_id: CLIENT, ext_agent_host_id: a.hostId(),
      access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600,
    });
    expect(rec.scopes).toContain(PLAN_USAGE_SCOPE);
    expect(Date.parse(rec.saved_at)).not.toBeNaN();
    expect(fs.statSync(path.join(dir, ACCOUNTS_FILE)).mode & 0o777).toBe(0o600);
    expect(a.status().welcomePending).toBe(true);
    a.markWelcomeShown();
    expect(a.status().welcomePending).toBe(false);
  });

  it('rejects a state mismatch without exchanging the code', async () => {
    const { f, result } = await run((u) => goodReply(u, { state: 'wrong' }), { respond: goodTokens() });
    await expect(result).rejects.toMatchObject({ kind: 'invalid_callback' });
    expect(f.calls).toHaveLength(0);
    expect(readStore(dir).accounts).toHaveLength(0);
  });

  it('stops on access_denied without exchanging a code', async () => {
    const { f, result } = await run((u) => ({ error: 'access_denied', state: u.searchParams.get('state')! }), { respond: goodTokens() });
    await expect(result).rejects.toMatchObject({ kind: 'access_denied' });
    expect(f.calls).toHaveLength(0);
  });

  it('treats a new registration with no issued client_id as incomplete', async () => {
    const { f, result } = await run((u) => ({ code: 'c', state: u.searchParams.get('state')! }), { respond: goodTokens() });
    await expect(result).rejects.toMatchObject({ kind: 'invalid_callback' });
    expect(f.calls).toHaveLength(0);
  });

  it('never accepts dynamic_agent_client as the issued ID', async () => {
    const { result } = await run((u) => goodReply(u, { client_id: 'dynamic_agent_client' }), { respond: goodTokens() });
    await expect(result).rejects.toMatchObject({ kind: 'invalid_callback' });
  });

  it('rejects an ID token with the wrong audience, signature or nonce', async () => {
    await expect((await run((u) => goodReply(u), { respond: goodTokens({ aud: 'oaiapp_other' }) })).result).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect((await run((u) => goodReply(u), { respond: async () => json(200, { access_token: 'a', refresh_token: 'r', id_token: await idToken({ nonce: 'stale' }), expires_in: 3600, scope: ALL_SCOPES }) })).result).rejects.toThrow(/nonce/);
    expect(readStore(dir).accounts).toHaveLength(0);
  });

  it('keeps the sign-in but disables plan usage when the scope was not granted', async () => {
    const { a, result } = await run((u) => goodReply(u), { respond: goodTokens({ scope: 'email offline_access openid profile resource.invoke' }) });
    const r = await result;
    expect(r).toMatchObject({ planUsageEnabled: false, showWelcome: false });
    expect(a.planReady()).toBe(false);
    await expect(a.getAccessToken()).rejects.toMatchObject({ kind: 'sign_in_required' });
  });

  it('re-auth reuses the saved client, sends hints, omits agent_name_hint, and rejects a different client in the callback', async () => {
    const first = await run((u) => goodReply(u), { respond: goodTokens() });
    await first.result;
    const a = first.a;
    const b = browser((u) => goodReply(u));
    let nonce = '';
    const again = auth(first.f, { fetch: async (i, init) => String(i).endsWith('/oauth/token') ? goodTokens()(nonce) : first.f.fetch(i, init) });
    await again.signIn({ accountId: CLIENT, openUrl: async (url) => { nonce = new URL(url).searchParams.get('nonce')!; await b.openUrl(url); } });
    const u = b.seen[0]!;
    expect(u.searchParams.get('client_id')).toBe(CLIENT);
    expect(u.searchParams.has('agent_name_hint')).toBe(false);
    expect(u.searchParams.get('login_hint')).toBe('ana@example.com');
    expect(u.searchParams.get('id_token_hint')).toBeTruthy();
    expect(readStore(dir).accounts).toHaveLength(1);

    const bad = browser((uu) => goodReply(uu, { client_id: 'oaiapp_someone_else' }));
    await expect(again.signIn({ accountId: CLIENT, openUrl: bad.openUrl })).rejects.toMatchObject({ kind: 'invalid_callback' });
    void a;
  });

  it('re-auth as a different person changes nothing', async () => {
    const first = await run((u) => goodReply(u), { respond: goodTokens() });
    await first.result;
    const before = JSON.stringify(readStore(dir));
    let nonce = '';
    const b = browser((u) => goodReply(u));
    const again = auth(first.f, { fetch: async (i, init) => String(i).endsWith('/oauth/token') ? goodTokens({ sub: 'sub-2' })(nonce) : first.f.fetch(i, init) });
    await expect(again.signIn({ accountId: CLIENT, openUrl: async (url) => { nonce = new URL(url).searchParams.get('nonce')!; await b.openUrl(url); } }))
      .rejects.toMatchObject({ kind: 'invalid_response' });
    expect(JSON.stringify(readStore(dir))).toBe(before);
  });

  it('keeps registrations apart: two clients, one email, never mixed', async () => {
    const f = fake();
    const one = await run((u) => goodReply(u), { respond: goodTokens() }, f);
    await one.result;
    const two = await run((u) => goodReply(u, { client_id: 'oaiapp_second' }), { respond: goodTokens({ aud: 'oaiapp_second', sub: 'sub-9' }) }, f);
    await two.result;
    const s = readStore(dir);
    expect(s.accounts.map((x) => x.client_id).sort()).toEqual([CLIENT, 'oaiapp_second'].sort());
    expect(s.active).toBe('oaiapp_second');
    const st = two.a.status();
    expect(new Set(st.accounts.map((x) => x.label)).size).toBe(2);
    expect(two.a.switchAccount(CLIENT).switched).toBe(true);
    expect(readStore(dir).active).toBe(CLIENT);
    expect(s.accounts.find((x) => x.client_id === CLIENT)!.subject).toBe('sub-1');
  });

  describe('a registration OpenAI no longer recognises (invalid_client)', () => {
    const seedDead = async (): Promise<Fake> => {
      updateStore(dir, (st) => {
        st.accounts.push({
          email: 'ana@example.com', issuer: ISSUER, subject: 'sub-1', client_id: CLIENT, ext_agent_host_id: 'urn:uuid:x',
          id_token: 'old.id.token', access_token: 'at-old', refresh_token: 'rt-old', token_type: 'Bearer', expires_in: 3600,
          scopes: ALL_SCOPES.split(' '), saved_at: new Date(Date.now() - 3_500_000).toISOString(),
        });
        st.active = CLIENT;
      });
      const f = fake();
      f.tokenResponses.push(() => json(401, { error: 'invalid_client' }));
      await expect(auth(f).getAccessToken()).rejects.toMatchObject({ kind: 'invalid_client' });
      return f;
    };

    it('is remembered, so the account no longer reads as signed in', async () => {
      await seedDead();
      const rec = readStore(dir).accounts[0]!;
      expect(rec).toMatchObject({ registration_invalid: true, needs_sign_in: true, signed_out_reason: 'registration_invalid' });
      expect(rec.refresh_token).toBeUndefined();
      const pub = auth(fake()).status().active!;
      expect(pub).toMatchObject({ signedIn: false, needsSignIn: true, registrationInvalid: true });
    });

    it('signing in registers afresh with dynamic_agent_client under the same host ID, and replaces the dead registration', async () => {
      const f = await seedDead();
      const hostBefore = auth(f).hostId();
      const r = await run((u) => goodReply(u, { client_id: 'oaiapp_fresh' }), { accountId: CLIENT, respond: goodTokens({ aud: 'oaiapp_fresh' }) }, f);
      const out = await r.result;
      const u = r.b.seen[0]!;
      expect(u.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(u.searchParams.get('agent_name_hint')).toBe('Cascade');
      expect(u.searchParams.get('ext_agent_host_id')).toBe(hostBefore);
      expect(u.searchParams.has('id_token_hint')).toBe(false);
      expect(u.searchParams.has('login_hint')).toBe(false); // hints are for re-authorizing a live client
      expect(out).toMatchObject({ newRegistration: true, planUsageEnabled: true });
      const st = readStore(dir);
      expect(st.accounts.map((a) => a.client_id)).toEqual(['oaiapp_fresh']);
      expect(st.active).toBe('oaiapp_fresh');
      expect(st.accounts[0]!.registration_invalid).toBeUndefined();
      expect(st.accounts[0]!.ext_agent_host_id).toBe(hostBefore);
    });

    it('a different person signing in does not retire the dead registration', async () => {
      const f = await seedDead();
      const r = await run((u) => goodReply(u, { client_id: 'oaiapp_other' }), { accountId: CLIENT, respond: goodTokens({ aud: 'oaiapp_other', sub: 'sub-9' }) }, f);
      await r.result;
      expect(readStore(dir).accounts.map((a) => a.client_id).sort()).toEqual([CLIENT, 'oaiapp_other'].sort());
    });
  });
});

// ── The store ──

describe('store', () => {
  const rec = (id: string): ChatGptAccount => ({
    email: 'a@b.c', issuer: ISSUER, subject: `s-${id}`, client_id: id, ext_agent_host_id: 'urn:uuid:x', access_token: 'at',
    refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600, scopes: [PLAN_USAGE_SCOPE], saved_at: new Date().toISOString(),
  });
  it('writes atomically at 0600 with several accounts and no leftover temp file', () => {
    updateStore(dir, (s) => { s.accounts.push(rec('a'), rec('b')); s.active = 'b'; });
    const file = path.join(dir, ACCOUNTS_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readStore(dir).accounts.map((a) => a.client_id)).toEqual(['a', 'b']);
    expect(readStore(dir).active).toBe('b');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('refuses to overwrite a file it cannot read', () => {
    fs.writeFileSync(path.join(dir, ACCOUNTS_FILE), '{not json');
    expect(() => updateStore(dir, (s) => { s.accounts.push(rec('a')); })).toThrow(/cannot be read/);
    expect(fs.readFileSync(path.join(dir, ACCOUNTS_FILE), 'utf-8')).toBe('{not json');
  });
});

// ── Refresh ──

describe('refresh', () => {
  const seed = (over: Partial<ChatGptAccount> = {}, now = Date.now()): void => {
    updateStore(dir, (s) => {
      s.accounts.push({
        email: 'ana@example.com', issuer: ISSUER, subject: 'sub-1', client_id: CLIENT, ext_agent_host_id: 'urn:uuid:x',
        id_token: 'old.id.token', access_token: 'at-old', refresh_token: 'rt-old', token_type: 'Bearer', expires_in: 3600,
        scopes: ALL_SCOPES.split(' '), saved_at: new Date(now - 3_500_000).toISOString(), ...over,
      });
      s.active = CLIENT;
    });
  };
  const refreshed = (over: Record<string, unknown> = {}) => () => json(200, {
    access_token: 'at-new', refresh_token: 'rt-new', token_type: 'Bearer', expires_in: 3600,
    scope: ALL_SCOPES, earliest_refresh_at: new Date(Date.now() + 3_000_000).toISOString(), ...over,
  });

  it('does not refresh a token with plenty of life left', async () => {
    seed({ saved_at: new Date().toISOString() });
    const f = fake();
    expect((await auth(f).getAccessToken()).accessToken).toBe('at-old');
    expect(f.calls).toHaveLength(0);
  });

  it('refreshes near expiry and replaces access token, refresh token, expiry and scopes together', async () => {
    seed({ scopes: [PLAN_USAGE_SCOPE] });
    const f = fake();
    f.tokenResponses.push(refreshed({ expires_in: 1800 }));
    const t = await auth(f).getAccessToken();
    expect(t.accessToken).toBe('at-new');
    expect(Object.fromEntries(f.calls[0]!.body)).toEqual({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: 'rt-old', resource: CHATGPT_RESOURCE });
    const rec = readStore(dir).accounts[0]!;
    expect(rec).toMatchObject({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 1800 });
    expect(rec.scopes).toEqual(ALL_SCOPES.split(' ').sort());
    expect(rec.client_id).toBe(CLIENT);
  });

  it('honours earliest_refresh_at before expiry, but never past it', () => {
    const now = Date.now();
    const base = { saved_at: new Date(now - 3_400_000).toISOString(), expires_in: 3600, access_token: 'x' };
    expect(needsRefresh({ ...base, earliest_refresh_at: new Date(now + 60_000).toISOString() }, now)).toBe(false);
    expect(needsRefresh({ ...base, earliest_refresh_at: new Date(now - 1).toISOString() }, now)).toBe(true);
    expect(needsRefresh({ ...base, saved_at: new Date(now - 3_590_000).toISOString(), earliest_refresh_at: new Date(now + 600_000).toISOString() }, now)).toBe(true);
  });

  it('two concurrent refreshers, in separate instances (processes), make ONE network refresh', async () => {
    seed();
    const f = fake();
    f.tokenResponses.push(refreshed());
    const [a, b] = await Promise.all([auth(f).getAccessToken(), auth(f).getAccessToken()]);
    expect(a.accessToken).toBe('at-new');
    expect(b.accessToken).toBe('at-new');
    expect(f.calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(1);
  });

  it('a terminal error clears the tokens and marks the account as needing sign-in', async () => {
    for (const code of ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated', 'invalid_refresh_token', 'token_expired']) {
      fs.rmSync(path.join(dir, ACCOUNTS_FILE), { force: true });
      seed();
      const f = fake();
      f.tokenResponses.push(() => json(400, { error: code }));
      await expect(auth(f).getAccessToken()).rejects.toMatchObject({ kind: 'sign_in_required' });
      const rec = readStore(dir).accounts[0]!;
      expect(rec.access_token).toBeUndefined();
      expect(rec.refresh_token).toBeUndefined();
      expect(rec).toMatchObject({ needs_sign_in: true, client_id: CLIENT, signed_out_reason: 'refresh_failed' });
      expect(auth(f).status().active?.needsSignIn).toBe(true);
    }
  });

  it('reads nested error codes too', async () => {
    seed();
    const f = fake();
    f.tokenResponses.push(() => json(401, { error: { code: 'refresh_token_expired', message: 'gone' } }));
    await expect(auth(f).getAccessToken()).rejects.toMatchObject({ kind: 'sign_in_required' });
  });

  it('a network failure or 5xx erases nothing', async () => {
    seed();
    const before = JSON.stringify(readStore(dir));
    const f = fake();
    f.tokenResponses.push(() => json(503, { error: 'server_error' }));
    await expect(auth(f).getAccessToken()).rejects.toMatchObject({ kind: 'transient' });
    f.tokenResponses.push(() => { throw new TypeError('fetch failed'); });
    await expect(auth(f).getAccessToken()).rejects.toMatchObject({ kind: 'transient' });
    expect(JSON.stringify(readStore(dir))).toBe(before);
  });

  it('invalid_client marks the registration invalid (the tokens belong to a client OpenAI forgot)', async () => {
    seed();
    const f = fake();
    f.tokenResponses.push(() => json(401, { error: 'invalid_client' }));
    await expect(auth(f).getAccessToken()).rejects.toMatchObject({ kind: 'invalid_client' });
    expect(readStore(dir).accounts[0]).toMatchObject({ registration_invalid: true, client_id: CLIENT });
  });

  it('a terminal error is not applied when another process already rotated the token', async () => {
    seed();
    const f = fake();
    f.tokenResponses.push(() => {
      // Meanwhile another process refreshed.
      updateStore(dir, (s) => { s.accounts[0]!.refresh_token = 'rt-rotated'; s.accounts[0]!.saved_at = new Date().toISOString(); });
      return json(400, { error: 'refresh_token_reused' });
    });
    const t = await auth(f).getAccessToken();
    expect(t.account.signedIn).toBe(true);
    expect(readStore(dir).accounts[0]!.refresh_token).toBe('rt-rotated');
  });

  it('serialises on a lock file and takes over one left by a dead process', async () => {
    const lock = path.join(dir, 'x.lock');
    fs.writeFileSync(lock, ownerToken(2 ** 22 + 1));
    let ran = false;
    await withAsyncLock(lock, async () => { ran = true; }, { waitMs: 1000 });
    expect(ran).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

// ── Sign-out ──

describe('sign-out', () => {
  const seed = (): void => {
    updateStore(dir, (s) => {
      s.accounts.push({
        email: 'ana@example.com', issuer: ISSUER, subject: 'sub-1', client_id: CLIENT, ext_agent_host_id: 'urn:uuid:x',
        id_token: 'id', access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600,
        scopes: ALL_SCOPES.split(' '), saved_at: new Date().toISOString(),
      });
      s.active = CLIENT;
    });
  };

  it('revokes the refresh token at the discovered endpoint, then clears tokens but keeps the mapping and host ID', async () => {
    seed();
    const f = fake();
    const a = auth(f);
    const host = a.hostId();
    const r = await a.signOut();
    expect(r.revocation).toBe('confirmed');
    expect(Object.fromEntries(f.calls[0]!.body)).toEqual({ token: 'rt', token_type_hint: 'refresh_token', client_id: CLIENT });
    expect(f.calls[0]!.url).toBe(`${ISSUER}/oauth/revoke`);
    const rec = readStore(dir).accounts[0]!;
    expect(rec).toMatchObject({ client_id: CLIENT, subject: 'sub-1', email: 'ana@example.com', needs_sign_in: true });
    expect(rec.access_token ?? rec.refresh_token ?? rec.id_token).toBeUndefined();
    expect(readStore(dir).active).toBeUndefined();
    expect(a.hostId()).toBe(host);
  });

  it('retries a 5xx with backoff and succeeds', async () => {
    seed();
    const f = fake();
    f.revocations.push(() => new Response('', { status: 503 }), () => new Response('', { status: 500 }));
    const waits: number[] = [];
    const r = await auth(f, { sleep: async (ms) => { waits.push(ms); } }).signOut();
    expect(r.revocation).toBe('confirmed');
    expect(waits.length).toBe(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });

  it('says so when revocation could not be confirmed, and still clears locally', async () => {
    seed();
    const f = fake();
    f.revocations.push(...Array.from({ length: 5 }, () => () => new Response('', { status: 503 })));
    const r = await auth(f).signOut();
    expect(r.revocation).toBe('not_confirmed');
    expect(r.message).toMatch(/could not confirm/i);
    expect(readStore(dir).accounts[0]!.refresh_token).toBeUndefined();
  });

  it('switches the active account to another signed-in one', async () => {
    seed();
    updateStore(dir, (s) => { s.accounts.push({ ...s.accounts[0]!, client_id: 'oaiapp_b', subject: 'sub-b' }); });
    const r = await auth(fake()).signOut(CLIENT);
    expect(r.revocation).toBe('confirmed');
    expect(readStore(dir).active).toBe('oaiapp_b');
  });
});

// ── Export / import ──

describe('moving an account to a machine with no browser', () => {
  it('imports under the importing host\'s own host ID', async () => {
    updateStore(dir, (s) => {
      s.accounts.push({
        email: 'ana@example.com', issuer: ISSUER, subject: 'sub-1', client_id: CLIENT, ext_agent_host_id: 'urn:uuid:laptop',
        access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600, scopes: ALL_SCOPES.split(' '), saved_at: new Date().toISOString(),
      });
      s.active = CLIENT;
    });
    const exported = auth(fake()).exportAccount();
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-chatgpt-vm-'));
    try {
      const vm = new ChatGptAuth({ dir: dir2, fetch: fake().fetch });
      const vmHost = vm.hostId();
      const pub = vm.importAccount(JSON.parse(JSON.stringify(exported)));
      expect(pub).toMatchObject({ id: CLIENT, active: true, signedIn: true });
      const rec = readStore(dir2).accounts[0]!;
      expect(rec.ext_agent_host_id).toBe(vmHost);
      expect(rec.ext_agent_host_id).not.toBe('urn:uuid:laptop');
      expect(rec.refresh_token).toBe('rt');
      expect(() => vm.importAccount({ format: 'nope' })).toThrow(/not a Cascade ChatGPT account export/);
      expect(() => vm.importAccount({ ...exported, account: { ...exported.account, client_id: 'dynamic_agent_client' } })).toThrow(/client ID/);
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  });
});
