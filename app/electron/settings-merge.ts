// ─────────────────────────────────────────────
//  Cascade AI — desktop Settings save decisions
// ─────────────────────────────────────────────
//
//  The two questions the settings save has to answer about a credential when
//  the user edits an endpoint. Both were previously answered inline, and both
//  answered wrongly, because the key field and the endpoint field were treated
//  as independent when they are not: a provider key is issued BY a host and
//  valid only AT that host.
//
//  Pure and exported so they can be tested at all — the originals lived inside
//  an `ipcMain.handle` body in a 900-line file, which is why neither had a test.

/**
 * Comparison injected so the desktop uses the SDK's rule, not a second copy.
 *
 * Provider-AWARE: a missing `baseUrl` means the provider's own public host for
 * anthropic/openai/gemini, not "compatible with anything", and Anthropic's
 * optional `/v1` suffix names the same root. Taking a generic string compare
 * here is what let a public-host key survive a gateway being typed in beside
 * it.
 */
type SameCredentialEndpoint = (type: string, a?: string, b?: string) => boolean;

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
 *
 * The underlying rule is unchanged: a provider key is issued BY a host and valid
 * only AT that host, so an endpoint edit with nothing typed retires the
 * credential that was paired with it.
 */
export function credentialDispositionForEdit(
  existing: { type: string; baseUrl?: string },
  nextBaseUrl: string | undefined,
  replacementKey: string | undefined,
  sameCredentialEndpoint: SameCredentialEndpoint,
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
 * The prior Azure row a saved deployment may inherit its key from.
 *
 * Matched on deployment name AND resource. An Azure key is resource-scoped, so
 * matching the name alone meant moving deployment "prod" from resource A to
 * resource B with a blank key field copied A's key onto B — a credential sent
 * to a resource that never issued it.
 */
export function priorAzureRow<T extends { deploymentName?: string; baseUrl?: string }>(
  prior: readonly T[],
  incoming: { deploymentName?: string; baseUrl?: string },
  // Azure keeps the plain host comparison: a deployment row always names its
  // resource explicitly, so there is no default to resolve.
  sameAzureEndpoint: (a: string | undefined | null, b: string | undefined | null) => boolean,
): T | undefined {
  if (!incoming.deploymentName) return undefined;
  return prior.find((p) => p.deploymentName === incoming.deploymentName
    && sameAzureEndpoint(p.baseUrl, incoming.baseUrl));
}

/** The two mutable surfaces the settings save needs from the SDK. */
export interface SettingsMergeDeps {
  applyProviderApiKey: (
    providers: Array<{ type: string; apiKey?: string; authToken?: string; baseUrl?: string }>,
    type: string,
    apiKey: string,
    extra?: { baseUrl?: string },
  ) => void;
  sameCredentialEndpoint: SameCredentialEndpoint;
}

/**
 * Apply ONE provider's endpoint edit, retiring the credential when the host
 * changes and nothing was typed to replace it.
 *
 * Exported because `cascade:setConfig` — the key-optional onboarding save —
 * writes an endpoint through a different path and bypassed
 * `applySettingsCredentials()` entirely, so an OpenAI-compatible row could have
 * its endpoint changed with a blank key and keep the old host's key attached.
 * Two save paths, one rule.
 */
export function applyEndpointEdit(
  existing: { type: string; apiKey?: string; authToken?: string; baseUrl?: string },
  nextBaseUrl: string | undefined,
  replacementKey: string | undefined,
  deps: Pick<SettingsMergeDeps, 'sameCredentialEndpoint'>,
): void {
  if (credentialDispositionForEdit(existing, nextBaseUrl, replacementKey, deps.sameCredentialEndpoint) === 'clear') {
    existing.apiKey = undefined;
    existing.authToken = undefined;
  }
  existing.baseUrl = nextBaseUrl || undefined;
}

/**
 * Apply the non-Azure `keys` and `endpoints` halves of a settings save, in order.
 *
 * The ORDER is the whole point, and it is why this is one function rather than
 * two loops in the IPC handler. Keys are written first and endpoints second, so
 * the endpoint step has to know that a key it is about to consider retiring may
 * be the one just written. Expressed as two loops with a boolean between them,
 * that knowledge went missing and the save deleted the key it had installed a
 * few lines earlier — with no test able to see it, because the loops lived
 * inside `ipcMain.handle`.
 */
export function applySettingsCredentials(
  providers: Array<{ type: string; apiKey?: string; authToken?: string; baseUrl?: string }>,
  data: {
    keys?: Record<string, string | undefined>;
    endpoints?: Record<string, string | undefined>;
  },
  deps: SettingsMergeDeps,
): void {
  if (data.keys) {
    for (const [type, apiKey] of Object.entries(data.keys)) {
      if (!apiKey) continue; // blank means "keep the existing key"
      deps.applyProviderApiKey(providers, type, apiKey);
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
    applyEndpointEdit(existing, baseUrl, data.keys?.[type], deps);
  }
}
