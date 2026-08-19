import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { fetchSameOrigin, nodeHttpFetch, preferIpv4Host, sameEndpoint, stripTrailingSlashes } from './net.js';

const MODELS = JSON.stringify({
  object: 'list',
  data: [{ id: 'qwen2.5-7b', object: 'model' }, { id: 'llama-3-8b', object: 'model' }],
});

let server: http.Server;
let base: string;
// A second, independently-listening server on a DIFFERENT port — origin
// includes the port, so this is a genuinely different origin from `base`,
// standing in for an attacker-controlled host a malicious/misconfigured
// redirect could point at.
let evilServer: http.Server;
let evilBase: string;
let evilHits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case '/v1/models':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(MODELS);
      case '/v1/models-gzip':
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        return res.end(zlib.gzipSync(Buffer.from(MODELS)));
      case '/v1/models-deflate':
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' });
        return res.end(zlib.deflateSync(Buffer.from(MODELS)));
      case '/v1/models-br':
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' });
        return res.end(zlib.brotliCompressSync(Buffer.from(MODELS)));
      case '/v1/models-307':
        res.writeHead(307, { Location: '/v1/models' });
        return res.end();
      case '/v1/models-308':
        res.writeHead(308, { Location: '/v1/models' });
        return res.end();
      case '/v1/models-redirect-same-origin':
        res.writeHead(302, { Location: `${base}/v1/models` });
        return res.end();
      default:
        if (req.url === '/v1/models-redirect-external') {
          res.writeHead(302, { Location: `${evilBase}/v1/models` });
          return res.end();
        }
        res.writeHead(404);
        return res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  evilServer = http.createServer((req, res) => {
    evilHits.push(req.url ?? '');
    // Answers with a valid body — the point of the fix is that this response
    // must never be REACHED, not that the body would be unusable if it were.
    res.writeHead(200, { 'Content-Type': 'application/json', Authorization: 'leaked' });
    res.end(MODELS);
  });
  await new Promise<void>((r) => evilServer.listen(0, '127.0.0.1', r));
  const { port: evilPort } = evilServer.address() as AddressInfo;
  evilBase = `http://127.0.0.1:${evilPort}`;
});

afterAll(() => Promise.all([
  new Promise<void>((r) => server.close(() => r())),
  new Promise<void>((r) => evilServer.close(() => r())),
]));

async function countModels(path: string): Promise<{ ok: boolean; status: number; count: number }> {
  const res = await nodeHttpFetch(base + path, { headers: { Accept: 'application/json' } });
  const body = (await res.json()) as { data?: unknown[]; models?: unknown[] };
  const raw = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return { ok: res.ok, status: res.status, count: raw.length };
}

describe('nodeHttpFetch', () => {
  it('reads a plain JSON model list', async () => {
    expect(await countModels('/v1/models')).toEqual({ ok: true, status: 200, count: 2 });
  });

  it('transparently decompresses gzip responses', async () => {
    expect(await countModels('/v1/models-gzip')).toEqual({ ok: true, status: 200, count: 2 });
  });

  it('transparently decompresses deflate responses', async () => {
    expect(await countModels('/v1/models-deflate')).toEqual({ ok: true, status: 200, count: 2 });
  });

  it('transparently decompresses brotli responses', async () => {
    expect(await countModels('/v1/models-br')).toEqual({ ok: true, status: 200, count: 2 });
  });

  it('follows a 307 redirect', async () => {
    expect(await countModels('/v1/models-307')).toEqual({ ok: true, status: 200, count: 2 });
  });

  it('follows a 308 redirect', async () => {
    expect(await countModels('/v1/models-308')).toEqual({ ok: true, status: 200, count: 2 });
  });

  it('follows a cross-origin redirect by default, unchanged for every existing caller', async () => {
    // Backward compatibility: allowedRedirectOrigin is opt-in. Every caller
    // that doesn't attach a credential (which is most of them) keeps exactly
    // today's follow-anywhere behaviour when the option is omitted.
    expect(await countModels('/v1/models-redirect-external')).toEqual({ ok: true, status: 200, count: 2 });
    expect(evilHits).toContain('/v1/models');
  });

  it('allows a same-origin redirect when allowedRedirectOrigin is set', async () => {
    const res = await nodeHttpFetch(
      `${base}/v1/models-redirect-same-origin`,
      { headers: { Accept: 'application/json' } },
      0,
      { allowedRedirectOrigin: new URL(base).origin },
    );
    expect(res.ok).toBe(true);
  });

  it('refuses a cross-origin redirect when allowedRedirectOrigin is set, and never reaches the other origin', async () => {
    // Regression (Codex P1): a credential attached via init.headers (a PAT,
    // a bearer token) used to be replayed verbatim on ANY origin a 3xx
    // response pointed to, since nodeHttpFetch reuses `init` unchanged on
    // the followed request — a malicious or misconfigured redirect,
    // including an HTTPS→HTTP downgrade, would silently exfiltrate it. This
    // proves both halves: the call rejects, AND the other origin's server
    // genuinely never receives the request (not just "the caller ignores a
    // response it got").
    evilHits = [];
    await expect(
      nodeHttpFetch(
        `${base}/v1/models-redirect-external`,
        { headers: { Accept: 'application/json', Authorization: 'Bearer secret-token' } },
        0,
        { allowedRedirectOrigin: new URL(base).origin },
      ),
    ).rejects.toThrow(/cross-origin/i);
    expect(evilHits).toEqual([]);
  });
});

describe('preferIpv4Host', () => {
  it('leaves localhost untouched to prevent IPv6 breakage', () => {
    expect(preferIpv4Host('http://localhost:8900/v1')).toBe('http://localhost:8900/v1');
  });

  it('leaves other hosts untouched', () => {
    expect(preferIpv4Host('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });
});

describe('stripTrailingSlashes', () => {
  it('drops trailing slashes and leaves everything else alone', () => {
    expect(stripTrailingSlashes('https://gw.example/v1/')).toBe('https://gw.example/v1');
    expect(stripTrailingSlashes('https://gw.example/v1///')).toBe('https://gw.example/v1');
    expect(stripTrailingSlashes('https://gw.example/v1')).toBe('https://gw.example/v1');
    expect(stripTrailingSlashes('')).toBe('');
    expect(stripTrailingSlashes('///')).toBe('');
    // Interior slashes are untouched — only the tail is stripped.
    expect(stripTrailingSlashes('https://gw.example//a//b//')).toBe('https://gw.example//a//b');
  });

  it('stays linear on a long run of slashes', () => {
    // The regex it replaces (`/\/+$/`) retries the anchored repetition from
    // every start position, which is O(n²) — the ReDoS CodeQL flagged. This is
    // a bound on the shape of the algorithm, not a benchmark: a quadratic
    // implementation takes seconds on this input.
    const input = `${'/'.repeat(200_000)}x${'/'.repeat(200_000)}`;
    const started = Date.now();
    expect(stripTrailingSlashes(input)).toBe(`${'/'.repeat(200_000)}x`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('fetchSameOrigin', () => {
  let server: http.Server;
  let base: string;
  let other: http.Server;
  let otherBase: string;
  const seen: Array<{ url: string; key: string | undefined; method?: string; body?: string; contentType?: string }> = [];

  beforeAll(async () => {
    other = http.createServer((req, res) => {
      seen.push({ url: `other${req.url}`, key: req.headers['x-api-key'] as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          key: req.headers['x-api-key'] as string | undefined,
          method: req.method,
          body,
          contentType: req.headers['content-type'] as string | undefined,
        });
        if (req.url === '/away') { res.writeHead(302, { location: `${otherBase}/stolen` }); res.end(); return; }
        if (req.url === '/local') { res.writeHead(302, { location: '/models' }); res.end(); return; }
        if (req.url === '/seeother') { res.writeHead(303, { location: '/models' }); res.end(); return; }
        if (req.url === '/keepmethod') { res.writeHead(307, { location: '/models' }); res.end(); return; }
        if (req.url === '/notmodified') { res.writeHead(304, { location: '/models' }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => other.close(() => r()));
  });

  it('refuses a cross-origin redirect instead of replaying the credential', async () => {
    // `x-api-key` is a CUSTOM header, so the platform does not strip it across
    // origins the way it strips Authorization — a gateway that redirected
    // elsewhere would be handed the key configured for it.
    seen.length = 0;
    await expect(
      fetchSameOrigin(`${base}/away`, { headers: { 'x-api-key': 'secret-key' } }),
    ).rejects.toThrow(/cross-origin redirect/i);
    expect(seen.some((r) => r.url.startsWith('other'))).toBe(false);
    expect(seen.some((r) => r.url.startsWith('other') && r.key === 'secret-key')).toBe(false);
  });

  it('turns a 303 POST into a GET without the body, as Fetch does', async () => {
    // Replaying the original POST body at the redirect target would re-submit a
    // generation request — duplicating it, or failing a gateway's result/poll
    // redirect outright.
    seen.length = 0;
    const res = await fetchSameOrigin(`${base}/seeother`, {
      method: 'POST',
      body: '{"prompt":"hi"}',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret-key' },
    });
    expect(res.status).toBe(200);
    const hop = seen[seen.length - 1]!;
    expect(hop.method).toBe('GET');
    expect(hop.body).toBe('');
    expect(hop.contentType).toBeUndefined();
    // The credential still travels — it is same-origin.
    expect(hop.key).toBe('secret-key');
  });

  it('preserves the method and body across a 307, which exists to do that', async () => {
    seen.length = 0;
    const res = await fetchSameOrigin(`${base}/keepmethod`, {
      method: 'POST',
      body: '{"prompt":"hi"}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const hop = seen[seen.length - 1]!;
    expect(hop.method).toBe('POST');
    expect(hop.body).toBe('{"prompt":"hi"}');
  });

  it('does not treat a 304 as a redirect', async () => {
    // A 304 can carry Location without being a redirect; following it would
    // turn a cache revalidation into a second request.
    seen.length = 0;
    const res = await fetchSameOrigin(`${base}/notmodified`);
    expect(res.status).toBe(304);
    expect(seen).toHaveLength(1);
  });

  it('still follows a same-origin redirect, which endpoints use to canonicalise paths', async () => {
    seen.length = 0;
    const res = await fetchSameOrigin(`${base}/local`, { headers: { 'x-api-key': 'secret-key' } });
    expect(res.status).toBe(200);
    expect(seen.map((r) => r.url)).toEqual(['/local', '/models']);
  });
});

describe('normalizeEndpoint — host case, path case', () => {
  it('ignores host case and a trailing slash', () => {
    expect(sameEndpoint('https://GW.Example.com/', 'https://gw.example.com')).toBe(true);
  });

  it('preserves path case, which is significant', () => {
    // Lowercasing the whole URL made two distinct tenant routes on one gateway
    // the same endpoint — and this decides whether a stored credential may be
    // adopted into a row, so it would authorize moving a key between them.
    expect(sameEndpoint('https://gw.example/TenantA', 'https://gw.example/tenanta')).toBe(false);
    expect(sameEndpoint('https://gw.example/TenantA', 'https://gw.example/TenantA/')).toBe(true);
  });

  it('still compares two identical non-URL strings equal', () => {
    expect(sameEndpoint('not a url', 'NOT A URL')).toBe(true);
  });

  it('treats a missing endpoint as equal only to another missing one', () => {
    expect(sameEndpoint(undefined, '')).toBe(true);
    expect(sameEndpoint(undefined, 'https://gw.example')).toBe(false);
  });
});

describe('nodeHttpFetch redirect semantics match Fetch', () => {
  // `fetchSameOrigin` was given this state machine; its sibling kept the older
  // "any 3xx with a Location" behaviour. That matters now: the OpenAI-compatible
  // provider routes both generation and discovery through this helper for the
  // cross-origin credential fix, so the two have to agree.
  let server: http.Server;
  let base = '';
  const seen: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers });
      const url = req.url ?? '';
      if (url.startsWith('/r/')) {
        const code = Number(url.slice(3).split('/')[0]);
        res.writeHead(code, { Location: '/landed' });
        res.end();
        return;
      }
      if (url === '/not-a-redirect') {
        // 304 carries a Location here deliberately: following it would turn a
        // cache revalidation into a second request.
        res.writeHead(304, { Location: '/landed' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await new Promise((r) => server.close(r)); });

  it('does not follow a 304 that carries a Location', async () => {
    seen.length = 0;
    const res = await nodeHttpFetch(`${base}/not-a-redirect`);
    expect(res.status).toBe(304);
    expect(seen.map((s) => s.url)).toEqual(['/not-a-redirect']);
  });

  it('preserves HEAD across a 303 instead of downgrading it to GET', async () => {
    seen.length = 0;
    await nodeHttpFetch(`${base}/r/303`, { method: 'HEAD' });
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'HEAD']);
  });

  it('drops body framing headers when a POST downgrades to GET', async () => {
    seen.length = 0;
    await nodeHttpFetch(`${base}/r/302`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json', 'x-keep-me': 'yes' },
    });
    const landed = seen[1]!;
    expect(landed.method).toBe('GET');
    // The body is gone, so headers describing one must be too — otherwise
    // Content-Length announces a body that never arrives.
    expect(landed.headers['content-type']).toBeUndefined();
    expect(landed.headers['content-length']).toBeUndefined();
    // …while a header that has nothing to do with the body survives.
    expect(landed.headers['x-keep-me']).toBe('yes');
  });

  it('preserves method and body across a 307', async () => {
    seen.length = 0;
    await nodeHttpFetch(`${base}/r/307`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });
    expect(seen[1]?.method).toBe('POST');
    expect(seen[1]?.headers['content-type']).toBe('application/json');
  });
});
