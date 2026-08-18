import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GeminiProvider } from './gemini.js';
import { ProviderUnreachableError } from './base.js';
import type { ModelInfo } from '../types.js';

const MODEL: ModelInfo = {
  id: 'gemini-2.5-flash',
  name: 'Gemini 2.5 Flash',
  provider: 'gemini',
  contextWindow: 1_000_000,
  isVisionCapable: true,
  inputCostPer1kTokens: 0,
  outputCostPer1kTokens: 0,
  maxOutputTokens: 8_000,
  supportsStreaming: true,
  isLocal: false,
  supportsToolUse: true,
};

// Builds a fake @google/genai streaming response as an async iterable of chunks.
function fakeStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function providerWithStream(chunks: unknown[]): GeminiProvider {
  const p = new GeminiProvider({ type: 'gemini', apiKey: 'test' }, MODEL);
  // Replace the real client with a stub that returns our canned stream.
  (p as unknown as { client: unknown }).client = {
    models: { generateContentStream: vi.fn(async () => fakeStream(chunks)) },
  };
  return p;
}

describe('GeminiProvider — part extraction', () => {
  it('keeps answer text, skips private "thought" parts, and captures functionCall', async () => {
    // A thinking-model response: a thought part, real answer text, and a tool call
    // in the same stream — the exact shape whose `chunk.text` getter warned and
    // could come back empty.
    const provider = providerWithStream([
      { candidates: [{ content: { parts: [{ thought: true, text: 'let me think...' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Hello, ' }, { text: 'world.' }] } }] },
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'x' } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      },
    ]);

    const streamed: string[] = [];
    const result = await provider.generateStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      (c) => { if (c.text) streamed.push(c.text); },
    );

    // The answer text is preserved; the "thought" text is NOT folded in.
    expect(result.content).toBe('Hello, world.');
    expect(result.content).not.toContain('let me think');
    expect(streamed.join('')).toBe('Hello, world.');
    // The function call is surfaced as a tool call.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe('web_search');
    expect(result.finishReason).toBe('tool_use');
  });

  it('returns empty content (not a crash) when the model emits only a thought part', async () => {
    const provider = providerWithStream([
      { candidates: [{ content: { parts: [{ thought: true, text: 'thinking only' }] }, finishReason: 'STOP' }] },
    ]);
    const result = await provider.generateStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(result.content).toBe('');
  });
});

describe('GeminiProvider — model listing filters out non-text models', () => {
  it('listModels drops TTS/embedding models the API returns', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1000000, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-pro-preview-tts', displayName: 'Gemini 2.5 Pro TTS', inputTokenLimit: 8000, outputTokenLimit: 16000, supportedGenerationMethods: ['countTokens', 'generateContent'] },
          { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', inputTokenLimit: 2048, outputTokenLimit: 1, supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'test' }, MODEL);
    const models = await provider.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('gemini-2.5-flash');
    expect(ids).not.toContain('gemini-2.5-pro-preview-tts');
    expect(ids).not.toContain('text-embedding-004');
  });

  afterEach(() => vi.unstubAllGlobals());
});

describe('GeminiProvider — availability is about the KEY, not one model', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The catalogue's first Gemini entry, which is what the router probes with. */
  const CATALOGUE_SEED: ModelInfo = { ...MODEL, id: 'gemini-2.0-flash' };

  it('does not condemn the provider because one model id is unreachable', async () => {
    // The old probe called countTokens() against whichever model the router
    // seeded it with. A key that cannot reach THAT model — retired, not enabled
    // for the project, on another API version — failed, and since every later
    // step is gated on the verdict, the real model list was never fetched and
    // Gemini vanished from a working key.
    const countTokens = vi.fn(async () => { throw new Error('404 model not found'); });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [{
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          inputTokenLimit: 1_000_000,
          outputTokenLimit: 8192,
          supportedGenerationMethods: ['generateContent'],
        }],
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'test' }, CATALOGUE_SEED);
    (provider as unknown as { client: { models: { countTokens: unknown } } })
      .client.models.countTokens = countTokens;

    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('sends the key in a header, never in the URL', async () => {
    // A query string carries into proxy logs, error reports and shell history,
    // and this one would carry the key with it.
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'super-secret-key' }, MODEL);
    await provider.isAvailable();

    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).not.toContain('super-secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('super-secret-key');
  });

  it('reports what the API said instead of three guesses', async () => {
    // "bad key, wrong endpoint/deployment, or unreachable" names three
    // different fixes and identifies none of them. Google's own message does.
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'API key not valid. Please pass a valid API key.' } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'bad' }, MODEL);
    await expect(provider.isAvailable()).rejects.toThrow(/API key not valid/);
  });

  it('still fails a key the API rejects', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => { throw new Error('no body'); },
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'bad' }, MODEL);
    await expect(provider.isAvailable()).rejects.toThrow(/HTTP 403/);
  });

  it.each([429, 500, 502, 503])('does not blame the key for HTTP %i', async (status) => {
    // A spent quota or a bad afternoon at Google says nothing about the
    // credential. Calling either "your key was rejected" sends the user to
    // regenerate something that was never the problem — the same misdirection
    // this change exists to remove, only stated more confidently.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status, statusText: 'Nope', json: async () => ({}),
    })) as unknown as typeof fetch);

    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'fine' }, MODEL);
    const err = await provider.isAvailable().catch((e: Error) => e) as Error;
    expect(err).toBeInstanceOf(ProviderUnreachableError);
    expect(err.message).not.toMatch(/rejected the API key/);
    expect(err.message).toContain(String(status));
  });

  it('treats a network failure as unreachable, not as a bad key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'fine' }, MODEL);
    const err = await provider.isAvailable().catch((e: Error) => e) as Error;
    expect(err).toBeInstanceOf(ProviderUnreachableError);
    expect(err.message).toMatch(/could not reach/);
  });

  it.each([400, 401, 403])('does blame the key for HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status, statusText: 'Nope',
      json: async () => ({ error: { message: 'API key not valid' } }),
    })) as unknown as typeof fetch);

    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'bad' }, MODEL);
    const err = await provider.isAvailable().catch((e: Error) => e) as Error;
    expect(err).not.toBeInstanceOf(ProviderUnreachableError);
    expect(err.message).toMatch(/rejected the API key/);
  });

  it('says so plainly when no key is configured at all', async () => {
    const provider = new GeminiProvider({ type: 'gemini' }, MODEL);
    await expect(provider.isAvailable()).rejects.toThrow(/no Gemini API key/);
  });
});

describe('a configured Gemini endpoint is actually used', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // `baseUrl` was accepted by the schema, preserved across settings edits and
  // compared by `credentialEndpointIdentity` — while this provider ignored it,
  // so a proxy-issued key was sent to Google's public backend and the proxy's
  // catalogue was silently replaced by the public one. Asserting the REQUEST,
  // not the stored config, is the whole point: the config assertion passed
  // throughout.
  const listOk = () => new Response(JSON.stringify({ models: [] }), { status: 200 });

  it('sends model discovery to the configured host', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(listOk());
    const provider = new GeminiProvider(
      { type: 'gemini', apiKey: 'proxy-key', baseUrl: 'https://gemini-proxy.internal' },
      MODEL,
    );
    await provider.listModels();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0]))
      .toBe('https://gemini-proxy.internal/v1beta/models');
  });

  it('still reaches the public host when nothing is configured', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(listOk());
    await new GeminiProvider({ type: 'gemini', apiKey: 'k' }, MODEL).listModels();

    expect(String(spy.mock.calls[0]?.[0]))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models');
  });

  it('does not double the version segment the client appends itself', async () => {
    // A user copying the URL out of Google's docs writes the versioned form.
    // The SDK adds `/v1beta` to whatever root it is given, so trusting the
    // configured string verbatim would generate against `/v1beta/v1beta`.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(listOk());
    await new GeminiProvider(
      { type: 'gemini', apiKey: 'k', baseUrl: 'https://gemini-proxy.internal/v1beta' },
      MODEL,
    ).listModels();

    expect(String(spy.mock.calls[0]?.[0]))
      .toBe('https://gemini-proxy.internal/v1beta/models');
  });

  it('strips ONLY the segment this client appends, keeping other paths', async () => {
    // `/v1beta` is the client's; anything else that looks like a version is a
    // path the user chose, and proxy paths are scope-bearing in this release.
    // Stripping `/v2` would silently move generation to a different route AND
    // make endpoint identity call two different routes the same host — so a
    // key would survive an edit that relocated it.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(listOk());
    await new GeminiProvider(
      { type: 'gemini', apiKey: 'k', baseUrl: 'https://gemini-proxy.internal/v2/' },
      MODEL,
    ).listModels();

    expect(String(spy.mock.calls[0]?.[0]))
      .toBe('https://gemini-proxy.internal/v2/v1beta/models');
  });

  it('hands the same root to the SDK client that discovery uses', async () => {
    // Generation goes through the SDK rather than `fetch`, so the two could
    // disagree without either test noticing — which is exactly what happened.
    const provider = new GeminiProvider(
      { type: 'gemini', apiKey: 'proxy-key', baseUrl: 'https://gemini-proxy.internal/v1beta' },
      MODEL,
    );
    const client = (provider as unknown as { client: { apiClient?: unknown } }).client;
    const options = (client as unknown as Record<string, unknown>);
    expect(JSON.stringify(options)).toContain('https://gemini-proxy.internal');
    expect(JSON.stringify(options)).not.toContain('v1beta/v1beta');
  });
});

describe('GeminiProvider — the key never follows a cross-origin redirect', () => {
  // A real server, not a mocked `fetch`. Replacing the global swallows redirect
  // following entirely, so a mock-based test of this passes whether the guard
  // is there or not — it asserted nothing. Same reason
  // `openai-compatible-redirect.test.ts` is its own file.
  //
  // `x-goog-api-key` is a CUSTOM header, so the fetch spec does not strip it
  // across origins the way it strips `Authorization`. Once `baseUrl` can name a
  // user-configured proxy, a 302 from that proxy would otherwise deliver the
  // key to a host that never issued it.
  let sink: http.Server;
  let redirector: http.Server;
  let sinkUrl = '';
  let redirectorBase = '';
  const sinkKeys: Array<string | undefined> = [];

  beforeAll(async () => {
    sink = http.createServer((req, res) => {
      sinkKeys.push(req.headers['x-goog-api-key'] as string | undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'models/sink-model' }] }));
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;

    redirector = http.createServer((_req, res) => {
      // Same path, different origin — the shape a compromised or misconfigured
      // gateway produces. The target is a CONSTANT rather than an echo of
      // `req.url`: reflecting a request path into `Location` is an open
      // redirect, which CodeQL flags whether or not the server is a fixture,
      // and the path here is known anyway.
      res.writeHead(302, { Location: `${sinkUrl}/v1beta/models` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    redirectorBase = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => sink.close(r));
    await new Promise((r) => redirector.close(r));
  });

  it('does not deliver x-goog-api-key to the redirect target', async () => {
    sinkKeys.length = 0;
    const provider = new GeminiProvider(
      { type: 'gemini', apiKey: 'proxy-issued-key', baseUrl: redirectorBase },
      MODEL,
    );

    // Whatever it returns, the one thing that must not happen is the key
    // arriving at the other origin.
    await provider.listModels().catch(() => undefined);

    expect(sinkKeys).toEqual([]);
  });

  it('still follows a same-origin redirect, which endpoints legitimately use', async () => {
    // Canonicalising a path is normal; the guard is about the ORIGIN, not about
    // refusing redirects wholesale.
    const hops: string[] = [];
    const server = http.createServer((req, res) => {
      hops.push(req.url ?? '');
      if (hops.length === 1) {
        // Constant target, for the same reason as above.
        res.writeHead(308, { Location: '/v1beta/models/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      await new GeminiProvider({ type: 'gemini', apiKey: 'k', baseUrl: base }, MODEL).listModels();
      expect(hops).toEqual(['/v1beta/models', '/v1beta/models/']);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
