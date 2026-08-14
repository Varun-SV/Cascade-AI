import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { nodeHttpFetch, preferIpv4Host, stripTrailingSlashes } from './net.js';

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
