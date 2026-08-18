// ─────────────────────────────────────────────
//  Cascade AI — which host is this credential scoped to?
// ─────────────────────────────────────────────
//
//  A provider key is issued BY a host and valid only AT that host. Deciding
//  whether a stored key may survive an endpoint edit, or whether a stored
//  endpoint may be adopted, therefore needs one question answered consistently:
//  "are these two configurations the same host?"
//
//  Two things made the generic string comparison wrong for that question.
//
//  **A missing `baseUrl` is not a wildcard.** For anthropic/openai/gemini it
//  means the provider's own public host — that is where the client sends when
//  no endpoint is configured. Reading absence as "compatible with anything"
//  let a public-host key keep its place while a corporate gateway was written
//  in beside it, and the next request sent that key to the gateway. It reached
//  three separate paths: the desktop Settings save, the key-optional onboarding
//  save, and the environment injection inheriting a stored gateway for a bare
//  `ANTHROPIC_API_KEY`.
//
//  **Some spellings are the same host.** The Anthropic SDK appends its own
//  `/v1`, so `https://gw.example` and `https://gw.example/v1` generate against
//  an identical root — `anthropicApiRoot()` says so explicitly and its tests
//  assert it. Comparing them as raw paths made an edit between the two
//  spellings look like a host change and retire a key that was still perfectly
//  valid.

import { normalizeEndpoint, stripVersionSuffix } from '../utils/net.js';

/**
 * Where a provider sends when no `baseUrl` is configured.
 *
 * Only for types that HAVE a default. `openai-compatible` and `azure` have no
 * canonical host — absence there means genuinely unconfigured, not "the public
 * one" — and `ollama` is local and takes no credential worth scoping.
 */
const DEFAULT_ENDPOINT: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
};

/**
 * Providers whose CLIENT owns the version segment, so the URL may be written
 * with or without it and mean the same route.
 *
 * Anthropic and Gemini, and deliberately just those two. Anthropic's SDK
 * concatenates `/v1/messages` onto whatever `baseURL` it is given, and Gemini's
 * appends `/v1beta` to `httpOptions.baseUrl` — which is why `anthropicApiRoot()`
 * and `geminiApiRoot()` both strip a trailing version segment. The two
 * spellings reach an identical wire path.
 * `OpenAICompatibleProvider` does the opposite: it passes `baseUrl` through as
 * the SDK's `baseURL` and builds discovery as `base + '/models'`, so
 * `https://api.groq.com/openai/v1` and `https://api.groq.com/openai` are
 * different routes. Stripping for every type collapsed those into one and let a
 * key survive an edit that moved generation somewhere else.
 */
const CLIENT_OWNS_VERSION = new Set(['anthropic', 'gemini']);

/** Whether absence of `baseUrl` resolves to a known public host for this type. */
export function hasDefaultEndpoint(type: string): boolean {
  return Object.hasOwn(DEFAULT_ENDPOINT, type);
}

/**
 * The host a credential on this row is scoped to, normalized for comparison.
 *
 * Returns `null` only when the type has no default and no endpoint is set —
 * the genuinely unscoped case, where there is nothing to compare and a caller
 * must not infer agreement.
 */
export function credentialEndpointIdentity(type: string, baseUrl?: string): string | null {
  const configured = baseUrl?.trim();
  const effective = configured || DEFAULT_ENDPOINT[type];
  if (!effective) return null;
  // Only where the client appends its own version — see CLIENT_OWNS_VERSION.
  // Everywhere else the path is part of the route and must be preserved, for
  // the same reason `normalizeEndpoint()` preserves path case: a gateway path
  // can be scope-bearing.
  return normalizeEndpoint(
    CLIENT_OWNS_VERSION.has(type) ? stripVersionSuffix(effective) : effective,
  );
}

/**
 * Whether a credential scoped to `a` is still scoped to `b` for this provider.
 *
 * Conservative when it cannot tell: two unscoped configurations are the same
 * (nothing changed), but an unscoped one and a configured one are NOT — that
 * is a host being introduced where there was none, which is exactly the edit
 * that must retire a key.
 */
export function sameCredentialEndpoint(
  type: string,
  a: string | undefined,
  b: string | undefined,
): boolean {
  const left = credentialEndpointIdentity(type, a);
  const right = credentialEndpointIdentity(type, b);
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return left === right;
}

/**
 * Whether an incoming credential belongs somewhere other than where a
 * credentialless row points.
 *
 * ASYMMETRIC, and that is the point — but the two `null`s are NOT the same
 * state, and reading them as one was a leak of its own:
 *
 * - `row === null` means the row names no host. It has no credential of its
 *   own either — that is the only time this is asked — so it is scoped to
 *   nothing and accepts anything, which is what the machine-global store is
 *   for. Resolving ITS absence to the default would be wrong: an empty
 *   `{ type: 'anthropic' }` is a placeholder, not a claim to the public host,
 *   and treating it as one stopped it adopting a gateway entry from the store
 *   at all.
 * - `credential === null` means the incoming credential names no host AND its
 *   provider has no public one to fall back to — an `openai-compatible` key
 *   saved with the URL field left blank, which the desktop permits. Its scope
 *   is UNKNOWN, not universal. Read as "no conflict", a bare Groq key filled a
 *   workspace row addressed to DeepSeek and was sent there.
 *
 * So: a row naming nothing accepts anything; a row naming a host accepts only a
 * credential known to belong to that host. Unknown scope is refused rather than
 * assumed compatible, because the cost of being wrong is a secret delivered to
 * a service that did not issue it — and a credential whose host cannot be named
 * is exactly the one that should never be guessed at.
 */
export function credentialEndpointsConflict(
  type: string,
  rowEndpoint: string | undefined,
  credentialEndpoint: string | undefined,
): boolean {
  const row = rowEndpoint?.trim() ? credentialEndpointIdentity(type, rowEndpoint) : null;
  const credential = credentialEndpointIdentity(type, credentialEndpoint);
  // The placeholder row, which the store exists to complete. Checked FIRST so
  // it still adopts endpoint and credential together even when the credential
  // names no host of its own — an Azure row carrying only a deployment name is
  // the ordinary case.
  if (row === null) return false;
  // A named row against a credential of unknown scope. Nothing here says they
  // belong together, and only `openai-compatible`-shaped types can reach it,
  // since every type with a public default resolves to one.
  if (credential === null) return true;
  return row !== credential;
}
