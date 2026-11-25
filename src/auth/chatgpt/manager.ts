// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT: sign-in, refresh, sign-out, accounts
// ─────────────────────────────────────────────
//
//  Everything stateful about ChatGPT plan usage lives behind `ChatGptAuth`.
//  The CLI, the desktop main process and the provider all go through one, so
//  the rules (validate before activating, one refresh at a time, never erase
//  on a network error) are written once.

import crypto from 'node:crypto';
import type { JWTVerifyGetKey } from 'jose';
import {
  AGENT_NAME_HINT, CHATGPT_ISSUER, DYNAMIC_CLIENT_ID, EXPIRY_FLOOR_MS, MANAGE_USAGE_URL, PLAN_USAGE_SCOPE, REFRESH_SKEW_MS,
} from './constants.js';
import { ChatGptAuthError } from './errors.js';
import { withAsyncLock } from './lock.js';
import {
  buildAuthorizeUrl, carriesIdTokenHint, exchangeCode, newPkce, randomToken, redactAuthorizeUrl, refreshTokens,
  revokeRefreshToken, startLoopback, TERMINAL_REFRESH_CODES, type Loopback, type TokenResponse,
} from './oauth.js';
import { fetchDiscovery, unverifiedClaims, validateIdToken, type FetchLike } from './oidc.js';
import {
  activeAccount, canUsePlan, chatGptDir, expiresAtMs, findAccount, getHostId, hasPlanScope, readStore, toPublic,
  updateStore, withoutTokens, type ChatGptAccount, type PublicAccount,
} from './store.js';
import path from 'node:path';

export interface ChatGptAuthDeps {
  /** Where the files live. Default `~/.cascade-ai` (or `CASCADE_GLOBAL_DIR`). */
  dir?: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Key resolver for ID-token signatures. Default: OpenAI's JWKS. Tests inject a local one. */
  jwks?: JWTVerifyGetKey;
  /** Loopback listener options (tests use a free port and a short timeout). */
  loopback?: { preferredPort?: number; timeoutMs?: number };
}

export interface AuthUrlInfo {
  /** Open this in the system browser. May carry `id_token_hint`: never log it. */
  url: string;
  /** Safe to print or log. */
  redactedUrl: string;
  /** True when `url` is safe to show the user to open by hand (no ID-token hint in it). */
  printable: boolean;
  redirectUri: string;
}

export interface SignInOptions {
  /** Sign in again to this saved registration (its issued client ID). Omit to add a new account. */
  accountId?: string;
  /** Hands the URL to the system browser (CLI: spawn; desktop: shell.openExternal). */
  openUrl: (url: string) => void | boolean | Promise<void | boolean>;
  /** Told the URL before the browser opens, so a headless run can print it. */
  onAuthUrl?: (info: AuthUrlInfo) => void;
  signal?: AbortSignal;
  /** The user chose to enable plan usage after declining it: ask for consent again. */
  forceConsent?: boolean;
}

export interface SignInResult {
  account: PublicAccount;
  /** The granted scopes include chatgpt.tokens.use.direct. When false, do not proceed to inference. */
  planUsageEnabled: boolean;
  /** First sign-in with plan usage enabled: show the one-time welcome, then `markWelcomeShown()`. */
  showWelcome: boolean;
  newRegistration: boolean;
}

export interface SignOutResult {
  account: PublicAccount | undefined;
  /** `confirmed`: OpenAI answered 200. `not_confirmed`: it could not be reached or refused; `none`: no refresh token to revoke. */
  revocation: 'confirmed' | 'not_confirmed' | 'none';
  message: string;
}

export interface AccessToken {
  accessToken: string;
  account: PublicAccount;
}

export interface ChatGptStatus {
  hostId: string;
  accounts: PublicAccount[];
  active: PublicAccount | undefined;
  /** Signed in and approved for plan usage: requests can use it now. */
  planReady: boolean;
  welcomePending: boolean;
  manageUsageUrl: string;
}

export const EXPORT_FORMAT = 'cascade-chatgpt-account';

const BACKOFF_MS = [0, 500, 1_500, 4_000];

/** Whether the saved access token should be renewed now. */
export function needsRefresh(a: Pick<ChatGptAccount, 'saved_at' | 'expires_in' | 'earliest_refresh_at' | 'access_token'>, now: number): boolean {
  if (!a.access_token) return true;
  const exp = expiresAtMs(a);
  // Too close to expiry to be used: refresh whatever the server's hint says.
  if (now >= exp - EXPIRY_FLOOR_MS) return true;
  if (now < exp - REFRESH_SKEW_MS) return false;
  // Near expiry: renew once the server allows it.
  const earliest = a.earliest_refresh_at ? Date.parse(a.earliest_refresh_at) : NaN;
  return !Number.isFinite(earliest) || now >= earliest;
}

function parseScopes(...sources: Array<string | undefined>): string[] {
  for (const s of sources) {
    if (typeof s === 'string' && s.trim()) return [...new Set(s.trim().split(/\s+/))].sort();
  }
  return [];
}

export class ChatGptAuth {
  private readonly dir: string;
  private readonly f: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly deps: ChatGptAuthDeps;
  private readonly inflight = new Map<string, Promise<ChatGptAccount>>();

  constructor(deps: ChatGptAuthDeps = {}) {
    this.deps = deps;
    this.dir = deps.dir ?? chatGptDir();
    this.f = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── Reading ────────────────────────────────

  hostId(): string { return getHostId(this.dir); }

  status(): ChatGptStatus {
    const store = readStore(this.dir);
    const active = activeAccount(store);
    return {
      hostId: this.hostId(),
      accounts: store.accounts.map((a) => toPublic(store, a)),
      active: active ? toPublic(store, active) : undefined,
      planReady: canUsePlan(active),
      welcomePending: store.welcome_shown !== true && canUsePlan(active),
      manageUsageUrl: MANAGE_USAGE_URL,
    };
  }

  /** Quick, local, token-free: can the active account make a request? */
  planReady(): boolean { return canUsePlan(activeAccount(readStore(this.dir))); }

  markWelcomeShown(): void {
    updateStore(this.dir, (s) => { s.welcome_shown = true; });
  }

  /** Make a saved, signed-in registration the active one. Returns false when it must sign in first. */
  switchAccount(id: string): { switched: boolean; needsSignIn: boolean; account: PublicAccount } {
    return updateStore(this.dir, (s) => {
      const a = findAccount(s, id);
      if (!a) throw new ChatGptAuthError('No such ChatGPT account.', 'no_account');
      if (!canUsePlan(a)) return { switched: false, needsSignIn: true, account: toPublic(s, a) };
      s.active = a.client_id;
      return { switched: true, needsSignIn: false, account: toPublic(s, a) };
    });
  }

  // ── Sign-in ────────────────────────────────

  async signIn(opts: SignInOptions): Promise<SignInResult> {
    const hostId = this.hostId();
    const saved = opts.accountId ? findAccount(readStore(this.dir), opts.accountId) : undefined;
    if (opts.accountId && !saved) throw new ChatGptAuthError('No such ChatGPT account.', 'no_account');

    // Fresh state, nonce and PKCE for every attempt; the listener starts
    // before the browser opens, and the redirect URI is fixed from here on.
    const state = randomToken();
    const nonce = randomToken();
    const pkce = newPkce();
    const loop: Loopback = await startLoopback(this.deps.loopback);
    const onAbort = (): void => loop.close();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const url = buildAuthorizeUrl({
        ...(saved ? { clientId: saved.client_id } : { agentNameHint: AGENT_NAME_HINT }),
        redirectUri: loop.redirectUri,
        state, nonce, codeChallenge: pkce.challenge, hostId,
        ...(saved?.id_token ? { idTokenHint: saved.id_token } : {}),
        ...(saved?.email ? { loginHint: saved.email } : {}),
        ...(opts.forceConsent ? { forceConsent: true } : {}),
      });
      opts.onAuthUrl?.({ url, redactedUrl: redactAuthorizeUrl(url), printable: !carriesIdTokenHint(url), redirectUri: loop.redirectUri });
      await opts.openUrl(url);

      const params = await loop.callback;

      // State first: nothing in an unmatched callback is trusted, an error included.
      const returnedState = params.get('state') ?? '';
      if (returnedState.length !== state.length
        || !crypto.timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))) {
        throw new ChatGptAuthError('The sign-in response did not match this request. Start again.', 'invalid_callback');
      }
      const err = params.get('error');
      if (err === 'access_denied') {
        throw new ChatGptAuthError('ChatGPT plan use was not approved. You can enable it later from settings, or use another provider or an API key.', 'access_denied');
      }
      if (err) {
        throw new ChatGptAuthError(`Sign-in failed (${err}${params.get('error_description') ? `: ${params.get('error_description')}` : ''}).`, 'invalid_callback');
      }
      const code = params.get('code');
      if (!code) throw new ChatGptAuthError('The sign-in response had no authorization code.', 'invalid_callback');

      const returnedClient = params.get('client_id') ?? undefined;
      let clientId: string;
      if (saved) {
        // Re-auth: the callback may omit the client, but never change it.
        if (returnedClient && returnedClient !== saved.client_id) {
          throw new ChatGptAuthError('The sign-in returned a different client than this account is registered with, so it was rejected.', 'invalid_callback');
        }
        clientId = saved.client_id;
      } else {
        // New registration: the issued ID is what the exchange and the record use.
        if (!returnedClient || returnedClient === DYNAMIC_CLIENT_ID) {
          throw new ChatGptAuthError('Registration was not completed: the sign-in did not return a client ID.', 'invalid_callback');
        }
        clientId = returnedClient;
      }

      const exchanged = await exchangeCode({ clientId, code, verifier: pkce.verifier, redirectUri: loop.redirectUri }, this.f);
      if (!exchanged.ok) {
        if ('transient' in exchanged) throw new ChatGptAuthError(`Could not reach OpenAI to finish signing in (${exchanged.message}). Try again.`, 'transient');
        throw new ChatGptAuthError(
          exchanged.failure.code === 'invalid_grant'
            ? 'The sign-in code was not accepted. Start the sign-in again.'
            : `OpenAI refused the sign-in (${exchanged.failure.code ?? `HTTP ${exchanged.failure.status}`}).`,
          'invalid_response', exchanged.failure.status);
      }
      const tokens = exchanged.tokens;
      if (!tokens.id_token) throw new ChatGptAuthError('The sign-in response had no ID token.', 'invalid_response');

      const verified = await validateIdToken({
        idToken: tokens.id_token, clientId, nonce,
        ...(this.deps.jwks ? { jwks: this.deps.jwks } : {}), fetch: this.f, now: this.now,
      });

      // Granted scopes decide plan usage, not the ID token. The token
      // response's `scope` is authoritative; the access token's own claim is
      // the fallback when the response omits it.
      const scopes = parseScopes(tokens.scope, String(unverifiedClaims(tokens.access_token)['scope'] ?? ''));
      const planUsageEnabled = scopes.includes(PLAN_USAGE_SCOPE);

      const savedAt = new Date(this.now()).toISOString();
      const result = updateStore(this.dir, (s) => {
        const existing = findAccount(s, clientId);
        // The verified identity must match the registration it replaces, and
        // a registration is never merged with another's tokens.
        if (existing && existing.subject !== verified.subject) {
          throw new ChatGptAuthError('That is a different ChatGPT account from the one selected, so nothing was changed.', 'invalid_response');
        }
        const record: ChatGptAccount = {
          email: verified.email || existing?.email || '',
          issuer: CHATGPT_ISSUER,
          subject: verified.subject,
          client_id: clientId,
          ext_agent_host_id: hostId,
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
          token_type: 'Bearer',
          expires_in: tokens.expires_in,
          scopes,
          saved_at: savedAt,
          ...(tokens.earliest_refresh_at ? { earliest_refresh_at: tokens.earliest_refresh_at } : {}),
          // A response without a refresh token cannot be renewed.
          ...(tokens.refresh_token ? {} : { needs_sign_in: true, signed_out_reason: 'refresh_failed' as const }),
        };
        const i = s.accounts.findIndex((a) => a.client_id === clientId);
        if (i >= 0) s.accounts[i] = record; else s.accounts.push(record);
        // Only a validated sign-in becomes active.
        s.active = clientId;
        const showWelcome = planUsageEnabled && s.welcome_shown !== true;
        return { account: toPublic(s, record), showWelcome };
      });
      return { account: result.account, planUsageEnabled, showWelcome: result.showWelcome, newRegistration: !saved };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      loop.close();
    }
  }

  // ── Access token, refresh ──────────────────

  /**
   * A bearer for a request: the saved token when it is not near expiry,
   * otherwise a refreshed one. Throws `sign_in_required` when the tokens are
   * unusable and `transient` on a network or server failure (nothing erased).
   */
  async getAccessToken(opts: { accountId?: string; forceRefresh?: boolean } = {}): Promise<AccessToken> {
    const store = readStore(this.dir);
    const acc = opts.accountId ? findAccount(store, opts.accountId) : activeAccount(store);
    if (!acc) throw new ChatGptAuthError('Not signed in with ChatGPT. Run: cascade chatgpt signin', 'no_account');
    if (!canUsePlan(acc)) {
      throw new ChatGptAuthError(
        hasPlanScope(acc)
          ? 'Your ChatGPT sign-in has ended. Sign in again: cascade chatgpt signin'
          : 'ChatGPT plan usage is not enabled for this sign-in. Run: cascade chatgpt signin',
        'sign_in_required');
    }
    if (!opts.forceRefresh && !needsRefresh(acc, this.now())) {
      return { accessToken: acc.access_token!, account: toPublic(store, acc) };
    }
    const fresh = await this.refresh(acc.client_id, opts.forceRefresh === true);
    return { accessToken: fresh.access_token!, account: toPublic(readStore(this.dir), fresh) };
  }

  /** Refresh one registration. Concurrent callers, in this process or another, make ONE network request. */
  refresh(clientId: string, force = false): Promise<ChatGptAccount> {
    const running = this.inflight.get(clientId);
    if (running) return running;
    const p = this.refreshLocked(clientId, force).finally(() => { this.inflight.delete(clientId); });
    this.inflight.set(clientId, p);
    return p;
  }

  private lockFile(clientId: string): string {
    const tag = crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 12);
    return path.join(this.dir, `chatgpt-refresh-${tag}.lock`);
  }

  private async refreshLocked(clientId: string, force: boolean): Promise<ChatGptAccount> {
    return withAsyncLock(this.lockFile(clientId), async () => {
      // Re-read after taking the lock: another process may have refreshed
      // while this one waited, and its rotated token is the only valid one.
      const current = findAccount(readStore(this.dir), clientId);
      if (!current || !canUsePlan(current)) {
        throw new ChatGptAuthError('Your ChatGPT sign-in has ended. Sign in again: cascade chatgpt signin', 'sign_in_required');
      }
      if (!force && !needsRefresh(current, this.now())) return current;

      const used = current.refresh_token!;
      const r = await refreshTokens({ clientId, refreshToken: used }, this.f);

      if (r.ok) return this.applyRefresh(clientId, used, r.tokens);

      if ('transient' in r) {
        throw new ChatGptAuthError(`Could not reach OpenAI to renew the ChatGPT sign-in (${r.message}). Your sign-in is kept; try again.`, 'transient');
      }
      const code = r.failure.code;
      if (code && TERMINAL_REFRESH_CODES.has(code)) {
        // Before clearing, make sure the refresh token that failed is still
        // the one on disk: if another process rotated it meanwhile, the token
        // we used was simply old and the account is fine.
        const now = findAccount(readStore(this.dir), clientId);
        if (now?.refresh_token && now.refresh_token !== used) return now;
        updateStore(this.dir, (s) => {
          const i = s.accounts.findIndex((a) => a.client_id === clientId);
          const a = s.accounts[i];
          if (a && a.refresh_token === used) s.accounts[i] = withoutTokens(a, 'refresh_failed');
        });
        throw new ChatGptAuthError('Your ChatGPT sign-in has expired or was disconnected. Sign in again: cascade chatgpt signin', 'sign_in_required', r.failure.status);
      }
      if (code === 'invalid_client') {
        throw new ChatGptAuthError('OpenAI no longer recognises this Cascade registration (invalid_client). Sign in again to register it afresh: cascade chatgpt signin', 'invalid_client', r.failure.status);
      }
      // Anything else is unexplained: report it and keep the credentials.
      throw new ChatGptAuthError(`OpenAI refused to renew the ChatGPT sign-in (${code ?? `HTTP ${r.failure.status}`}). Your sign-in is kept.`, 'invalid_response', r.failure.status);
    });
  }

  /** Replace access token, refresh token, expiry and scopes TOGETHER. */
  private async applyRefresh(clientId: string, used: string, t: TokenResponse): Promise<ChatGptAccount> {
    let idToken: string | undefined;
    if (t.id_token) {
      // A new ID token is kept only when it is verifiably the same account's.
      try {
        const v = await validateIdToken({
          idToken: t.id_token, clientId,
          ...(this.deps.jwks ? { jwks: this.deps.jwks } : {}), fetch: this.f, now: this.now,
        });
        const cur = findAccount(readStore(this.dir), clientId);
        if (cur && v.subject === cur.subject) idToken = t.id_token;
      } catch { /* keep the one we have */ }
    }
    return updateStore(this.dir, (s) => {
      const i = s.accounts.findIndex((a) => a.client_id === clientId);
      const a = s.accounts[i];
      if (!a) throw new ChatGptAuthError('This ChatGPT account was removed while it was being renewed.', 'no_account');
      // Signed out or re-authorized meanwhile: this response belongs to a
      // session that no longer exists, so it replaces nothing.
      if (a.refresh_token !== used) return a;
      const scopes = parseScopes(t.scope, String(unverifiedClaims(t.access_token)['scope'] ?? ''));
      const next: ChatGptAccount = {
        ...a,
        ...(idToken ? { id_token: idToken } : {}),
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? used,
        expires_in: t.expires_in,
        scopes: scopes.length ? scopes : a.scopes,
        saved_at: new Date(this.now()).toISOString(),
      };
      if (t.earliest_refresh_at) next.earliest_refresh_at = t.earliest_refresh_at; else delete next.earliest_refresh_at;
      s.accounts[i] = next;
      return next;
    });
  }

  // ── Sign-out ───────────────────────────────

  /**
   * Stop using the account and end its renewable session: revoke the refresh
   * token at the revocation endpoint (retrying a network failure or 5xx with
   * backoff), then clear the access, refresh and ID tokens. The client ID,
   * the account mapping and this host's ID are kept for a later sign-in.
   */
  async signOut(accountId?: string): Promise<SignOutResult> {
    const store = readStore(this.dir);
    const target = accountId ? findAccount(store, accountId) : activeAccount(store);
    if (!target) throw new ChatGptAuthError('No ChatGPT account to sign out of.', 'no_account');
    const clientId = target.client_id;

    // Under the refresh lock, so a refresh cannot rotate the token while it is being revoked.
    const revocation = await withAsyncLock(this.lockFile(clientId), async (): Promise<SignOutResult['revocation']> => {
      const cur = findAccount(readStore(this.dir), clientId);
      const token = cur?.refresh_token;
      if (!token) return 'none';
      let endpoint: string | undefined;
      try { endpoint = (await fetchDiscovery(this.f)).revocation_endpoint; } catch { endpoint = undefined; }
      if (!endpoint) return 'not_confirmed';
      for (const wait of BACKOFF_MS) {
        if (wait) await this.sleep(wait);
        const outcome = await revokeRefreshToken({ endpoint, refreshToken: token, clientId }, this.f);
        if (outcome === 'revoked') return 'confirmed';
        if (outcome === 'failed') return 'not_confirmed';
      }
      return 'not_confirmed';
    });

    const account = updateStore(this.dir, (s) => {
      const i = s.accounts.findIndex((a) => a.client_id === clientId);
      const a = s.accounts[i];
      if (a) s.accounts[i] = withoutTokens(a, 'signed_out');
      if (s.active === clientId) {
        const next = s.accounts.find((x) => x.client_id !== clientId && canUsePlan(x));
        if (next) s.active = next.client_id; else delete s.active;
      }
      const after = s.accounts[i];
      return after ? toPublic(s, after) : undefined;
    });

    const message = revocation === 'not_confirmed'
      ? 'Signed out on this computer. Cascade could not confirm that ChatGPT ended the session, so disconnect Cascade in ChatGPT settings to be sure.'
      : 'Signed out. Cascade no longer uses your ChatGPT plan.';
    return { account, revocation, message };
  }

  // ── Moving a registration to another host ──

  /**
   * One registration's protected record, for a machine with no browser. The
   * file holds credentials: whoever has it can use the account until it is
   * revoked. The machine that imports it keeps its own host ID and owns the
   * refreshes from then on; the refresh token rotates, so the source machine
   * should stop using that account.
   */
  exportAccount(accountId?: string): { format: string; version: 1; exported_at: string; account: ChatGptAccount } {
    const store = readStore(this.dir);
    const a = accountId ? findAccount(store, accountId) : activeAccount(store);
    if (!a) throw new ChatGptAuthError('No ChatGPT account to export.', 'no_account');
    if (!a.refresh_token || a.needs_sign_in) throw new ChatGptAuthError('That account is not signed in, so there is nothing to export.', 'sign_in_required');
    return { format: EXPORT_FORMAT, version: 1, exported_at: new Date(this.now()).toISOString(), account: { ...a } };
  }

  /** Import an exported record under THIS host's own host ID, and make it active. */
  importAccount(payload: unknown): PublicAccount {
    const bad = (why: string): never => { throw new ChatGptAuthError(`That is not a Cascade ChatGPT account export (${why}).`, 'invalid_response'); };
    const p = payload as { format?: unknown; account?: Record<string, unknown> } | null;
    if (!p || p.format !== EXPORT_FORMAT || !p.account || typeof p.account !== 'object') return bad('wrong format');
    const a = p.account;
    const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
    const clientId = str('client_id');
    const subject = str('subject');
    if (!clientId || clientId === DYNAMIC_CLIENT_ID) return bad('no issued client ID');
    if (!subject) return bad('no subject');
    if (str('issuer') !== CHATGPT_ISSUER) return bad('unexpected issuer');
    if (!str('refresh_token')) return bad('no refresh token');
    if (!Array.isArray(a['scopes']) || !a['scopes'].every((x) => typeof x === 'string')) return bad('no scopes');
    // The ID token, when present, must be this registration's: a record whose parts disagree is refused.
    if (str('id_token')) {
      const claims = unverifiedClaims(str('id_token'));
      const aud = claims['aud'];
      const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
      if (claims['sub'] !== subject || !audOk) return bad('its tokens do not belong to one registration');
    }
    const expiresIn = typeof a['expires_in'] === 'number' ? (a['expires_in'] as number) : 3600;
    const hostId = this.hostId();
    return updateStore(this.dir, (s) => {
      const existing = findAccount(s, clientId);
      if (existing && existing.subject !== subject) {
        throw new ChatGptAuthError('A different account is already saved under that client ID, so nothing was imported.', 'invalid_response');
      }
      const record: ChatGptAccount = {
        email: str('email'),
        issuer: CHATGPT_ISSUER,
        subject,
        client_id: clientId,
        // This host's own, never the exporter's.
        ext_agent_host_id: hostId,
        ...(str('id_token') ? { id_token: str('id_token') } : {}),
        ...(str('access_token') ? { access_token: str('access_token') } : {}),
        refresh_token: str('refresh_token'),
        token_type: 'Bearer',
        expires_in: expiresIn,
        scopes: a['scopes'] as string[],
        saved_at: str('saved_at') || new Date(this.now()).toISOString(),
        ...(str('earliest_refresh_at') ? { earliest_refresh_at: str('earliest_refresh_at') } : {}),
      };
      const i = s.accounts.findIndex((x) => x.client_id === clientId);
      if (i >= 0) s.accounts[i] = record; else s.accounts.push(record);
      s.active = clientId;
      return toPublic(s, record);
    });
  }
}

let shared: ChatGptAuth | undefined;
/** The process-wide instance on the default folder. Tests build their own. */
export function chatGptAuth(): ChatGptAuth {
  return (shared ??= new ChatGptAuth());
}
