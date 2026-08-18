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

/** Comparison injected so the desktop uses the SDK's rule, not a second copy. */
type SameEndpoint = (a: string | undefined | null, b: string | undefined | null) => boolean;

/**
 * Whether a stored credential survives an endpoint edit.
 *
 * A blank key field means "keep the existing key", which is right when the
 * endpoint has not moved and wrong when it has: pointing an OpenAI-compatible
 * provider at a different host without typing a new key moved the old host's
 * key onto the new one. A key typed in the SAME save is the replacement, so it
 * wins and the old credential goes either way.
 */
export function keepsCredentialAcrossEdit(
  existing: { baseUrl?: string },
  nextBaseUrl: string | undefined,
  replacementKey: string | undefined,
  sameEndpoint: SameEndpoint,
): boolean {
  if (replacementKey) return false;          // replaced outright — nothing to keep
  if (!existing.baseUrl) return true;        // had no endpoint to be scoped to
  if (!nextBaseUrl) return false;            // endpoint cleared — the pairing is gone
  return sameEndpoint(existing.baseUrl, nextBaseUrl);
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
  sameAzureEndpoint: SameEndpoint,
): T | undefined {
  if (!incoming.deploymentName) return undefined;
  return prior.find((p) => p.deploymentName === incoming.deploymentName
    && sameAzureEndpoint(p.baseUrl, incoming.baseUrl));
}
