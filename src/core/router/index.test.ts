// ─────────────────────────────────────────────
//  Cascade AI — router OpenAI-compatible discovery
// ─────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CascadeRouter } from './index.js';
import type { CascadeConfig } from '../../types.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-llama', object: 'model' }] }));
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function makeConfig(overrides: Partial<CascadeConfig> = {}): CascadeConfig {
  return { providers: [], models: {}, tools: { allowedTools: [] }, ...overrides } as unknown as CascadeConfig;
}

describe('CascadeRouter — OpenAI-compatible discovery', () => {
  it('discovers real models even when the separate isAvailable() probe reports the provider unavailable', async () => {
    // Regression: discovery used to run only `if (availableProviders.has('openai-compatible'))`,
    // gating it behind a second, independent network probe. A flaky/slow first
    // connection there could strand a perfectly reachable endpoint as
    // "unavailable" for the whole session — even though discovery itself (this
    // very call) succeeds moments later. Simulate that flaky first probe by
    // stubbing detectAvailableProviders() to report nothing available, and
    // confirm the model is still discovered and selectable.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());

    await router.init(makeConfig({
      providers: [{ type: 'openai-compatible', baseUrl }],
    }));

    const models = router.getAvailableModels();
    expect(models.some((m) => m.id === 'local-llama' && m.provider === 'openai-compatible')).toBe(true);
  });

  it('does not attempt discovery when no openai-compatible baseUrl is configured', async () => {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());

    await router.init(makeConfig({ providers: [] }));

    expect(router.getAvailableModels().some((m) => m.provider === 'openai-compatible')).toBe(false);
  });
});
