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
