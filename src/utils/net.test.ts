import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { nodeHttpFetch, preferIpv4Host } from './net.js';

const MODELS = JSON.stringify({
  object: 'list',
  data: [{ id: 'qwen2.5-7b', object: 'model' }, { id: 'llama-3-8b', object: 'model' }],
});

let server: http.Server;
let base: string;

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
      default:
        res.writeHead(404);
        return res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

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
});

describe('preferIpv4Host', () => {
  it('leaves localhost untouched to prevent IPv6 breakage', () => {
    expect(preferIpv4Host('http://localhost:8900/v1')).toBe('http://localhost:8900/v1');
  });

  it('leaves other hosts untouched', () => {
    expect(preferIpv4Host('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });
});
