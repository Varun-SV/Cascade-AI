// ─────────────────────────────────────────────
//  Cascade Desktop — Address-bar parsing
// ─────────────────────────────────────────────
//
// Split out from browser.ts so it can be tested without importing electron.

/**
 * Only http(s). A `file://` or `javascript:` URL typed into the address bar
 * would be a local-file read or a script injection dressed up as navigation.
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // `://`, not just `:`. A bare `scheme:` test also matches `localhost:3000`
  // and `example.com:8443`, so those were left un-prefixed and then rejected as
  // protocol `localhost:` — the address bar refused to open a dev server.
  // Anything without `://` gets https:// and must still survive URL parsing,
  // which is what keeps `javascript:alert(1)` and `data:…` out (they become an
  // invalid port and throw).
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A typed string that isn't an address is a search, the way any browser behaves. */
export function toNavigable(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.includes(' ')) return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;

  // An explicit scheme is always an address.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return normalizeUrl(raw);

  const host = raw.split(/[/?#]/, 1)[0] ?? '';
  const looksLikeUrl =
    // A dotted host: example.com, example.com/x, example.com:8080, example.com?q=1
    /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(host)
    // localhost — this is a developer's browser, and searching the web for
    // "localhost:3000" instead of opening the dev server is never what was meant.
    || /^localhost(:\d+)?$/i.test(host)
    // Bare IPv4, and bracketed IPv6 including the [::1] loopback.
    || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)
    || /^\[[0-9a-f:]+\](:\d+)?$/i.test(host);

  if (looksLikeUrl) return normalizeUrl(raw);
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
}
