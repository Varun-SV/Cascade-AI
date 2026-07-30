import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '../types.js';

// ── Mocked `openai` SDK ───────────────────────
// Same shape openai.test.ts uses: a fake client whose chat.completions.create
// yields caller-supplied stream frames. Everything is read lazily out of
// `sdk` so the mock factory (hoisted above the imports) never touches an
// uninitialised binding.
const sdk: {
  clientOptions: Record<string, unknown> | undefined;
  createCalls: Record<string, unknown>[];
  frames: unknown[];
} = { clientOptions: undefined, createCalls: [], frames: [] };

vi.mock('openai', () => {
  class FakeOpenAI {
    public chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          sdk.createCalls.push(params);
          const frames = sdk.frames;
          return {
            async *[Symbol.asyncIterator]() { for (const f of frames) yield f; },
          };
        },
      },
    };
    public models = { list: async () => ({ data: [] }) };
    constructor(options: Record<string, unknown>) { sdk.clientOptions = options; }
  }
  return { default: FakeOpenAI };
});

// ── Mocked catalog transport ──────────────────
// The catalog is fetched through utils/net's nodeHttpFetch (for its gzip /
// redirect handling), so that is what a listModels()/isAvailable() test stubs.
const catalog: {
  ok: boolean;
  status: number;
  body: unknown;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} = { ok: true, status: 200, body: { models: [] }, calls: [] };

vi.mock('../utils/net.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/net.js')>();
  return {
    ...actual,
    nodeHttpFetch: async (url: string | URL, init: RequestInit = {}) => {
      catalog.calls.push({
        url: String(url),
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      return { ok: catalog.ok, status: catalog.status, json: async () => catalog.body };
    },
  };
});

import { GitHubModelsProvider, stripModelOwnerPrefix } from './github-models.js';
import { isReasoningModel } from './openai.js';
import {
  GITHUB_MODELS_API_VERSION,
  GITHUB_MODELS_CATALOG_URL,
  GITHUB_MODELS_INFERENCE_URL,
} from '../constants.js';

function seed(id = 'github-models'): ModelInfo {
  return {
    id, name: id, provider: 'github-models',
    contextWindow: 128_000, isVisionCapable: false,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
    maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
  };
}

function makeProvider(modelId = 'openai/gpt-4o', config: Record<string, unknown> = {}): GitHubModelsProvider {
  return new GitHubModelsProvider(
    { type: 'github-models', apiKey: 'ghp_test', ...config },
    seed(modelId),
  );
}

/** Reads the protected flag OpenAIProvider sets from the model id. */
function usesMaxCompletionTokens(p: GitHubModelsProvider): boolean {
  return (p as unknown as { useMaxCompletionTokens: boolean }).useMaxCompletionTokens;
}

beforeEach(() => {
  sdk.clientOptions = undefined;
  sdk.createCalls = [];
  sdk.frames = [];
  catalog.ok = true;
  catalog.status = 200;
  catalog.body = { models: [] };
  catalog.calls = [];
});

describe('GitHubModelsProvider — client construction', () => {
  it('points at the fixed inference URL and ignores config.baseUrl entirely', () => {
    // Unlike azure/openai-compatible, the endpoint is not user-editable here —
    // a stray baseUrl in config must not redirect inference somewhere else.
    makeProvider('openai/gpt-4o', { baseUrl: 'https://someone-elses-endpoint.example/v1' });
    expect(sdk.clientOptions?.['baseURL']).toBe(GITHUB_MODELS_INFERENCE_URL);
  });

  it('sends the GitHub API-version header on every request, not just the catalog', () => {
    makeProvider();
    expect(sdk.clientOptions?.['defaultHeaders']).toMatchObject({
      'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
    });
  });

  it('constructs without an apiKey instead of throwing the SDK\'s OPENAI_API_KEY error', () => {
    // The openai SDK throws in its own constructor on an undefined key, naming
    // an env var that has nothing to do with this provider. Construction must
    // survive so the real 401 from GitHub is what the user actually sees.
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new GitHubModelsProvider({ type: 'github-models' }, seed())).not.toThrow();
      // …and it must not have quietly adopted an OpenAI key either.
      expect(sdk.clientOptions?.['apiKey']).toBe('');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe('GitHubModelsProvider — owner-prefixed reasoning detection', () => {
  it('strips only the owner segment', () => {
    expect(stripModelOwnerPrefix('openai/o3-mini')).toBe('o3-mini');
    expect(stripModelOwnerPrefix('meta/Llama-3.3-70B-Instruct')).toBe('Llama-3.3-70B-Instruct');
    expect(stripModelOwnerPrefix('no-prefix-here')).toBe('no-prefix-here');
  });

  it('detects an o-series model that the anchored regex alone would miss', () => {
    // This is the whole reason the fix exists: isReasoningModel is anchored to
    // the start of the string, and the `openai/` prefix pushes `o3` off
    // position 0, so the raw catalog id does NOT match on its own.
    expect(isReasoningModel('openai/o3-mini')).toBe(false);
    expect(isReasoningModel(stripModelOwnerPrefix('openai/o3-mini'))).toBe(true);
    expect(usesMaxCompletionTokens(makeProvider('openai/o3-mini'))).toBe(true);
  });

  it('leaves a classic owner-prefixed model on max_tokens', () => {
    expect(usesMaxCompletionTokens(makeProvider('openai/gpt-4o'))).toBe(false);
  });

  it('sends max_completion_tokens on the FIRST o-series request, with no discovery retry', async () => {
    // Getting this wrong costs one rejected request per process against a
    // ~10 RPM budget before generateStream()'s retry path self-corrects.
    sdk.frames = [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ finish_reason: 'stop' }] }];
    const p = makeProvider('openai/o3-mini');
    await p.generateStream({ messages: [{ role: 'user', content: 'hi' }] }, () => { /* drop */ });
    expect(sdk.createCalls).toHaveLength(1);
    expect(sdk.createCalls[0]).toHaveProperty('max_completion_tokens');
    expect(sdk.createCalls[0]).not.toHaveProperty('max_tokens');
  });
});

describe('GitHubModelsProvider — inherited OpenAI request path', () => {
  it('generateStream() goes through the inherited implementation unmodified', async () => {
    sdk.frames = [
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
    ];
    const chunks: string[] = [];
    const result = await makeProvider().generateStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      (c) => { if (c.text) chunks.push(c.text); },
    );
    expect(result.content).toBe('hello world');
    expect(chunks.join('')).toBe('hello world');
    expect(result.usage.inputTokens).toBe(7);
    // The full owner-prefixed id is what goes on the wire — the prefix strip is
    // for reasoning detection only and must never reach the request.
    expect(sdk.createCalls[0]?.['model']).toBe('openai/gpt-4o');
    expect(sdk.createCalls[0]?.['stream']).toBe(true);
  });

  it('generate() delegates to the same streaming path', async () => {
    sdk.frames = [{ choices: [{ delta: { content: 'pong' } }] }, { choices: [{ finish_reason: 'stop' }] }];
    const result = await makeProvider().generate({ messages: [{ role: 'user', content: 'ping' }] });
    expect(result.content).toBe('pong');
    expect(sdk.createCalls).toHaveLength(1);
  });

  it('accumulates streamed tool-call deltas via the inherited parser', async () => {
    sdk.frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'do_thing', arguments: '{"a":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }] },
    ];
    const result = await makeProvider().generate({ messages: [{ role: 'user', content: 'go' }] });
    expect(result.toolCalls?.[0]?.name).toBe('do_thing');
    expect(result.toolCalls?.[0]?.input).toEqual({ a: 1 });
  });
});

describe('GitHubModelsProvider — listModels', () => {
  it('fetches the catalog URL with GitHub\'s three required headers', async () => {
    catalog.body = { models: [{ id: 'openai/gpt-4o', name: 'OpenAI GPT-4o' }] };
    await makeProvider().listModels();
    expect(catalog.calls).toHaveLength(1);
    // The CATALOG url, not the inference url — they are different services.
    expect(catalog.calls[0]!.url).toBe(GITHUB_MODELS_CATALOG_URL);
    expect(catalog.calls[0]!.url).not.toContain('/inference');
    expect(catalog.calls[0]!.headers).toEqual({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ghp_test',
      'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
    });
  });

  it('stamps a real $0 on every model — never isLocal, never pricing-unknown', async () => {
    catalog.body = {
      models: [
        { id: 'openai/gpt-4o', name: 'OpenAI GPT-4o' },
        { id: 'meta/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' },
      ],
    };
    const models = await makeProvider().listModels();
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.provider).toBe('github-models');
      // isLocal:true would be the other route to $0 — and would wrongly put
      // these calls on the local queue, the 300s local timeout, and a
      // "[local]" label in `cascade models`.
      expect(m.isLocal).toBe(false);
      expect(m.inputCostPer1kTokens).toBe(0);
      expect(m.outputCostPer1kTokens).toBe(0);
      expect(m.pricingUnknown).toBe(false);
      expect(m.supportsStreaming).toBe(true);
      expect(m.supportsToolUse).toBe(true);
      // GitHub's real per-request cap, not the base model's larger one.
      expect(m.maxOutputTokens).toBe(4_000);
    }
    // The owner prefix is preserved — it is part of the callable id.
    expect(models.map((m) => m.id)).toContain('meta/Llama-3.3-70B-Instruct');
  });

  it('filters out non-chat catalog models (embedders)', async () => {
    catalog.body = {
      models: [
        { id: 'openai/gpt-4o' },
        { id: 'openai/text-embedding-3-large' },
        { id: 'cohere/cohere-embed-v3-english' },
      ],
    };
    const ids = (await makeProvider().listModels()).map((m) => m.id);
    expect(ids).toEqual(['openai/gpt-4o']);
  });

  it('reads context window and vision capability defensively across field names', async () => {
    catalog.body = {
      models: [
        { id: 'a/one', context_window: 200_000, supported_input_modalities: ['text', 'image'] },
        { id: 'b/two', limits: { max_input_tokens: 64_000 } },
        { id: 'c/three' },
      ],
    };
    const models = await makeProvider().listModels();
    expect(models[0]).toMatchObject({ contextWindow: 200_000, isVisionCapable: true });
    expect(models[1]).toMatchObject({ contextWindow: 64_000, isVisionCapable: false });
    expect(models[2]!.contextWindow).toBe(128_000); // neutral default
  });

  it('falls back to the seed model on an empty or unrecognised catalog body', async () => {
    for (const body of [{ models: [] }, { unexpected: 'shape' }, [{ no_id_field: true }], null]) {
      catalog.calls = [];
      catalog.body = body;
      const models = await makeProvider('openai/gpt-4o').listModels();
      expect(models.map((m) => m.id)).toEqual(['openai/gpt-4o']);
    }
  });

  it('throws only on a genuine HTTP failure', async () => {
    catalog.ok = false;
    catalog.status = 401;
    await expect(makeProvider().listModels()).rejects.toThrow(/401/);
  });
});

describe('GitHubModelsProvider — isAvailable', () => {
  it('returns true when the catalog fetch is ok', async () => {
    catalog.ok = true;
    await expect(makeProvider().isAvailable()).resolves.toBe(true);
    expect(catalog.calls[0]!.url).toBe(GITHUB_MODELS_CATALOG_URL);
  });

  it('returns false on a non-ok response (e.g. a PAT without models: read)', async () => {
    catalog.ok = false;
    catalog.status = 403;
    await expect(makeProvider().isAvailable()).resolves.toBe(false);
  });
});
