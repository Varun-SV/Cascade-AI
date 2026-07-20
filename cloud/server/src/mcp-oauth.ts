// ─────────────────────────────────────────────
//  Cascade Cloud — MCP OAuth connect (server side)
// ─────────────────────────────────────────────
//
// "Connect" an MCP server via OAuth instead of pasting a token. The MCP SDK (via
// #cascade-ai wrappers) drives discovery / DCR / PKCE / refresh; we hold the
// short-lived pending flow (keyed by state), persist the resulting tokens
// encrypted at rest, and hand a fresh Bearer header to each run. See
// docs/mcp-oauth.md.

import { randomBytes } from 'node:crypto';
import {
  McpOAuthProvider, beginMcpOAuth, completeMcpOAuth, discoverMcpAuthServer, refreshMcpToken,
} from '#cascade-ai';
import type { McpOAuthState, McpOAuthStore, OAuthTokens, OAuthClientInformationMixed } from '#cascade-ai';
import type { CloudStore } from './db.js';
import { encryptAtRest, decryptAtRest } from './secrets.js';

/** The decrypted per-server OAuth record we persist. */
interface StoredMcpOAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  authorizationServerUrl?: string;
  expiresAt?: number; // epoch ms
}

interface PendingFlow {
  userId: string;
  serverUrl: string;
  name: string;
  connectorId: string | null;
  redirectUrl: string;
  state: McpOAuthState; // in-progress client reg + PKCE verifier (+ tokens after finish)
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;

export interface FinishedOAuthConnect {
  userId: string;
  serverUrl: string;
  name: string;
  connectorId: string | null;
  stored: StoredMcpOAuth;
}

/** Holds the in-flight OAuth connects (start → callback), swept by TTL. */
export class McpOAuthFlows {
  private pending = new Map<string, PendingFlow>();

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
  }

  private storeFor(flow: PendingFlow): McpOAuthStore {
    return { load: () => flow.state, save: (s) => { flow.state = s; } };
  }

  /**
   * Begin an OAuth connect. Returns the authorize URL to send the browser to,
   * or null when the server doesn't advertise OAuth (caller falls back to a
   * pasted token).
   */
  async start(input: {
    serverUrl: string; name: string; connectorId: string | null; userId: string; redirectUrl: string;
  }): Promise<{ authorizeUrl: string } | null> {
    this.sweep();
    const state = randomBytes(16).toString('hex');
    const flow: PendingFlow = { ...input, state: {}, createdAt: Date.now() };
    let captured: URL | undefined;
    const provider = new McpOAuthProvider({
      redirectUrl: input.redirectUrl,
      store: this.storeFor(flow),
      redirect: (url) => { captured = url; },
      clientName: 'Cascade AI',
      state,
    });
    let result: 'AUTHORIZED' | 'REDIRECT';
    try {
      result = await beginMcpOAuth(provider, input.serverUrl);
    } catch {
      return null; // discovery/registration failed → not an OAuth server for us
    }
    if (result !== 'REDIRECT' || !captured) return null;
    this.pending.set(state, flow);
    return { authorizeUrl: captured.toString() };
  }

  /** Finish the flow (callback): exchange the code, resolve the AS, return the record. */
  async finish(input: { state: string; code: string }): Promise<FinishedOAuthConnect> {
    this.sweep();
    const flow = this.pending.get(input.state);
    if (!flow) throw new Error('This authorization link has expired. Please try connecting again.');
    this.pending.delete(input.state);

    const provider = new McpOAuthProvider({
      redirectUrl: flow.redirectUrl,
      store: this.storeFor(flow),
      redirect: () => { /* no redirect on the finish leg */ },
      state: input.state,
    });
    await completeMcpOAuth(provider, flow.serverUrl, input.code);

    const tokens = flow.state.tokens;
    if (!tokens) throw new Error('Authorization completed but no tokens were issued.');
    const authorizationServerUrl = await discoverMcpAuthServer(flow.serverUrl);
    const stored: StoredMcpOAuth = {
      clientInformation: flow.state.clientInformation,
      tokens,
      authorizationServerUrl,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    };
    return { userId: flow.userId, serverUrl: flow.serverUrl, name: flow.name, connectorId: flow.connectorId, stored };
  }
}

/** Encrypt a stored OAuth record for the DB. */
export function encodeOAuthBlob(stored: StoredMcpOAuth, secret: string): string {
  return encryptAtRest(JSON.stringify(stored), secret);
}

/**
 * Resolve a user's enabled MCP servers into `{ name, url, headers }` for a run.
 * OAuth servers get a fresh Bearer token — refreshed and re-persisted when near
 * expiry — so runs never send a stale token.
 */
export async function resolveRunMcpServers(
  store: CloudStore, userId: string, secret: string,
): Promise<Array<{ name: string; url: string; headers?: Record<string, string> }>> {
  const rows = store.listEnabledMcpServerRows(userId);
  const out: Array<{ name: string; url: string; headers?: Record<string, string> }> = [];
  for (const row of rows) {
    if (row.headers_json) {
      out.push({ name: row.name, url: row.url, headers: JSON.parse(row.headers_json) as Record<string, string> });
      continue;
    }
    if (row.oauth_json) {
      try {
        let blob = JSON.parse(decryptAtRest(row.oauth_json, secret)) as StoredMcpOAuth;
        const refreshed = await ensureFreshToken(blob);
        if (refreshed) {
          blob = refreshed;
          store.updateMcpServerOAuth(row.id, userId, encryptAtRest(JSON.stringify(blob), secret));
        }
        out.push({ name: row.name, url: row.url, headers: { Authorization: `Bearer ${blob.tokens.access_token}` } });
      } catch {
        // Undecodable or refresh failed — skip; the user can reconnect.
      }
      continue;
    }
    out.push({ name: row.name, url: row.url });
  }
  return out;
}

/** Refresh the token when it's within a minute of expiry; else null (unchanged). */
async function ensureFreshToken(blob: StoredMcpOAuth): Promise<StoredMcpOAuth | null> {
  const stillFresh = !blob.expiresAt || blob.expiresAt - Date.now() > 60_000;
  if (stillFresh) return null;
  if (!blob.tokens.refresh_token || !blob.authorizationServerUrl || !blob.clientInformation) return null;
  const tokens = await refreshMcpToken({
    authorizationServerUrl: blob.authorizationServerUrl,
    clientInformation: blob.clientInformation,
    refreshToken: blob.tokens.refresh_token,
  });
  return {
    ...blob,
    tokens: { ...tokens, refresh_token: tokens.refresh_token ?? blob.tokens.refresh_token },
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
  };
}
