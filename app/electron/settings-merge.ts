// ─────────────────────────────────────────────
//  Cascade AI — desktop Settings save decisions
// ─────────────────────────────────────────────
//
//  What is left here after the rest moved into the SDK.
//
//  The key/endpoint rules used to live in this file so the desktop could test
//  them without loading the core bundle. That turned out to be the wrong trade:
//  the live dashboard needed exactly the same rules, could not import from
//  `app/electron`, and grew its own copy — which then diverged, twice. They now
//  live in `src/config/credential-write.ts` and reach `main.ts` through
//  `loadCore()`, the same route as every other core helper.
//
//  Azure stays. It is addressed per deployment rather than by provider type, so
//  it has no `keys`/`endpoints` entry to share and its own identity predicate.

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
