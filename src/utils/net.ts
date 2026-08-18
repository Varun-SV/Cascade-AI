// ─────────────────────────────────────────────
//  Cascade AI — local network helpers
// ─────────────────────────────────────────────
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

// Node resolves `localhost` to IPv6 `::1` first, but local model servers bind
// IPv4 `127.0.0.1` by default. Prefer IPv4 resolution process-wide.
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older Node — ignore */ }

/** 
 * Keep localhost intact. Node's `dns.setDefaultResultOrder('ipv4first')` handles IPv4 priority process-wide.
 * We no longer forcefully rewrite `localhost` to `127.0.0.1` as it breaks IPv6-only environments (e.g. ::1).
 */
export function preferIpv4Host(url: string | undefined): string | undefined {
  return url;
}

/**
 * Drop trailing `/` characters from a URL, in linear time.
 *
 * Written as a scan rather than `replace(/\/+$/, '')` because that regex is
 * polynomial: the engine retries the anchored repetition from every start
 * position, so a string of many slashes costs O(n²). CodeQL flags it as a
 * ReDoS risk on any function reachable with caller-supplied input, which the
 * endpoint normalizers are. The behaviour is identical for every input.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === value.length ? value : value.slice(0, end);
}

/**
 * An endpoint URL reduced to what identifies the host it addresses.
 *
 * Trailing slashes go because every provider client drops them anyway; case
 * goes because the meaningful part is a hostname, which is case-insensitive.
 * A missing or blank endpoint normalizes to the empty string, so rows with no
 * endpoint compare equal to each other and to nothing else.
 *
 * Lives here rather than in `azure-endpoint.ts` because the question is not
 * Azure's: "is this bearer's gateway the same host as the one already
 * configured?" needs the identical normalization, and writing it out a second
 * time is how two call sites start disagreeing about what "same endpoint"
 * means.
 */
export function normalizeEndpoint(url: string | undefined | null): string {
  const raw = stripTrailingSlashes((url ?? '').trim());
  if (!raw) return '';
  try {
    const u = new URL(raw);
    // Scheme and host are case-insensitive by spec. THE PATH IS NOT, and
    // lowercasing it made `https://gw.example/TenantA` and `/tenanta` the same
    // endpoint — which, since this decides whether a stored credential may be
    // adopted into a row, would authorize moving a key between two distinct
    // tenant routes on one gateway.
    const path = stripTrailingSlashes(`${u.pathname}${u.search}`);
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    // Not a parseable URL — nothing to reason about structurally, so fall back
    // to the old whole-string rule. Two identical strings still compare equal,
    // which is all a non-URL can support.
    return raw.toLowerCase();
  }
}

/** Whether two endpoint URLs address the same host. */
export function sameEndpoint(a: string | undefined | null, b: string | undefined | null): boolean {
  return normalizeEndpoint(a) === normalizeEndpoint(b);
}

/** Max redirect hops before nodeHttpFetch gives up (matches browser/curl-ish defaults). */
const MAX_REDIRECTS = 5;

/**
 * `fetch`, following redirects only while they stay on the ORIGINAL origin.
 *
 * The platform's own rule is not enough here. On a cross-origin redirect the
 * fetch spec strips `Authorization`, `Cookie` and friends — but a custom header
 * is not on that list, so `x-api-key` is replayed verbatim to wherever the
 * `Location` points. A provider's model-list request carries exactly that
 * header, so a gateway that is misconfigured or compromised could hand a user's
 * key to a third host, which is the same class of leak as sending a gateway's
 * key to `api.anthropic.com`.
 *
 * Same-origin hops are still followed, because endpoints legitimately
 * canonicalise paths (a trailing slash, `/models` → `/models/`). This is the
 * policy `nodeHttpFetch`'s `allowedRedirectOrigin` already applies, expressed
 * for callers that use the global fetch.
 */
export async function fetchSameOrigin(
  url: string,
  init: RequestInit = {},
  maxRedirects = MAX_REDIRECTS,
): Promise<Response> {
  const origin = new URL(url).origin;
  let current = url;
  let options: RequestInit = { ...init };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(current, { ...options, redirect: 'manual' });
    // Only the statuses Fetch itself treats as redirects. 300, 304 and 305 can
    // carry a `Location` without being one, and following a 304 in particular
    // would turn a cache revalidation into a second request.
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    // The redirect's own body is drained before the next request goes out.
    // Undici cannot reuse a connection whose body is still unread, so a chain
    // of redirects would tie up a socket each, and a redirect that streams
    // indefinitely would hold one open for as long as it kept writing.
    await res.body?.cancel().catch(() => { /* already consumed or closed */ });
    const next = new URL(location, current);
    if (next.origin !== origin) {
      throw new Error(
        `Refusing cross-origin redirect to ${next.origin}: the request carries a credential for ${origin}.`,
      );
    }
    // Fetch's own method/body transitions, which following blindly would skip:
    // 303 always becomes GET, and 301/302 do for POST. Replaying the original
    // POST body at the redirect target would re-submit a generation request —
    // duplicating it, or failing a gateway's result/poll redirect outright.
    // 307/308 exist precisely to preserve the method, and are left alone.
    const method = (options.method ?? 'GET').toUpperCase();
    const downgrades = res.status === 303
      ? method !== 'GET' && method !== 'HEAD'
      : (res.status === 301 || res.status === 302) && method === 'POST';
    if (downgrades) {
      const headers = new Headers(options.headers as Record<string, string> | undefined);
      // The body is gone, so its framing headers must go with it.
      for (const h of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) {
        headers.delete(h);
      }
      options = { ...options, method: 'GET', body: undefined, headers };
    }
    current = next.toString();
  }
  throw new Error(`Too many redirects from ${url}`);
}

// A fetch() implemented on Node's http/https modules. In the Electron MAIN
// process the global fetch (undici) — and Chromium's net.fetch — can fail to
// reach loopback model servers even when a child Node process and the renderer
// reach the same URL fine (confirmed live: child `http.get`/`fetch` → 200, app
// discovery → unreachable). Node's lower-level http module does not have that
// problem, so OpenAI-compatible / local endpoints use this for discovery AND
// generation (it returns a streaming Response, so SSE chat completions work).
//
// Unlike a bare `http.request`, this follows redirects and transparently
// decompresses gzip/deflate/br bodies — otherwise an endpoint that canonicalises
// `/models` with a 3xx redirect, or sits behind a proxy that gzips responses,
// looks "unreachable" even though a browser/curl reach it fine.
export interface NodeHttpFetchOptions {
  /**
   * When set, every redirect hop (not just the initial request) must resolve
   * to this exact origin, or the fetch rejects instead of following it. For
   * a caller sending a credential in `init.headers` (a bearer token, a PAT),
   * omitting this means that credential is replayed on ANY origin a 3xx
   * response points to — a malicious or misconfigured redirect, including an
   * HTTPS→HTTP downgrade, would silently exfiltrate it, since `init` (and
   * its headers) is reused verbatim on the followed request below. Every
   * existing caller omits this and keeps today's follow-anywhere behaviour
   * unchanged; it exists for exactly the callers that attach a credential.
   */
  allowedRedirectOrigin?: string;
}

export async function nodeHttpFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  redirectCount = 0,
  opts: NodeHttpFetchOptions = {},
): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(preferIpv4Host(urlStr) ?? urlStr);
  const lib = u.protocol === 'https:' ? https : http;
  const method = (init.method ?? 'GET').toUpperCase();

  const headers: Record<string, string> = {};
  const h = init.headers;
  if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
  else if (h) Object.assign(headers, h as Record<string, string>);

  // Advertise the encodings we can decode (unless the caller set their own).
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) {
    headers['accept-encoding'] = 'gzip, deflate, br';
  }

  const body = init.body == null ? undefined
    : typeof init.body === 'string' ? init.body
    : Buffer.from(init.body as unknown as ArrayBuffer);

  return new Promise<Response>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 200;

        // Follow redirects so endpoints that canonicalise paths (trailing slash,
        // http→https, reverse-proxy rewrites) still resolve to the real response.
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirectCount < MAX_REDIRECTS) {
          res.resume(); // drain the redirect body so the socket can be reused
          const nextUrl = new URL(location, u).href;
          if (opts.allowedRedirectOrigin && new URL(nextUrl).origin !== opts.allowedRedirectOrigin) {
            reject(new Error(`Refusing cross-origin redirect to ${new URL(nextUrl).origin}`));
            return;
          }
          // 303 (and legacy 301/302 on non-GET) downgrade to GET without a body;
          // 307/308 preserve method + body.
          const downgrade = status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD');
          const nextInit: RequestInit = downgrade
            ? { ...init, method: 'GET', body: undefined }
            : init;
          resolve(nodeHttpFetch(nextUrl, nextInit, redirectCount + 1, opts));
          return;
        }

        // Transparently decompress per Content-Encoding. createGunzip/Inflate/
        // BrotliDecompress are transform streams, so streaming SSE still streams.
        const encoding = (res.headers['content-encoding'] ?? '').toLowerCase();
        let bodyStream: Readable = res;
        if (encoding === 'gzip' || encoding === 'x-gzip') bodyStream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') bodyStream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') bodyStream = res.pipe(zlib.createBrotliDecompress());

        const stream = Readable.toWeb(bodyStream) as unknown as ReadableStream<Uint8Array>;
        const respHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          // The body is now decoded — drop headers that describe the wire encoding
          // so consumers don't try to decompress again or trust a stale length.
          if (k === 'content-encoding' || k === 'content-length') continue;
          if (Array.isArray(v)) respHeaders.set(k, v.join(', '));
          else if (typeof v === 'string') respHeaders.set(k, v);
        }
        resolve(new Response(stream, {
          status,
          statusText: res.statusMessage ?? '',
          headers: respHeaders,
        }));
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
