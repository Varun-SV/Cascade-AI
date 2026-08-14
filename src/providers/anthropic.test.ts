import { describe, it, expect, vi, afterEach } from 'vitest';
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
  /** The SDK client's resolved base URL, whichever auth path built it. */
  function baseUrlOf(provider: AnthropicProvider): string {
    return (provider as unknown as { client: { baseURL: string } }).client.baseURL;
  }

  it('routes an API key at a configured gateway', () => {
    const provider = new AnthropicProvider(
      { type: 'anthropic', apiKey: 'k', baseUrl: 'https://gateway.internal/v1' },
      undefined as never,
    );
    expect(baseUrlOf(provider)).toBe('https://gateway.internal/v1');
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
    expect(baseUrlOf(provider)).toBe('https://gateway.internal/v1');
  });

  it('leaves the default endpoint alone when no gateway is configured', () => {
    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'k' }, undefined as never);
    expect(baseUrlOf(provider)).toContain('api.anthropic.com');
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
    // A gateway baseUrl is commonly written with the version in it — the SDK
    // accepts either form, and the constructor tests above use exactly that
    // shape. Appending unconditionally produced /v1/v1/models: a 404 that fell
    // silently back to the bundled catalogue and looked like a gateway with no
    // models of its own.
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
