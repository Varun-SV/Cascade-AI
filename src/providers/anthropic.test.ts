import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from './anthropic.js';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

afterEach(() => {
  fetchSpy.mockReset();
});

function makeProvider(): AnthropicProvider {
  return new AnthropicProvider({ type: 'anthropic', apiKey: 'test-key' });
}

describe('AnthropicProvider.listModels', () => {
  it('falls back to the hardcoded catalog on HTTP 401', async () => {
    fetchSpy.mockResolvedValue(
      new Response('{"type":"error"}', { status: 401 }),
    );
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('falls back when the API returns a non-array data field', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: null }), { status: 200 }),
    );
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it('falls back when fetch rejects (DNS / offline)', async () => {
    fetchSpy.mockRejectedValue(new Error('ENOTFOUND'));
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it('returns parsed models when the API is healthy', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'claude-unknown-model', display_name: 'Unknown' }],
        }),
        { status: 200 },
      ),
    );
    const provider = makeProvider();
    const models = await provider.listModels();
    expect(models.find((m) => m.id === 'claude-unknown-model')).toBeTruthy();
  });
});

describe('AnthropicProvider — gateway routing', () => {
  /**
   * The URL the SDK will actually POST a message to.
   *
   * Asserted instead of the client's `baseURL` field, which is what an earlier
   * version of these tests checked — and which is why they passed while every
   * generation call was going to `/v1/v1/messages`. The SDK owns the version
   * segment (`buildURL()` concatenates `baseURL` with `/v1/messages`), so
   * carrying the configured string through to the client is not the same as
   * addressing the right endpoint.
   */
  function messagesUrlOf(provider: AnthropicProvider): string {
    const client = (provider as unknown as {
      client: { buildURL(path: string, query: unknown): string };
    }).client;
    return client.buildURL('/v1/messages', null);
  }

  it('routes an API key at a configured gateway', () => {
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/v1' },
      undefined as never,
    );
    expect(messagesUrlOf(provider)).toBe('https://gateway.internal/v1/messages');
  });

  it('routes a bearer token at a configured gateway', () => {
    // This is the whole point of authToken. Anthropic documents
    // ANTHROPIC_AUTH_TOKEN for routing through an LLM gateway or proxy — and
    // dropping baseUrl sent the request to api.anthropic.com carrying a token
    // only the gateway had issued.
    const provider = new AnthropicProvider(
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal/v1' },
      undefined as never,
    );
    expect(messagesUrlOf(provider)).toBe('https://gateway.internal/v1/messages');
  });

  it('addresses the same endpoint whether or not the version was written out', () => {
    // Both spellings are accepted by discovery and `cascade link`, so both have
    // to reach the same place.
    for (const configured of [
      'https://gateway.internal',
      'https://gateway.internal/',
      'https://gateway.internal/v1',
      'https://gateway.internal/v1/',
    ]) {
      const provider = new AnthropicProvider(
        { type: 'anthropic', apiKey: 'k', baseUrl: configured },
        undefined as never,
      );
      expect(messagesUrlOf(provider)).toBe('https://gateway.internal/v1/messages');
    }
  });

  it('keeps a gateway path that is not a version segment', () => {
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/anthropic/v1' },
      undefined as never,
    );
    expect(messagesUrlOf(provider)).toBe('https://gateway.internal/anthropic/v1/messages');
  });

  it('leaves the default endpoint alone when no gateway is configured', () => {
    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'k' }, undefined as never);
    expect(messagesUrlOf(provider)).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('AnthropicProvider.listModels — follows the configured endpoint', () => {
  it('asks the gateway, not api.anthropic.com, and does not leak the key there', async () => {
    // It used to hardcode the public host with x-api-key, so a gateway
    // deployment sent the GATEWAY'S key to a host that was never meant to see
    // it, and replaced the gateway's catalogue with the public one.
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gw-model', display_name: 'GW' }] }), { status: 200 }),
    );
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'gateway-key', baseUrl: 'https://gateway.internal' },
      undefined as never,
    );
    await provider.listModels();

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gateway.internal/v1/models');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('gateway-key');
  });

  it('authenticates discovery the same way generation does', async () => {
    // With a bearer token it previously sent an empty x-api-key and always
    // fell through to the bundled catalogue.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = new AnthropicProvider(
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' },
      undefined as never,
    );
    await provider.listModels();

    const headers = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer gw-token');
    expect(headers['x-api-key']).toBeUndefined();
    // No oauth beta: that header belongs to the Claude subscription flow this
    // release makes non-adoptable, and a gateway asked to honour an Anthropic
    // beta it knows nothing about can reject an otherwise valid credential.
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('still uses the public endpoint when no gateway is configured', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'k' }, undefined as never);
    await provider.listModels();
    expect((fetchSpy.mock.calls[0] as unknown as [string])[0])
      .toBe('https://api.anthropic.com/v1/models');
  });
});

describe('AnthropicProvider.listModels — version path', () => {
  it('does not double /v1 when the gateway URL already carries it', async () => {
    // A gateway baseUrl is commonly written with the version in it. Appending
    // unconditionally produced /v1/v1/models: a 404 that fell silently back to
    // the bundled catalogue and looked like a gateway with no models of its
    // own. Discovery and generation derive this from one function, so a gateway
    // can no longer list its models and then refuse every message.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/v1' },
      undefined as never,
    );
    await provider.listModels();
    expect((fetchSpy.mock.calls[0] as unknown as [string])[0])
      .toBe('https://gateway.internal/v1/models');
  });

  it('adds /v1 when the gateway URL omits it', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/anthropic' },
      undefined as never,
    );
    await provider.listModels();
    expect((fetchSpy.mock.calls[0] as unknown as [string])[0])
      .toBe('https://gateway.internal/anthropic/v1/models');
  });

  it('asks the same host the client will send messages to', async () => {
    // The two used to be computed independently, and disagreed: this URL was
    // corrected for an already-present /v1 while the client was left pointed at
    // /v1/v1/messages. A gateway could list its catalogue and then fail every
    // generation call.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/v1' },
      undefined as never,
    );
    await provider.listModels();
    const modelsUrl = (fetchSpy.mock.calls[0] as unknown as [string])[0];
    const messagesUrl = (provider as unknown as {
      client: { buildURL(path: string, query: unknown): string };
    }).client.buildURL('/v1/messages', null);
    expect(new URL(modelsUrl).origin).toBe(new URL(messagesUrl).origin);
    expect(modelsUrl.replace(/\/models$/, '')).toBe(messagesUrl.replace(/\/messages$/, ''));
  });
});

describe('AnthropicProvider — an environment gateway reaches the API-key path', () => {
  it('is carried into the provider config, not just the bearer path', async () => {
    // ANTHROPIC_BASE_URL is the gateway for whichever Anthropic credential is
    // in play. Applying it only to bearers meant an API key exported beside a
    // gateway produced an entry with no endpoint — and discovery then sent that
    // gateway's key to the public host.
    const { ConfigManager } = await import('../config/index.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-anthropic-gw-'));
    try {
      process.env['ANTHROPIC_API_KEY'] = 'gateway-key';
      process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.internal';
      const cm = new ConfigManager(dir, path.join(dir, 'global'));
      await cm.load();
      const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
      expect(anthropic).toMatchObject({
        apiKey: 'gateway-key',
        baseUrl: 'https://gateway.internal',
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AnthropicProvider.listModels — a gateway that redirects', () => {
  let gw: http.Server;
  let gwUrl: string;
  let sink: http.Server;
  let sinkUrl: string;
  const sinkKeys: Array<string | undefined> = [];

  beforeAll(async () => {
    sink = http.createServer((req, res) => {
      sinkKeys.push(req.headers['x-api-key'] as string | undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stolen', display_name: 'S' }] }));
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;

    gw = http.createServer((_req, res) => {
      res.writeHead(302, { location: `${sinkUrl}/v1/models` });
      res.end();
    });
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
    gwUrl = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => gw.close(() => r()));
    await new Promise<void>((r) => sink.close(() => r()));
  });

  it('does not hand the configured key to the redirect target when GENERATING', async () => {
    // The sibling of the discovery case below, and the one that carries every
    // real request. Generation goes through the SDK client, so guarding the
    // hand-written model-list fetch alone left this path leaking.
    fetchSpy.mockRestore();
    sinkKeys.length = 0;
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'secret-key', baseUrl: gwUrl },
      { id: 'claude-x', maxOutputTokens: 100 } as never,
    );
    // The SDK wraps a transport failure as its own "Connection error", so the
    // refusal's own message does not survive — what matters is that the request
    // failed and the other origin never saw the key.
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] } as never),
    ).rejects.toThrow();
    expect(sinkKeys).toEqual([]);
  });

  it('does not hand the configured key to the redirect target', async () => {
    // Exercised through listModels, not through the helper: the point is that
    // THIS call site uses the same-origin fetch. `x-api-key` is a custom
    // header, so the platform keeps it across origins where it would strip
    // Authorization — a gateway that is misconfigured or compromised would
    // otherwise receive the key configured for it.
    fetchSpy.mockRestore();
    sinkKeys.length = 0;
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'secret-key', baseUrl: gwUrl },
      undefined as never,
    );
    const models = await provider.listModels();

    expect(sinkKeys).toEqual([]);                                   // never contacted
    expect(models.some((m) => m.id === 'stolen')).toBe(false);       // and its answer never used
    expect(models.every((m) => m.provider === 'anthropic')).toBe(true); // fell back to the catalogue
  });
});
