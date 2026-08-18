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

describe('AnthropicProvider — a bearer is never sent to the public host', () => {
  // The config paths all refuse to configure a bearer without its gateway, but
  // the public SDK reaches this constructor without touching them:
  // `createCascade()` runs `CascadeConfigSchema.parse()` alone, and
  // `ProviderConfigSchema` permits `authToken` with no `baseUrl`. The
  // constructor then built a client with `baseURL` undefined — the SDK's
  // public default — and sent a gateway's token to api.anthropic.com.

  it('refuses to construct with a bearer and no gateway', () => {
    expect(() => new AnthropicProvider({ type: 'anthropic', authToken: 'gw-token' }))
      .toThrow(/without a gateway URL/i);
  });

  it('uses the API key instead when both are configured without a gateway', async () => {
    // The key IS valid for the public host, so the run should succeed with the
    // right credential rather than fail over a bearer that was never usable.
    // This also covers listModels(), which builds its request by hand: reading
    // `config.authToken` directly, it sent Bearer to the public default host
    // while the constructor was correctly using the key — discovery and
    // generation disagreeing about the same credential.
    //
    // Its OWN spy: the redirect suite above calls fetchSpy.mockRestore(),
    // which detaches the module-level spy for good, so anything after it
    // silently stops intercepting and reaches the network instead.
    const localFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    try {
      const provider = new AnthropicProvider({
        type: 'anthropic', authToken: 'gw-token', apiKey: 'sk-ant-real',
      });
      await provider.listModels();

      const headers = new Headers(
        (localFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as HeadersInit,
      );
      expect(headers.get('x-api-key')).toBe('sk-ant-real');
      expect(headers.get('authorization')).toBeNull();
    } finally {
      localFetch.mockRestore();
    }
  });

  it('still accepts a bearer that names its gateway', () => {
    expect(() => new AnthropicProvider({
      type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal/v1',
    })).not.toThrow();
  });

  it('rejects the same shape through the programmatic config path', async () => {
    // The route the finding names, asserted as the two facts that make it a
    // hole: the schema ACCEPTS the config — so nothing upstream of the provider
    // catches it, which is the whole reason the boundary has to — and building
    // the provider from that parsed config refuses.
    //
    // Not written as a createCascade() run: that path fails first for an
    // unrelated reason ("Cannot read properties of undefined (reading
    // 'selectForTier')"), so a bare rejects.toThrow() passed identically with
    // the guard removed. A test that cannot fail is worse than no test.
    const { CascadeConfigSchema } = await import('../config/schema.js');
    const parsed = CascadeConfigSchema.parse({
      providers: [{ type: 'anthropic', authToken: 'gw-token' }],
    });
    expect(parsed.providers[0]).toMatchObject({ type: 'anthropic', authToken: 'gw-token' });

    expect(() => new AnthropicProvider(parsed.providers[0]!))
      .toThrow(/without a gateway URL/i);
  });

  it('refuses a Claude subscription token even when a gateway is named', () => {
    // Pointing a subscription token at a gateway does not make it a gateway's
    // bearer — Anthropic refuses it whatever header carries it. The
    // environment, link and config-load paths all classify it, but the public
    // SDK runs none of them, so this shape walked past the gateway check.
    expect(() => new AnthropicProvider({
      type: 'anthropic', authToken: 'sk-ant-oat01-abc', baseUrl: 'https://gateway.internal/v1',
    })).toThrow(/subscription token/i);
  });

  it('falls back to a configured API key rather than the subscription token', () => {
    expect(() => new AnthropicProvider({
      type: 'anthropic', authToken: 'sk-ant-oat01-abc', apiKey: 'sk-ant-real',
      baseUrl: 'https://gateway.internal/v1',
    })).not.toThrow();
  });

  it('rejects a subscription token through the programmatic config path', async () => {
    // Same two facts: schema validation is all the public path runs, and it
    // does not classify the token — so the provider boundary is the only thing
    // between this config and the wire.
    const { CascadeConfigSchema } = await import('../config/schema.js');
    const parsed = CascadeConfigSchema.parse({
      providers: [{ type: 'anthropic', authToken: 'sk-ant-oat01-abc', baseUrl: 'https://gateway.example' }],
    });
    expect(parsed.providers[0]?.authToken).toBe('sk-ant-oat01-abc');

    expect(() => new AnthropicProvider(parsed.providers[0]!))
      .toThrow(/subscription token/i);
  });

  it('rejects a subscription token that arrives in apiKey', () => {
    // The field a secret arrives in proves nothing about what it is. The guard
    // classified `authToken` only, so `ANTHROPIC_API_KEY=sk-ant-oat…`, a
    // hand-written config, or a sync row with the token in the wrong slot sent
    // it as `x-api-key` — past a release-wide "refused wherever it appears".
    expect(() => new AnthropicProvider({ type: 'anthropic', apiKey: 'sk-ant-oat01-abc' }))
      .toThrow(/subscription token/i);
  });

  it('uses a real API key configured beside a subscription bearer', () => {
    expect(() => new AnthropicProvider({
      type: 'anthropic', apiKey: 'sk-ant-real', authToken: 'sk-ant-oat01-abc',
    })).not.toThrow();
  });
});

describe('AnthropicProvider.listModels — a failed gateway is not a validated catalog', () => {
  // listModels() falls back to the bundled catalogue on 401/403, a malformed
  // body, a refused cross-origin redirect or a network error. Harmless for a
  // settings list; NOT harmless for router validation, which reads a non-empty
  // result as "the endpoint confirmed these ids", caches it, and pins Auto to
  // them — so a gateway's failure was recorded as confirmation of the PUBLIC
  // Anthropic catalogue, models it may not serve at all.

  it('still returns the bundled catalog by default, for the UI', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"type":"error"}', { status: 401 }));
    try {
      const models = await new AnthropicProvider({ type: 'anthropic', apiKey: 'k' }).listModels();
      expect(models.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns nothing when the caller asked for confirmed models only', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"type":"error"}', { status: 401 }));
    try {
      const models = await new AnthropicProvider({
        type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/v1',
      }).listModels({ staticFallback: false });
      expect(models).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns nothing on a network failure too', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));
    try {
      const models = await new AnthropicProvider({
        type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/v1',
      }).listModels({ staticFallback: false });
      expect(models).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns the gateway\u2019s real models when discovery succeeds', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: 'gw-model-1', display_name: 'GW One' }] }),
      { status: 200 },
    ));
    try {
      const models = await new AnthropicProvider({
        type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/v1',
      }).listModels({ staticFallback: false });
      expect(models.map((m) => m.id)).toEqual(['gw-model-1']);
    } finally {
      spy.mockRestore();
    }
  });

});
