// ─────────────────────────────────────────────
//  Cascade AI — an OpenAI-compatible key must not follow a redirect off-origin
// ─────────────────────────────────────────────
//
//  `nodeHttpFetch` follows a 3xx by reusing `init` verbatim — headers included
//  — and this provider installed it BARE as the OpenAI SDK's fetch, and called
//  it directly for `/models`, while attaching `Authorization: Bearer <apiKey>`
//  to both. An endpoint that redirected elsewhere was therefore handed the key
//  on the second host: the same leak the Anthropic discovery and generation
//  paths were fixed for in this release, arriving through a third door.
//  `allowedRedirectOrigin` exists on that helper for exactly this case and was
//  simply not being passed.
//
//  Its own file because openai-compatible.test.ts mocks `../utils/net.js` at
//  module scope, so `nodeHttpFetch` there is a stub and the real redirect
//  behaviour cannot be exercised at all.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ModelInfo } from '../types.js';

const seed: ModelInfo = {
  id: 'seed', name: 'seed', provider: 'openai-compatible',
  contextWindow: 32_000, isVisionCapable: false,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
  maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
};

describe('OpenAICompatibleProvider — the key never follows a cross-origin redirect', () => {
  let sink: http.Server;
  let redirector: http.Server;
  let sinkUrl = '';
  let redirectorBase = '';
  const sinkAuth: Array<string | undefined> = [];

  beforeAll(async () => {
    sink = http.createServer((req, res) => {
      sinkAuth.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'sink-model' }] }));
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;

    redirector = http.createServer((req, res) => {
      res.writeHead(302, { Location: `${sinkUrl}${req.url}` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    redirectorBase = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise((r) => sink.close(r));
    await new Promise((r) => redirector.close(r));
  });

  it('refuses the redirect rather than replaying the key on another origin', async () => {
    sinkAuth.length = 0;
    const provider = new OpenAICompatibleProvider(
      { type: 'openai-compatible', baseUrl: redirectorBase, apiKey: 'secret-key' },
      seed,
    );

    await expect(provider.listModels()).rejects.toThrow(/cross-origin redirect/i);
    // The decisive assertion: the second host was never contacted, so it
    // certainly never saw the credential.
    expect(sinkAuth).toEqual([]);
  });

  it('still follows a same-origin redirect, which endpoints legitimately use', async () => {
    // A path canonicalisation on the SAME host must keep working — the guard is
    // about crossing origins, not about refusing redirects.
    const same = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(302, { Location: '/v1/models/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'same-origin-model' }] }));
    });
    await new Promise<void>((r) => same.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(same.address() as AddressInfo).port}/v1`;
    try {
      const provider = new OpenAICompatibleProvider(
        { type: 'openai-compatible', baseUrl: base, apiKey: 'secret-key' },
        seed,
      );
      const models = await provider.listModels();
      expect(models.map((m) => m.id)).toContain('same-origin-model');
    } finally {
      await new Promise((r) => same.close(r));
    }
  });
});
