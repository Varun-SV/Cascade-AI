// Where the docs live in the URL, and how an address maps to a page.
//
//   /docs            the docs home
//   /docs/<topic>    one page
//   /docs#privacy    the old single-page address; it opens /docs/privacy
//
// Kept free of React so the mapping can be tested on its own, and so the
// (lazy) docs bundle is not needed just to decide whether a URL is a docs URL.

export const DOCS_BASE = '/docs';

/** Whether a pathname belongs to the docs (and so to the docs bundle). */
export function isDocsPath(pathname: string): boolean {
  return pathname === DOCS_BASE || pathname === `${DOCS_BASE}/` || pathname.startsWith(`${DOCS_BASE}/`);
}

/**
 * The old /docs was one page of sections reached by #hash, and the landing page
 * still links to /docs#privacy. Each old section id now has a page of its own.
 */
export const LEGACY_HASHES: Readonly<Record<string, string>> = {
  what: 'overview',
  quickstart: 'quick-start',
  keys: 'providers-and-keys',
  tiers: 'how-tiers-route',
  files: 'file-generation',
  api: 'openai-api',
  privacy: 'privacy',
};

export type DocsLocation =
  | { kind: 'home' }
  | { kind: 'page'; slug: string; anchor: string | null }
  | { kind: 'missing'; slug: string };

/** The page an address names. `slugs` is the set of pages that exist. */
export function parseDocsLocation(pathname: string, hash: string, slugs: ReadonlySet<string>): DocsLocation {
  const clean = pathname.replace(/\/+$/, '');
  const rest = clean === DOCS_BASE ? '' : clean.slice(DOCS_BASE.length + 1);
  const anchor = hash ? decodeAnchor(hash) : null;
  if (!rest) {
    const legacy = anchor ? LEGACY_HASHES[anchor] : undefined;
    return legacy && slugs.has(legacy) ? { kind: 'page', slug: legacy, anchor: null } : { kind: 'home' };
  }
  let slug = rest;
  try { slug = decodeURIComponent(rest); } catch { /* keep as typed */ }
  return slugs.has(slug) ? { kind: 'page', slug, anchor } : { kind: 'missing', slug };
}

function decodeAnchor(hash: string): string {
  try { return decodeURIComponent(hash); } catch { return hash; }
}

export const docsHref = (slug?: string, anchor?: string): string =>
  `${DOCS_BASE}${slug ? `/${slug}` : ''}${anchor ? `#${anchor}` : ''}`;
