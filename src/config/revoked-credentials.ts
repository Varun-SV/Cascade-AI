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

import { MODELS } from '../constants.js';

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
  deploymentName?: string;
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
  // Non-object entries are left for the validator. This migration runs BEFORE
  // validateConfig() by design, so dereferencing a `null` in a hand-edited
  // providers array threw a bare TypeError and replaced the actionable
  // "providers[0] is invalid" the schema would have produced. Same defensive
  // shape as stripRetiredProviders().
  if (typeof p !== 'object' || p === null) return false;
  if (p.type !== 'anthropic' || !p.authToken) return false;
  return isSubscriptionToken(p.authToken)
    || /claude\s*code/i.test(p.credentialSource ?? '');
}

/**
 * Whether a raw secret is a Claude subscription token, by its mint prefix.
 *
 * Separate from the entry-shaped check above because the secret can arrive
 * without an entry around it: `ANTHROPIC_AUTH_TOKEN` is read straight from the
 * environment by BOTH credential discovery and `injectEnvKeys`, neither of
 * which had any subscription check at all. That was a way around this whole
 * migration — the stored token is stripped on load, and then the same token,
 * exported as a variable, was classified as a usable gateway bearer and put
 * straight back into the config it had just been removed from.
 */
export function isSubscriptionToken(secret: string | undefined): boolean {
  return !!secret && secret.trim().startsWith('sk-ant-oat');
}

/**
 * Strips dead subscription tokens from a provider list, in place of the entry
 * where possible.
 *
 * The ENTRY is kept when it still carries something usable, because deleting a
 * provider row takes more than the dead secret with it. Only when the token was
 * the entry's sole reason to exist is the row removed.
 *
 * What counts as "usable" differs by where the list came from, which is what
 * `keepForEndpoint` selects:
 *
 * - **Local config** (default): an endpoint alone is worth keeping. The user
 *   configured that gateway, and the row is the only record of it.
 * - **An incoming sync bundle**: it is not. The provider merge lets a matching
 *   incoming row win outright, so a row holding nothing but an endpoint would
 *   replace a valid local API key and persist with no credential at all.
 *
 * An API key is worth keeping either way — and a row carrying BOTH a revoked
 * token and a good key is exactly what the settings-save paths fixed in this
 * release used to produce, so dropping it wholesale would lose the key the user
 * added to replace the token.
 */
export function stripRevokedCredentials<T extends CredentialBearingProvider>(
  providers: T[],
  { keepForEndpoint = true }: { keepForEndpoint?: boolean } = {},
): {
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
    const worthKeeping = Boolean(p.apiKey || (keepForEndpoint && p.baseUrl));
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

/**
 * Clears tier pins that named the Anthropic provider that was just removed,
 * mutating in place; returns the tiers cleared.
 *
 * BOTH pin forms. `anthropic:<model>` is the explicit one, but the documented
 * config shape and the setup wizard both write a BARE model id — README's
 * example is `"t1": "claude-opus-4"` — and those are the common case. Matching
 * only the prefixed form left the ordinary pin behind, and the router throws on
 * a pin it cannot resolve rather than falling back to a provider that works.
 *
 * `providers` is the FINAL merged list, and it is what keeps the bare form from
 * over-reaching — see canBeServedElsewhere().
 */
export function clearAnthropicPins(
  models: unknown,
  // Required, not defaulted: a caller that omits it would silently get the
  // over-reaching behaviour this argument exists to prevent, and the compiler
  // is the right place to catch that.
  providers: readonly CredentialBearingProvider[],
): ClearedPin[] {
  const cleared: ClearedPin[] = [];
  if (typeof models !== 'object' || models === null) return cleared;
  const tiers = models as Record<string, unknown>;
  for (const tier of ['t1', 't2', 't3'] as const) {
    const pin = tiers[tier];
    if (typeof pin !== 'string' || !namesAnthropicModel(pin, providers)) continue;
    delete tiers[tier];
    // The model id travels with the tier so the notice can NAME what it
    // removed. A pin cleared in error is then one line to restore, which is
    // what makes erring toward clearing the safer of the two mistakes below.
    cleared.push({ tier, model: pin });
  }
  return cleared;
}

/** A pin the migration removed, and the model it named. */
export interface ClearedPin {
  tier: string;
  model: string;
}

/**
 * Whether a tier pin named the provider that was removed — so clearing it
 * repairs the config rather than discarding a working choice.
 */
function namesAnthropicModel(pin: string, providers: readonly CredentialBearingProvider[]): boolean {
  const value = pin.trim().toLowerCase();
  if (!value) return false;
  // Lowercased to match selector.ts's resolveDynamicModel(), which parses the
  // provider half case-insensitively — `Anthropic:claude-x` is a valid pin.
  // The prefixed form is unambiguous: it names the provider, and that provider
  // is gone.
  if (value.includes(':')) return value.startsWith('anthropic:');
  // A bare id names a MODEL, not a provider, and resolveDynamicModel() accepts
  // any registered model by id whatever vendor its name suggests — so a pin can
  // in principle belong to something other than the provider just removed.
  const known = Object.values(MODELS).some(
    (m) => m.provider === 'anthropic' && m.id.toLowerCase() === value,
  );
  // The `claude-` prefix catches a model newer than this build's catalogue,
  // which is exactly when a pin is most likely to be one it has never heard of.
  if (!known && !value.startsWith('claude-')) return false;
  return !canBeServedElsewhere(value, providers);
}

/**
 * Whether some provider still configured is KNOWN to resolve a bare model id.
 *
 * Known, not "might". Azure is the only case answerable here, because its model
 * ids are its deployment names and those are in the config. `openai-compatible`
 * and `ollama` serve whatever their endpoint offers, discovered at runtime — so
 * their presence says nothing about this id, and an earlier revision treating
 * it as proof got the trade the wrong way round:
 *
 * - Keep a pin the gateway does NOT serve: `resolveDynamicModel()` misses the
 *   registry, infers `anthropic` from the name, finds no such provider, and the
 *   router THROWS on every run. Total failure, repaired only by hand-editing
 *   the config.
 * - Clear a pin the gateway DOES serve: that tier falls back to Auto, and the
 *   migration notice names the tier and the model it removed, so putting it
 *   back is one line.
 *
 * The second is the mistake worth making. Deciding properly needs the
 * gateway's discovered catalogue, which exists only after the router has
 * initialised — long after config load, where this runs.
 */
function canBeServedElsewhere(
  modelId: string,
  providers: readonly CredentialBearingProvider[],
): boolean {
  return providers.some((p) => p
    && p.type === 'azure'
    && (p.deploymentName ?? '').trim().toLowerCase() === modelId);
}
