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
  // The version segment is dropped for every type, not only Anthropic: it is
  // the provider client that owns it, and no provider distinguishes two hosts
  // by it. Doing it here keeps this answer identical to `anthropicApiRoot()`.
  return normalizeEndpoint(stripVersionSuffix(effective));
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
