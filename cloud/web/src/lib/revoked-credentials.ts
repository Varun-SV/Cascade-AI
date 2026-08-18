import type { ProviderConfig } from './types.js';

/**
 * Claude subscription tokens, which Anthropic no longer permits third-party
 * tools to use and refuses server-side.
 *
 * Mirrors src/config/revoked-credentials.ts. Deliberately duplicated rather
 * than imported, for the same reason retired-providers.ts is: cloud/web is a
 * separate Vite app with its own `ProviderConfig` and no dependency on the SDK
 * bundle.
 *
 * The browser needs this even though its `ProviderConfig` has no `authToken`
 * field at all. A decrypted sync bundle is raw JSON read back with no runtime
 * validation, so the CLI and desktop — which DO have that field — can hand the
 * browser a row carrying one. The narrower TypeScript interface describes what
 * the web writes, not what it can receive.
 */

/** The prefix Anthropic mints subscription tokens with. */
export function isSubscriptionToken(secret: unknown): boolean {
  return typeof secret === 'string' && secret.trim().startsWith('sk-ant-oat');
}

/** Whether an incoming row is an Anthropic entry whose bearer is a dead subscription token. */
export function isRevokedSubscriptionCredential(p: unknown): boolean {
  const row = p as { type?: unknown; authToken?: unknown; credentialSource?: unknown } | null;
  if (!row || row.type !== 'anthropic' || !row.authToken) return false;
  return isSubscriptionToken(row.authToken)
    || (typeof row.credentialSource === 'string' && /claude\s*code/i.test(row.credentialSource));
}

/**
 * Drops dead subscription credentials from an incoming sync bundle.
 *
 * The whole ROW goes unless it still carries an API key. This is a bundle, and
 * the merge lets a matching incoming row win outright — so a row left holding
 * nothing the browser can use would replace a working local key and leave the
 * vault unusable, then be pushed back on the next sync. A row that still has an
 * `apiKey` is kept without the token, because that key is the replacement the
 * user is syncing.
 *
 * `unknown[]` for the same reason as stripRetiredProviders: a decrypted bundle
 * has passed through no validator.
 */
export function stripRevokedCredentials(providers: unknown[]): {
  kept: ProviderConfig[];
  removed: number;
} {
  let removed = 0;
  const kept: ProviderConfig[] = [];
  for (const p of providers) {
    if (!isRevokedSubscriptionCredential(p)) {
      kept.push(p as ProviderConfig);
      continue;
    }
    removed++;
    const row = p as ProviderConfig & { authToken?: unknown; credentialSource?: unknown };
    if (row.apiKey) {
      const { authToken: _t, credentialSource: _s, ...rest } = row;
      kept.push(rest as ProviderConfig);
    }
  }
  return { kept, removed };
}

/** User-facing sentence explaining what a restore discarded, and why. */
export function describeRevokedRemoval(): string {
  return 'Discarded a linked Claude subscription token — Anthropic no longer permits third-party tools '
    + 'to use one, and refuses it. Add an API key from the Claude Console instead.';
}

/**
 * Endpoints only the user's own machine can reach.
 *
 * A hosted chat run executes on the CLOUD SERVER, not in the page, so a
 * `localhost` or private-range URL synced from a desktop resolves in the
 * server's network — it cannot reach the user's Ollama, and it may address
 * something server-local that was never meant to be addressed. `KeyVault`
 * already refuses to let anyone CREATE such a provider here; a restore must not
 * introduce one behind that.
 */
function isUnreachableFromServer(baseUrl: unknown): boolean {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false; // not a URL we can judge — leave it to the server to reject
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (host === '0.0.0.0' || host.startsWith('127.')) return true;
  // RFC1918 and link-local.
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // `.local` mDNS names resolve on the user's LAN only.
  if (host.endsWith('.local')) return true;
  return false;
}

/** Why a synced provider row cannot be used from the hosted web client. */
export type WebUnusableReason = 'bearer-only' | 'local-endpoint';

/**
 * Whether the hosted browser client can actually use this row, and if not, why.
 *
 * Three distinct shapes reach the vault and none of them work here:
 * - a row whose only credential is a bearer (`authToken` is not on the web's
 *   ProviderConfig and the hosted run schema strips it, so the server receives
 *   a keyless provider);
 * - `ollama`, which KeyVault deliberately excludes because a hosted page cannot
 *   reach a local daemon;
 * - any endpoint that resolves only on the user's own network.
 *
 * Keyless on its own is NOT a reason: `openai-compatible` is key-optional and a
 * hosted one works fine.
 */
export function webUnusableReason(p: unknown): WebUnusableReason | null {
  const row = p as { type?: unknown; apiKey?: unknown; authToken?: unknown; baseUrl?: unknown } | null;
  if (!row) return null;
  if (row.type === 'ollama') return 'local-endpoint';
  if (isUnreachableFromServer(row.baseUrl)) return 'local-endpoint';
  const hasKey = typeof row.apiKey === 'string' && row.apiKey.length > 0;
  const hasBearer = typeof row.authToken === 'string' && row.authToken.length > 0;
  if (!hasKey && hasBearer) return 'bearer-only';
  return null;
}

/** A row the browser CAN use, with any runtime-only bearer removed. */
export function withoutBearer<T extends object>(row: T): T {
  const { authToken: _t, ...rest } = row as T & { authToken?: unknown };
  return rest as T;
}
