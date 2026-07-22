// ─────────────────────────────────────────────
//  Cascade Cloud — "Connect" broker (our own OAuth apps)
// ─────────────────────────────────────────────
//
// Some providers can't self-register an OAuth client (no Dynamic Client
// Registration), so the DCR-based one-click flow in mcp-oauth.ts can't reach
// them — GitHub is the canonical case. The broker closes that gap: WE register
// one OAuth app per provider, hold its client_id/secret as server-side env
// (never shipped to the browser), and run the plain authorization-code flow
// ourselves. The user clicks Connect → the provider's consent page → we exchange
// the code for a user-scoped token, store it encrypted, and point it at the
// provider's hosted MCP URL. Runs pick it up through the same
// resolveRunMcpServers path as any other OAuth server.
//
// It's a confidential client: the token exchange carries the client_secret, so
// `state` (CSRF + lookup key) is the only anti-forgery we need — no PKCE. Every
// provider entry is env-gated; unconfigured providers simply aren't "brokered"
// and the UI falls back to pasting a token. See docs/connectors-broker.md.

import { randomBytes } from 'node:crypto';
import type { OAuthTokens } from '#cascade-ai';
import type { CloudEnv } from './env.js';

/** Which env vars hold a provider's OAuth-app credentials. */
type ClientIdEnv = 'CONNECT_GITHUB_CLIENT_ID';
type ClientSecretEnv = 'CONNECT_GITHUB_CLIENT_SECRET';

export interface BrokerProvider {
  id: string;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** OAuth scopes requested at authorize time (space-separated). */
  scope: string;
  /** The provider's hosted MCP endpoint the issued token authenticates against. */
  mcpUrl: string;
  clientIdEnv: ClientIdEnv;
  clientSecretEnv: ClientSecretEnv;
}

// One entry per provider we host an OAuth app for. GitHub only, for now: it's the
// connector that can't DCR, and its hosted MCP server accepts a user OAuth token
// exactly like a PAT. Add a provider here + its CONNECT_<X>_CLIENT_ID/SECRET env.
export const BROKER_PROVIDERS: Record<string, BrokerProvider> = {
  github: {
    id: 'github',
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    // Repos, issues & PRs via the hosted GitHub MCP server. `read:org` lets it
    // resolve org-owned repos; `read:user` identifies the account.
    scope: 'repo read:org read:user',
    mcpUrl: 'https://api.githubcopilot.com/mcp/',
    clientIdEnv: 'CONNECT_GITHUB_CLIENT_ID',
    clientSecretEnv: 'CONNECT_GITHUB_CLIENT_SECRET',
  },
};

export function getBrokerProvider(id: string): BrokerProvider | undefined {
  return Object.prototype.hasOwnProperty.call(BROKER_PROVIDERS, id) ? BROKER_PROVIDERS[id] : undefined;
}

/** A provider is "brokered" only when both halves of its OAuth app are configured. */
export function brokerConfigured(env: CloudEnv, id: string): boolean {
  const p = getBrokerProvider(id);
  return !!p && !!env[p.clientIdEnv] && !!env[p.clientSecretEnv];
}

/** Connector ids that currently have a configured broker OAuth app. */
export function brokeredConnectorIds(env: CloudEnv): string[] {
  return Object.keys(BROKER_PROVIDERS).filter((id) => brokerConfigured(env, id));
}

/** The redirect_uri the provider calls back — must match the OAuth app registration. */
export function brokerCallbackUrl(env: CloudEnv, id: string): string {
  return `${env.OAUTH_REDIRECT_BASE_URL.replace(/\/$/, '')}/api/connect/${id}/callback`;
}

/** Build the provider's authorize URL. `state` is the CSRF + pending-flow key. */
export function brokerAuthorizeUrl(env: CloudEnv, p: BrokerProvider, state: string): string {
  const params = new URLSearchParams({
    client_id: env[p.clientIdEnv] ?? '',
    redirect_uri: brokerCallbackUrl(env, p.id),
    scope: p.scope,
    state,
    response_type: 'code',
    allow_signup: 'true',
  });
  return `${p.authorizeUrl}?${params.toString()}`;
}

/**
 * Exchange an authorization code for a user token (server-side, with the secret).
 * `fetchImpl` is injectable for tests. Handles both JSON providers (GitHub, when
 * asked with Accept: application/json) uniformly.
 */
export async function brokerExchangeCode(
  env: CloudEnv, p: BrokerProvider, code: string, fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const res = await fetchImpl(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env[p.clientIdEnv],
      client_secret: env[p.clientSecretEnv],
      code,
      redirect_uri: brokerCallbackUrl(env, p.id),
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}).`);
  const body = (await res.json()) as {
    access_token?: string; token_type?: string; scope?: string;
    refresh_token?: string; expires_in?: number; error?: string; error_description?: string;
  };
  if (!body.access_token) throw new Error(body.error_description || body.error || 'No access token was issued.');
  return {
    access_token: body.access_token,
    token_type: body.token_type || 'Bearer',
    ...(body.scope ? { scope: body.scope } : {}),
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    ...(typeof body.expires_in === 'number' ? { expires_in: body.expires_in } : {}),
  };
}

interface PendingBrokerFlow { userId: string; providerId: string; createdAt: number }
const PENDING_TTL_MS = 10 * 60_000;

/**
 * In-flight broker connects (start → callback), keyed by `state`, swept by TTL.
 * A `state` is single-use: `take` deletes it, so a code can't be replayed and a
 * stale link can't be re-submitted.
 */
export class BrokerFlows {
  private pending = new Map<string, PendingBrokerFlow>();

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
  }

  create(userId: string, providerId: string): string {
    this.sweep();
    const state = randomBytes(16).toString('hex');
    this.pending.set(state, { userId, providerId, createdAt: Date.now() });
    return state;
  }

  take(state: string): PendingBrokerFlow | undefined {
    this.sweep();
    const flow = this.pending.get(state);
    if (flow) this.pending.delete(state);
    return flow;
  }
}
