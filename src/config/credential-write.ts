// ─────────────────────────────────────────────
//  Cascade AI — writing a credential and the host it belongs to
// ─────────────────────────────────────────────
//
//  A provider key is issued BY a host and valid only AT that host, so a write
//  that sets one without deciding the other is incomplete. Three surfaces —
//  desktop onboarding, desktop Settings, and the live dashboard — each answered
//  that second question on their own, and each answered it differently. This
//  module is where it is answered once.
//
//  The hard part is not the rule. It is that an endpoint field can be ABSENT
//  for two unrelated reasons, and they demand opposite behaviour:
//
//    - the user was shown the field and left it blank — the key is scoped to
//      the provider's public host, and a stored gateway must be retired;
//    - the surface never had the field — nothing has been said, and whatever
//      the row already names must stand.
//
//  Deriving that from `baseUrl === undefined` cannot distinguish them, and
//  guessing either way leaks: guess "public" and a rotated gateway key is sent
//  to the provider's own API; guess "preserve" and a fresh public key is sent
//  to a corporate gateway. Both were observed. So callers state which case they
//  are in, and only a caller that genuinely exposes an endpoint channel is
//  allowed to read absence as a claim about scope.

import { applyProviderApiKey } from './index.js';
import { hasDefaultEndpoint, sameCredentialEndpoint } from './endpoint-identity.js';

/** A provider row, as every settings surface manipulates it. */
export interface WritableProvider {
  type: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  /** See `isLocalEndpoint` in core/router/pricing.ts. */
  local?: boolean;
}

/**
 * What the caller is able to say about where the key it is writing belongs.
 *
 * Not an endpoint value — a statement about the SURFACE. That is the whole
 * point: `{ kind: 'provider-default' }` and `{ kind: 'preserve' }` both carry
 * no URL and mean opposite things, and only the caller knows which it is.
 */
export type CredentialEndpoint =
  /** The user named a host in the same save. The key belongs there. */
  | { kind: 'at'; baseUrl: string }
  /**
   * The caller HAS an endpoint field and the user left it empty. For a provider
   * with a public host that is a claim: the key belongs to that host, and a
   * stored gateway is retired with the key it was paired with.
   */
  | { kind: 'provider-default' }
  /**
   * The caller has no endpoint field for this provider at all — desktop
   * Settings and the dashboard expose one only for `openai-compatible` and
   * Ollama, and onboarding only for `openai-compatible`.
   *
   * Absence here is a limit of the surface, not evidence, so the row keeps
   * whatever it already names. A user rotating their gateway's API key has no
   * way to re-state the gateway, and reading the empty field as "public host"
   * moved the new gateway-issued key to the provider's own API.
   */
  | { kind: 'preserve' };

/**
 * Read the intent out of a settings payload's `endpoints` map.
 *
 * The KEY's presence is the signal, not its value. A surface that can address a
 * provider's endpoint sends an entry for it — possibly `undefined`, meaning the
 * field was shown and left blank — and one that cannot sends no entry at all.
 * That distinction is exactly the one `CredentialEndpoint` needs and the only
 * place it survives.
 */
export function endpointFromSettingsPayload(
  endpoints: Record<string, string | undefined> | undefined,
  type: string,
): CredentialEndpoint {
  if (!endpoints || !Object.hasOwn(endpoints, type)) return { kind: 'preserve' };
  const baseUrl = endpoints[type]?.trim();
  return baseUrl ? { kind: 'at', baseUrl } : { kind: 'provider-default' };
}

/** The host this key will actually be used at once the write lands. */
function targetEndpoint(
  type: string,
  endpoint: CredentialEndpoint,
  existing: WritableProvider | undefined,
): string | undefined {
  switch (endpoint.kind) {
    case 'at':
      return endpoint.baseUrl;
    case 'provider-default':
      // A type with no public host has nowhere to fall back to, so an empty
      // field there means "unconfigured", not "the default one" — and clearing
      // the URL would leave the key addressing nothing at all.
      return hasDefaultEndpoint(type) ? undefined : existing?.baseUrl;
    case 'preserve':
      return existing?.baseUrl;
  }
}

/**
 * Write a user-supplied key together with the host it belongs to.
 *
 * `applyProviderApiKey()` only touches `baseUrl` when it is handed one, which
 * is right for the field and wrong for the pairing — so every surface that
 * wrote a key through it kept whatever host was already on the row. Callers go
 * through here instead, and say what they know.
 */
export function applyProviderCredential(
  providers: WritableProvider[],
  type: string,
  apiKey: string,
  endpoint: CredentialEndpoint,
): void {
  const existing = providers.find((p) => p.type === type);
  const nextBaseUrl = targetEndpoint(type, endpoint, existing);
  if (existing && !sameCredentialEndpoint(type, existing.baseUrl, nextBaseUrl)) {
    // `local` is a statement about the endpoint being replaced, not about the
    // provider. `isLocalEndpoint()` gives an explicit `local` precedence over
    // inference from the URL, so carrying it across a host change prices every
    // model at the new endpoint as free and slips the budget caps. Deleted
    // rather than recomputed: absence is what makes `isLocalEndpoint()` read
    // the new URL.
    delete existing.local;
  }
  // Cleared BEFORE the write, so `applyProviderApiKey` cannot re-attach it.
  if (existing && nextBaseUrl === undefined) existing.baseUrl = undefined;
  applyProviderApiKey(providers, type, apiKey, nextBaseUrl ? { baseUrl: nextBaseUrl } : {});
}

/** What happens to the credential already on a row when its endpoint is edited. */
export type CredentialDisposition =
  /** Nothing typed, and the endpoint still identifies the same host — it stays. */
  | 'keep'
  /** The endpoint moved or was cleared with nothing typed — the pairing is gone. */
  | 'clear'
  /** A key was typed in this save; it is the credential now, and must not be touched. */
  | 'replaced';

/**
 * What becomes of a stored credential when the endpoint field is edited.
 *
 * Three outcomes, not two. This started life as a boolean "does the credential
 * survive?", and the caller read `false` as "delete the credential" — so a save
 * carrying BOTH a new key and a new endpoint wrote the key and then deleted it,
 * because `false` also meant "a replacement was supplied". A user typing a key
 * into Settings watched it vanish. `'replaced'` exists so that case cannot be
 * confused with `'clear'` again.
 */
export function credentialDispositionForEdit(
  existing: { type: string; baseUrl?: string },
  nextBaseUrl: string | undefined,
  replacementKey: string | undefined,
): CredentialDisposition {
  if (replacementKey) return 'replaced';
  // No `!existing.baseUrl → keep` shortcut. That read absence as "this key was
  // never scoped to anywhere", but for a default-host provider it means the key
  // IS scoped — to the public host. Typing a gateway with the key field left
  // blank therefore kept a console.anthropic.com key and pointed it at the
  // gateway.
  return sameCredentialEndpoint(existing.type, existing.baseUrl, nextBaseUrl) ? 'keep' : 'clear';
}

/**
 * Apply ONE provider's endpoint edit, retiring the credential when the host
 * changes and nothing was typed to replace it.
 *
 * This is the endpoint-ONLY half — the key field left blank. It is reached from
 * three places (onboarding, the Settings save, and the live dashboard), and the
 * dashboard did not reach it at all until the sibling was noticed: a standalone
 * `cascade dashboard` reported a saved endpoint change it had never applied.
 */
export function applyEndpointEdit(
  existing: WritableProvider,
  nextBaseUrl: string | undefined,
  replacementKey: string | undefined,
): void {
  if (credentialDispositionForEdit(existing, nextBaseUrl, replacementKey) === 'clear') {
    existing.apiKey = undefined;
    existing.authToken = undefined;
  }
  // Endpoint-scoped state does not survive the endpoint. See the note in
  // `applyProviderCredential`; `cascade link` has done this since the same
  // defect was found on its side.
  if (!sameCredentialEndpoint(existing.type, existing.baseUrl, nextBaseUrl)) {
    delete existing.local;
  }
  existing.baseUrl = nextBaseUrl || undefined;
}

/** The non-Azure halves of a settings save. */
export interface SettingsCredentialPayload {
  keys?: Record<string, string | undefined>;
  endpoints?: Record<string, string | undefined>;
}

/**
 * Apply the non-Azure `keys` and `endpoints` halves of a settings save, in order.
 *
 * The ORDER is the whole point, and it is why this is one function rather than
 * two loops in each caller. Keys are written first and endpoints second, so the
 * endpoint step has to know that a key it is about to consider retiring may be
 * the one just written. Expressed as two loops with a boolean between them,
 * that knowledge went missing and the save deleted the key it had installed a
 * few lines earlier — with no test able to see it, because the loops lived
 * inside `ipcMain.handle`.
 */
export function applySettingsCredentials(
  providers: WritableProvider[],
  data: SettingsCredentialPayload,
): void {
  if (data.keys) {
    for (const [type, apiKey] of Object.entries(data.keys)) {
      if (!apiKey) continue; // blank means "keep the existing key"
      applyProviderCredential(providers, type, apiKey, endpointFromSettingsPayload(data.endpoints, type));
    }
  }
  if (!data.endpoints) return;
  for (const [type, baseUrl] of Object.entries(data.endpoints)) {
    // Azure is addressed per deployment and goes through its own field.
    if (baseUrl === undefined || type === 'azure') continue;
    const existing = providers.find((p) => p.type === type);
    if (!existing) {
      if (baseUrl) providers.push({ type, baseUrl });
      continue;
    }
    applyEndpointEdit(existing, baseUrl, data.keys?.[type]);
  }
}
