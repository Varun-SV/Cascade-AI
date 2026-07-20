// ─────────────────────────────────────────────
//  Cascade AI — MCP OAuth (client provider + loopback connect)
// ─────────────────────────────────────────────
//
// "Connect" an MCP server by logging in + authorizing instead of pasting a
// token. We don't implement the OAuth protocol ourselves — the MCP SDK ships a
// spec-complete client (RFC 9728 resource discovery, RFC 8414 AS metadata,
// RFC 7591 Dynamic Client Registration, PKCE, refresh). We only implement the
// `OAuthClientProvider` storage + redirect, once, and reuse it on every surface
// (cloud server callback, desktop/CLI loopback). See docs/mcp-oauth.md.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  UnauthorizedError, auth, discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata, refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata, OAuthClientInformationFull, OAuthClientInformationMixed, OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';

/** The persisted state of one MCP server's OAuth: DCR result, tokens, PKCE verifier. */
export interface McpOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** Pluggable persistence for a single server's OAuth state (differs per surface). */
export interface McpOAuthStore {
  load(): McpOAuthState | undefined | Promise<McpOAuthState | undefined>;
  save(state: McpOAuthState): void | Promise<void>;
  clear?(): void | Promise<void>;
}

export interface McpOAuthProviderOptions {
  /** Where the authorization server redirects back (our callback / loopback). */
  redirectUrl: string;
  store: McpOAuthStore;
  /** Send the user to the authorization URL (open a browser / hand it to the web). */
  redirect: (authorizationUrl: URL) => void | Promise<void>;
  clientName?: string;
  scope?: string;
  /** Fixed OAuth `state` (e.g. the cloud pending-flow key). Random if omitted. */
  state?: string;
}

/**
 * Our `OAuthClientProvider`: storage + redirect for the MCP SDK's OAuth client.
 * The SDK calls these hooks while it runs discovery/DCR/PKCE/refresh for us.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private cache: McpOAuthState | undefined;
  private readonly _state: string;

  constructor(private readonly opts: McpOAuthProviderOptions) {
    this._state = opts.state ?? randomBytes(16).toString('hex');
  }

  /** The `state` this provider uses — callers validate it on the callback. */
  get oauthState(): string { return this._state; }

  private async loaded(): Promise<McpOAuthState> {
    if (!this.cache) this.cache = (await this.opts.store.load()) ?? {};
    return this.cache;
  }
  private async persist(): Promise<void> {
    await this.opts.store.save(this.cache ?? {});
  }

  get redirectUrl(): string { return this.opts.redirectUrl; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.opts.redirectUrl],
      client_name: this.opts.clientName ?? 'Cascade AI',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client — PKCE, no secret
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  state(): string { return this._state; }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.loaded()).clientInformation;
  }
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    (await this.loaded()).clientInformation = info;
    await this.persist();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.loaded()).tokens;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    (await this.loaded()).tokens = tokens;
    await this.persist();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.opts.redirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    (await this.loaded()).codeVerifier = codeVerifier;
    await this.persist();
  }
  async codeVerifier(): Promise<string> {
    const v = (await this.loaded()).codeVerifier;
    if (!v) throw new Error('No PKCE verifier saved for this MCP OAuth flow.');
    return v;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const s = await this.loaded();
    if (scope === 'all' || scope === 'client') s.clientInformation = undefined;
    if (scope === 'all' || scope === 'tokens') s.tokens = undefined;
    if (scope === 'all' || scope === 'verifier') s.codeVerifier = undefined;
    await this.persist();
  }
}

/** A 0600 JSON file store for one server's OAuth state (desktop/CLI). */
export class FileMcpOAuthStore implements McpOAuthStore {
  constructor(private readonly filePath: string) {}
  load(): McpOAuthState | undefined {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as McpOAuthState; }
    catch { return undefined; }
  }
  save(state: McpOAuthState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* non-POSIX */ }
  }
  clear(): void {
    try { fs.rmSync(this.filePath); } catch { /* already gone */ }
  }
}

/**
 * Build a refresh-only provider over a file store, for a run connecting an
 * already-authorized OAuth MCP server. Refresh is silent; if the refresh token
 * is dead the transport would need a browser redirect, which a headless run
 * can't do — so `redirect` throws a clear "reconnect" message instead.
 */
export function fileOAuthProvider(storePath: string): McpOAuthProvider {
  return new McpOAuthProvider({
    redirectUrl: 'http://127.0.0.1/callback', // unused by refresh
    store: new FileMcpOAuthStore(storePath),
    redirect: () => { throw new Error('This MCP server needs re-authorization — run `cascade mcp connect` again.'); },
  });
}

// ── Orchestration wrappers (so consumers avoid importing the MCP SDK) ──

/** Drive the OAuth flow to the point of a browser redirect (or already-authorized). */
export function beginMcpOAuth(provider: OAuthClientProvider, serverUrl: string): Promise<'AUTHORIZED' | 'REDIRECT'> {
  return auth(provider, { serverUrl }) as Promise<'AUTHORIZED' | 'REDIRECT'>;
}

/** Complete the flow with the authorization code (saves tokens via the provider). */
export async function completeMcpOAuth(provider: OAuthClientProvider, serverUrl: string, authorizationCode: string): Promise<void> {
  await auth(provider, { serverUrl, authorizationCode });
}

/** The authorization server (issuer) protecting an MCP server, if it advertises one. */
export async function discoverMcpAuthServer(serverUrl: string): Promise<string | undefined> {
  try {
    const prm = await discoverOAuthProtectedResourceMetadata(serverUrl);
    return prm.authorization_servers?.[0];
  } catch {
    return undefined;
  }
}

/** Refresh an access token from a stored refresh token + client registration. */
export async function refreshMcpToken(input: {
  authorizationServerUrl: string;
  clientInformation: OAuthClientInformationMixed;
  refreshToken: string;
}): Promise<OAuthTokens> {
  const metadata = await discoverAuthorizationServerMetadata(input.authorizationServerUrl);
  return refreshAuthorization(input.authorizationServerUrl, {
    metadata,
    clientInformation: input.clientInformation,
    refreshToken: input.refreshToken,
  });
}

// ── Loopback connect (desktop / CLI) — RFC 8252 ──

export interface LoopbackOAuthResult {
  tokens: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
}

/**
 * Run the full OAuth connect for a rich native client: open a one-shot
 * `127.0.0.1` listener, let the MCP SDK drive discovery/DCR/PKCE, open the
 * system browser via `openUrl`, catch the code on the loopback, finish the
 * exchange, and return the tokens (also persisted through `store`).
 */
export async function connectMcpWithLoopbackOAuth(opts: {
  serverUrl: string;
  store: McpOAuthStore;
  openUrl: (url: string) => void | Promise<void>;
  clientName?: string;
  scope?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LoopbackOAuthResult> {
  const listener = await startCallbackListener(opts);
  const transport = new StreamableHTTPClientTransport(new URL(opts.serverUrl), {
    authProvider: new McpOAuthProvider({
      redirectUrl: listener.redirectUri,
      store: opts.store,
      redirect: (url) => opts.openUrl(url.toString()),
      clientName: opts.clientName,
      scope: opts.scope,
    }),
  });
  const client = new Client({ name: 'cascade-ai', version: '0.1.0' }, { capabilities: {} });
  try {
    // First connect triggers discovery + the browser redirect, then throws
    // UnauthorizedError — expected. Any other error is a real failure.
    try {
      await client.connect(transport);
      // Already authorized (tokens were cached) — nothing more to do.
      const state = await opts.store.load();
      if (!state?.tokens) throw new Error('MCP server did not require authorization.');
      return { tokens: state.tokens, clientInformation: state.clientInformation };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }
    const code = await listener.waitForCode;
    await transport.finishAuth(code);
    const state = await opts.store.load();
    if (!state?.tokens) throw new Error('Authorization completed but no tokens were issued.');
    return { tokens: state.tokens, clientInformation: state.clientInformation };
  } finally {
    listener.close();
    await transport.close().catch(() => { /* best-effort */ });
  }
}

interface CallbackListener {
  redirectUri: string;
  waitForCode: Promise<string>;
  close: () => void;
}

function startCallbackListener(opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const waitForCode = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

    let server: http.Server;
    const close = () => { try { server?.close(); } catch { /* already closed */ } };
    const timer = setTimeout(() => { rejectCode(new Error('Authorization timed out.')); close(); }, opts.timeoutMs ?? 5 * 60_000);
    timer.unref?.();
    const settle = (code: string) => { clearTimeout(timer); resolveCode(code); };
    const fail = (err: Error) => { clearTimeout(timer); rejectCode(err); };

    server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = reqUrl.searchParams.get('code');
      const err = reqUrl.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err || !code) {
        res.end(page('Authorization failed', 'You can close this tab and try again.'));
        fail(new Error(err ? `Authorization failed: ${err}` : 'No authorization code returned.'));
        return;
      }
      res.end(page('Connected', 'You can close this tab and return to Cascade.'));
      settle(code);
    });

    opts.signal?.addEventListener('abort', () => { fail(new Error('Authorization cancelled.')); close(); }, { once: true });
    server.on('error', (e) => { clearTimeout(timer); rejectListener(e); });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveListener({ redirectUri: `http://127.0.0.1:${port}/callback`, waitForCode, close });
    });
  });
}

function page(title: string, body: string): string {
  return '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title} · Cascade</title>`
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e6e8ee">'
    + `<div style="text-align:center;padding:40px"><div style="font-size:15px;font-weight:600;margin-bottom:8px">${title}</div>`
    + `<div style="font-size:13px;color:#9aa3b2">${body}</div></div></body>`;
}
