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

/**
 * The same pass over a RAW, not-yet-validated config object, so it can clear
 * tier pins as well as providers.
 *
 * A `provider:model` pin is a plain string and survives a `providers[]` filter
 * untouched. When removing the dead token takes the last Anthropic entry with
 * it, a config pinned to `anthropic:<model>` reaches the router with no such
 * provider and THROWS — `Configured model … cannot be used` — instead of
 * falling back to Auto, even when another provider would have served the run.
 * The retired-provider migration learned this already; this is the same lesson
 * arriving for a different reason.
 */
export function stripRevokedFromConfig(raw: unknown): { removed: number } {
  const result = { removed: 0 };
  if (typeof raw !== 'object' || raw === null) return result;
  const cfg = raw as Record<string, unknown>;
  if (Array.isArray(cfg['providers'])) {
    const pass = stripRevokedCredentials(cfg['providers'] as CredentialBearingProvider[]);
    result.removed = pass.removed;
    if (pass.removed > 0) cfg['providers'] = pass.kept;
  }
  return result;
}

/**
 * Whether any usable Anthropic provider remains.
 *
 * Asked of the FINAL merged provider list, never the raw workspace file. The
 * key that keeps a pin valid can arrive from the machine-global store or the
 * environment, both of which are merged in after the file is read — deciding
 * from the raw file deleted the user's explicit model selection while the
 * loaded config still had a perfectly good Anthropic provider.
 */
export function hasUsableAnthropic(providers: readonly CredentialBearingProvider[]): boolean {
  return providers.some((p) => p?.type === 'anthropic' && Boolean(p.apiKey || p.authToken));
}

/** Clears `anthropic:<model>` tier pins, mutating in place; returns the tiers cleared. */
export function clearAnthropicPins(models: unknown): string[] {
  const cleared: string[] = [];
  if (typeof models !== 'object' || models === null) return cleared;
  const tiers = models as Record<string, unknown>;
  for (const tier of ['t1', 't2', 't3'] as const) {
    const pin = tiers[tier];
    if (typeof pin !== 'string') continue;
    // Lowercased to match selector.ts's resolveDynamicModel(), which parses the
    // provider half case-insensitively — so `Anthropic:claude-x` is a valid pin
    // and has to be caught here too.
    if (!pin.toLowerCase().startsWith('anthropic:')) continue;
    delete tiers[tier];
    cleared.push(tier);
  }
  return cleared;
}
