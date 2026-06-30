// ─────────────────────────────────────────────
//  Cascade AI — local network helpers
// ─────────────────────────────────────────────
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

// Node resolves `localhost` to IPv6 `::1` first, but local model servers bind
// IPv4 `127.0.0.1` by default. Prefer IPv4 resolution process-wide.
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older Node — ignore */ }

/** Rewrite a literal `localhost` host to `127.0.0.1` (force IPv4). */
export function preferIpv4Host(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1');
}

// A fetch() implemented on Node's http/https modules. In the Electron MAIN
// process the global fetch (undici) — and Chromium's net.fetch — can fail to
// reach loopback model servers even when a child Node process and the renderer
// reach the same URL fine (confirmed live: child `http.get`/`fetch` → 200, app
// discovery → unreachable). Node's lower-level http module does not have that
// problem, so OpenAI-compatible / local endpoints use this for discovery AND
// generation (it returns a streaming Response, so SSE chat completions work).
export async function nodeHttpFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? https : http;
  const method = (init.method ?? 'GET').toUpperCase();

  const headers: Record<string, string> = {};
  const h = init.headers;
  if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
  else if (h) Object.assign(headers, h as Record<string, string>);

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
        const stream = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
        const respHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) respHeaders.set(k, v.join(', '));
          else if (typeof v === 'string') respHeaders.set(k, v);
        }
        resolve(new Response(stream, {
          status: res.statusCode ?? 200,
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
