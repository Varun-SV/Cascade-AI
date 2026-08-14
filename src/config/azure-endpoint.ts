// ─────────────────────────────────────────────
//  Cascade AI — Azure endpoint identity
// ─────────────────────────────────────────────
//
//  Azure is the one provider configured with several entries — one per
//  deployment — so code repeatedly has to ask "are these two rows the same
//  resource?" and "is this the row that deployment lives in?". Every one of
//  those questions was being answered by comparing the endpoint strings as
//  typed.
//
//  `AzureOpenAIProvider` strips trailing slashes off `baseUrl` before it builds
//  a client, so `https://acme.openai.azure.com` and the same URL with a
//  trailing slash reach exactly the same service. Comparing them raw makes them
//  two different resources, and every caller gets that wrong in its own way: a
//  key lands on nothing, or `cascade link` appends a duplicate deployment row
//  and reports success while the router — which takes the FIRST row matching a
//  deployment name — keeps using the keyless original.
//
//  One normalizer, used everywhere an Azure endpoint is compared for identity,
//  so the answer cannot differ between call sites.

/**
 * An Azure endpoint reduced to what identifies the resource.
 *
 * Trailing slashes go because the provider drops them anyway; case goes because
 * the meaningful part is a hostname, which is case-insensitive, and Azure
 * endpoints carry no path to speak of. A missing or blank endpoint normalizes
 * to the empty string, so rows with no endpoint compare equal to each other and
 * to nothing else.
 */
export function normalizeAzureEndpoint(url: string | undefined | null): string {
  return (url ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/** Whether two Azure endpoints name the same resource. */
export function sameAzureEndpoint(a: string | undefined | null, b: string | undefined | null): boolean {
  return normalizeAzureEndpoint(a) === normalizeAzureEndpoint(b);
}
