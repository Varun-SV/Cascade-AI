// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT: the OAuth pieces
// ─────────────────────────────────────────────
//
//  Authorization URL, PKCE, the loopback listener, and the three requests to
//  the token and revocation endpoints. No state is kept here; sign-in,
//  refresh and sign-out orchestrate these in manager.ts.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CALLBACK_HOST, CALLBACK_PATH, CHATGPT_AUTHORIZE_URL, CHATGPT_RESOURCE, CHATGPT_SCOPES, CHATGPT_TOKEN_URL,
  DYNAMIC_CLIENT_ID, PREFERRED_CALLBACK_PORT,
} from './constants.js';
import { ChatGptAuthError } from './errors.js';
import type { FetchLike } from './oidc.js';

// ── PKCE, state, nonce ───────────────────────

export interface Pkce { verifier: string; challenge: string }

const b64url = (b: Buffer): string => b.toString('base64url');

/** A fresh verifier (43 chars of base64url) and its S256 challenge. */
export function newPkce(): Pkce {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** The base64url SHA-256 digest of the verifier, without padding. */
export function pkceChallenge(verifier: string): string {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

/** A random value for `state` or `nonce`. */
export function randomToken(): string {
  return b64url(crypto.randomBytes(24));
}

// ── The authorization request ────────────────

export interface AuthorizeParams {
  /** The saved issued client ID, for a returning account; omitted for a new registration. */
  clientId?: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  hostId: string;
  /** First registration only. */
  agentNameHint?: string;
  /** Re-auth only: the retained ID token. Sent to the authorization endpoint and nowhere else. */
  idTokenHint?: string;
  loginHint?: string;
  /** The user explicitly chose to enable plan usage after declining or lacking the scope. */
  forceConsent?: boolean;
}

/**
 * The URL to open in the system browser. Every value is URL-encoded by
 * URLSearchParams. `agent_name_hint` is sent only with the dynamic client
 * (first registration); a saved client never gets it.
 */
export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const registering = !p.clientId;
  const q = new URLSearchParams();
  q.set('client_id', p.clientId ?? DYNAMIC_CLIENT_ID);
  if (registering && p.agentNameHint) q.set('agent_name_hint', p.agentNameHint);
  q.set('ext_agent_host_id', p.hostId);
  if (!registering && p.idTokenHint) q.set('id_token_hint', p.idTokenHint);
  if (!registering && p.loginHint) q.set('login_hint', p.loginHint);
  q.set('response_type', 'code');
  q.set('redirect_uri', p.redirectUri);
  q.set('scope', CHATGPT_SCOPES.join(' '));
  q.set('resource', CHATGPT_RESOURCE);
  q.set('state', p.state);
  q.set('nonce', p.nonce);
  q.set('code_challenge_method', 'S256');
  q.set('code_challenge', p.codeChallenge);
  if (p.forceConsent) q.set('prompt', 'consent');
  return `${CHATGPT_AUTHORIZE_URL}?${q.toString()}`;
}

/** The URL with its `id_token_hint` removed: the only form that may reach a log or a diagnostic. */
export function redactAuthorizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has('id_token_hint')) u.searchParams.set('id_token_hint', '[redacted]');
    return u.toString();
  } catch {
    return url.replace(/([?&]id_token_hint=)[^&]*/g, '$1[redacted]');
  }
}

export function carriesIdTokenHint(url: string): boolean {
  try { return new URL(url).searchParams.has('id_token_hint'); } catch { return /[?&]id_token_hint=/.test(url); }
}

// ── The loopback listener ────────────────────

export interface Loopback {
  port: number;
  /** `http://127.0.0.1:<port>/auth/callback`: the exact URI both requests use. */
  redirectUri: string;
  /** Resolves with the callback's query once; rejects on timeout or `close()`. */
  callback: Promise<URLSearchParams>;
  close(): void;
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>`
  + '<body style="font:16px system-ui;margin:15vh auto;max-width:28rem;text-align:center;color:#222">'
  + `<h2>${title}</h2><p>${body}</p></body>`;

/**
 * Listen on 127.0.0.1 (never `localhost`), on 1455 when it is free and on any
 * free port otherwise. Only `/auth/callback` is served, and only a request
 * whose Host is this listener: a page in the browser cannot reach it by
 * another name.
 */
export async function startLoopback(opts: {
  preferredPort?: number;
  timeoutMs?: number;
} = {}): Promise<Loopback> {
  const preferred = opts.preferredPort ?? PREFERRED_CALLBACK_PORT;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  let settle!: { resolve: (q: URLSearchParams) => void; reject: (e: Error) => void };
  const callback = new Promise<URLSearchParams>((resolve, reject) => { settle = { resolve, reject }; });
  // Never an unhandled rejection when nobody awaits the callback (a start-up failure).
  callback.catch(() => undefined);

  let port = 0;
  let done = false;
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? '';
    const url = new URL(req.url ?? '/', `http://${CALLBACK_HOST}:${port}`);
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || host !== `${CALLBACK_HOST}:${port}`) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    // The callback is single-use: a second request (a reload, a probe) is ignored.
    if (done) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(PAGE('Already received', 'You can close this tab and return to Cascade.'));
      return;
    }
    done = true;
    const failed = url.searchParams.has('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      .end(failed
        ? PAGE('Sign-in was not completed', 'You can close this tab and return to Cascade.')
        : PAGE('Signed in to Cascade', 'You can close this tab and return to Cascade.'));
    settle.resolve(url.searchParams);
  });

  const listen = (p: number): Promise<void> => new Promise((resolve, reject) => {
    const onError = (err: Error): void => { server.removeListener('listening', onListening); reject(err); };
    const onListening = (): void => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, CALLBACK_HOST);
  });

  try {
    await listen(preferred);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (err as NodeJS.ErrnoException).code !== 'EACCES') throw err;
    await listen(0);
  }
  port = (server.address() as AddressInfo).port;

  const timer = setTimeout(() => {
    if (!done) { done = true; settle.reject(new ChatGptAuthError('Timed out waiting for the browser sign-in.', 'timeout')); }
  }, timeoutMs);
  timer.unref();

  return {
    port,
    redirectUri: `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`,
    callback,
    close: () => {
      clearTimeout(timer);
      if (!done) { done = true; settle.reject(new ChatGptAuthError('Sign-in was cancelled.', 'cancelled')); }
      server.close();
      server.closeAllConnections?.();
    },
  };
}

// ── Token endpoint ───────────────────────────

/** A token response, parsed and checked for the fields every grant returns. */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  /** Space-separated granted scopes, when the endpoint says. */
  scope?: string;
  earliest_refresh_at?: string;
}

export interface OAuthFailure {
  status: number;
  /** The machine-readable code: `error` (string), or `error.code`, or `code`. */
  code?: string;
  description?: string;
}

/** OAuth errors arrive as `{error:"invalid_grant"}` or `{error:{code:"refresh_token_expired",…}}`. */
export function readOAuthFailure(status: number, body: unknown): OAuthFailure {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const err = b['error'];
  let code: string | undefined;
  let description: string | undefined;
  if (typeof err === 'string') {
    code = err;
    if (typeof b['error_description'] === 'string') description = b['error_description'];
  } else if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e['code'] === 'string') code = e['code'];
    if (typeof e['message'] === 'string') description = e['message'];
  }
  if (!code && typeof b['code'] === 'string') code = b['code'];
  if (!description && typeof b['message'] === 'string') description = b['message'];
  return { status, ...(code ? { code } : {}), ...(description ? { description } : {}) };
}

export type TokenResult =
  | { ok: true; tokens: TokenResponse }
  | { ok: false; failure: OAuthFailure }
  | { ok: false; transient: true; message: string };

async function postToken(url: string, form: URLSearchParams, f: FetchLike): Promise<TokenResult> {
  let res: Response;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, transient: true, message: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text().catch(() => '');
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    return { ok: false, transient: true, message: `HTTP ${res.status}` };
  }
  if (!res.ok) return { ok: false, failure: readOAuthFailure(res.status, body) };

  const b = body as Partial<TokenResponse> | undefined;
  if (!b || typeof b.access_token !== 'string' || !b.access_token) {
    return { ok: false, failure: { status: res.status, code: 'invalid_token_response', description: 'The token response had no access token.' } };
  }
  const expires = typeof b.expires_in === 'number' ? b.expires_in : Number(b.expires_in);
  return {
    ok: true,
    tokens: {
      access_token: b.access_token,
      ...(typeof b.refresh_token === 'string' && b.refresh_token ? { refresh_token: b.refresh_token } : {}),
      ...(typeof b.id_token === 'string' && b.id_token ? { id_token: b.id_token } : {}),
      token_type: typeof b.token_type === 'string' ? b.token_type : 'Bearer',
      expires_in: Number.isFinite(expires) && expires > 0 ? expires : 3600,
      ...(typeof b.scope === 'string' ? { scope: b.scope } : {}),
      ...(typeof b.earliest_refresh_at === 'string' || typeof b.earliest_refresh_at === 'number'
        ? { earliest_refresh_at: normalizeInstant(b.earliest_refresh_at) } : {}),
    },
  };
}

/** `earliest_refresh_at` may be an ISO string or Unix seconds; stored as ISO. */
function normalizeInstant(v: string | number): string {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const n = Number(v);
  if (Number.isFinite(n) && /^\d+$/.test(v)) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : v;
}

/** The authorization_code grant: issued client ID, code, verifier, the SAME redirect URI, and the resource. */
export function exchangeCodeForm(a: { clientId: string; code: string; verifier: string; redirectUri: string }): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: a.clientId,
    code: a.code,
    code_verifier: a.verifier,
    redirect_uri: a.redirectUri,
    resource: CHATGPT_RESOURCE,
  });
}

export function exchangeCode(
  a: { clientId: string; code: string; verifier: string; redirectUri: string },
  f: FetchLike = fetch,
  tokenUrl: string = CHATGPT_TOKEN_URL,
): Promise<TokenResult> {
  return postToken(tokenUrl, exchangeCodeForm(a), f);
}

/** The refresh grant: the saved issued client ID, the saved refresh token, the resource; no scope. */
export function refreshForm(a: { clientId: string; refreshToken: string }): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: a.clientId,
    refresh_token: a.refreshToken,
    resource: CHATGPT_RESOURCE,
  });
}

export function refreshTokens(
  a: { clientId: string; refreshToken: string },
  f: FetchLike = fetch,
  tokenUrl: string = CHATGPT_TOKEN_URL,
): Promise<TokenResult> {
  return postToken(tokenUrl, refreshForm(a), f);
}

/** Codes meaning the refresh token cannot be used again: clear the tokens and sign in again. */
export const TERMINAL_REFRESH_CODES: ReadonlySet<string> = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);

/** One revocation attempt. Empty HTTP 200 is success, including for an already-invalid token. */
export async function revokeRefreshToken(
  a: { endpoint: string; refreshToken: string; clientId: string },
  f: FetchLike = fetch,
): Promise<'revoked' | 'retry' | 'failed'> {
  try {
    const res = await f(a.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 200) return 'revoked';
    if (res.status >= 500 || res.status === 429) return 'retry';
    return 'failed';
  } catch {
    return 'retry';
  }
}
