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

/** Max redirect hops before nodeHttpFetch gives up (matches browser/curl-ish defaults). */
const MAX_REDIRECTS = 5;

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
export async function nodeHttpFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  redirectCount = 0,
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
          // 303 (and legacy 301/302 on non-GET) downgrade to GET without a body;
          // 307/308 preserve method + body.
          const downgrade = status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD');
          const nextInit: RequestInit = downgrade
            ? { ...init, method: 'GET', body: undefined }
            : init;
          resolve(nodeHttpFetch(nextUrl, nextInit, redirectCount + 1));
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
