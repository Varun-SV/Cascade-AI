// ─────────────────────────────────────────────
//  Cascade AI — Revoked Credential Migration
// ─────────────────────────────────────────────
//
//  A provider entry can hold a credential that WAS adoptable and no longer is.
//  The type is still supported, so the retired-provider migration does not
//  touch it — but the secret itself is dead, and leaving it in place is worse
//  than having nothing: `hasUsableProvider()` counts it, so onboarding stays
//  closed and the install looks configured, while every request made with it
//  is refused by the provider.
//
//  The case this exists for is the Claude Code subscription token. Earlier
//  releases adopted one through `cascade link anthropic --accept-risk`, and
//  Anthropic has since stated that third-party clients may not route requests
//  through Claude subscription credentials, and blocks them server-side. Users
//  who ran that command have the token sitting in `.cascade/config.json` or
//  `~/.cascade-ai/credentials.json`, and nothing in this release would have
//  removed it.
//
//  Identification is deliberately narrow. A bearer token is a perfectly good
//  credential in general — an LLM gateway issues one — so only the two things
//  that specifically mark a Claude subscription token count: the `sk-ant-oat`
//  prefix Anthropic mints them with, and the `credentialSource` that
//  `cascade link` stamped on the entry it created.

/** Why a credential was dropped, shown to the user. */
export const REVOKED_CREDENTIAL_REASON =
  'Anthropic no longer permits third-party tools to use Claude subscription credentials '
  + 'and refuses them at the API, so the linked Claude Code token could not have worked. '
  + 'Add an API key from the Claude Console, or set ANTHROPIC_AUTH_TOKEN with a gateway.';

interface CredentialBearingProvider {
  type: string;
  apiKey?: string;
  authToken?: string;
  credentialSource?: string;
  baseUrl?: string;
}

/**
 * Whether this entry's bearer token is a Claude Code subscription token.
 *
 * Both signals are specific to that credential. `sk-ant-oat` is the prefix
 * Anthropic mints subscription tokens with; `credentialSource` naming Claude
 * Code is what `cascade link` wrote when it adopted one. A gateway bearer has
 * neither, and must survive this untouched.
 */
export function isRevokedSubscriptionCredential(p: CredentialBearingProvider): boolean {
  if (p.type !== 'anthropic' || !p.authToken) return false;
  return p.authToken.startsWith('sk-ant-oat')
    || /claude\s*code/i.test(p.credentialSource ?? '');
}

/**
 * Strips dead subscription tokens from a provider list, in place of the entry
 * where possible.
 *
 * The ENTRY is kept when it still carries something usable — an API key, or an
 * endpoint the user configured — because deleting a provider row takes more
 * than the dead secret with it. Only when the token was the entry's sole
 * reason to exist is the row removed.
 */
export function stripRevokedCredentials<T extends CredentialBearingProvider>(providers: T[]): {
  kept: T[];
  removed: number;
} {
  let removed = 0;
  const kept: T[] = [];
  for (const p of providers) {
    if (!isRevokedSubscriptionCredential(p)) {
      kept.push(p);
      continue;
    }
    removed++;
    const worthKeeping = Boolean(p.apiKey || p.baseUrl);
    if (worthKeeping) {
      const { authToken: _dropped, credentialSource: _source, ...rest } = p;
      kept.push(rest as T);
    }
  }
  return { kept, removed };
}
