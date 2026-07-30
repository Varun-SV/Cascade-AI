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
// `pages` lets pagination tests give a specific URL its own body + Link
// header; any URL not in `pages` (i.e. every existing single-page test) falls
// through to the plain `body`/no-Link-header behaviour unchanged.
const catalog: {
  ok: boolean;
  status: number;
  body: unknown;
  calls: Array<{ url: string; headers: Record<string, string> }>;
  pages: Record<string, { body: unknown; link?: string | null }>;
} = { ok: true, status: 200, body: { models: [] }, calls: [], pages: {} };

vi.mock('../utils/net.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/net.js')>();
  return {
    ...actual,
    nodeHttpFetch: async (url: string | URL, init: RequestInit = {}) => {
      const urlStr = String(url);
      catalog.calls.push({
        url: urlStr,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      const page = catalog.pages[urlStr];
      const body = page ? page.body : catalog.body;
      const link = page ? page.link ?? null : null;
      return {
        ok: catalog.ok,
        status: catalog.status,
        json: async () => body,
        headers: { get: (name: string) => (name.toLowerCase() === 'link' ? link : null) },
      };
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
  catalog.pages = {};
});

describe('GitHubModelsProvider — client construction', () => {
  it('points at the fixed inference URL and ignores config.baseUrl entirely', () => {
    // Unlike azure/openai-compatible, the endpoint is not user-editable here —
    // a stray baseUrl in config must not redirect inference somewhere else.
    makeProvider('openai/gpt-4o', { baseUrl: 'https://someone-elses-endpoint.example/v1' });
    expect(sdk.clientOptions?.['baseURL']).toBe(GITHUB_MODELS_INFERENCE_URL);
  });

  it('sends the GitHub API-version and User-Agent headers on every request, not just the catalog', () => {
    makeProvider();
    expect(sdk.clientOptions?.['defaultHeaders']).toMatchObject({
      'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
      'User-Agent': 'Cascade-AI',
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

describe('GitHubModelsProvider — clamps explicit maxTokens to the output cap', () => {
  it('caps a maxTokens above the 4K limit (e.g. T1Administrator\'s 8,000)', async () => {
    sdk.frames = [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ finish_reason: 'stop' }] }];
    await makeProvider().generateStream(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8_000 },
      () => { /* drop */ },
    );
    expect(sdk.createCalls[0]?.['max_tokens']).toBe(4_000);
  });

  it('leaves a maxTokens already under the cap untouched', async () => {
    sdk.frames = [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ finish_reason: 'stop' }] }];
    await makeProvider().generateStream(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 },
      () => { /* drop */ },
    );
    expect(sdk.createCalls[0]?.['max_tokens']).toBe(500);
  });

  it('leaves an unset maxTokens to fall through to the model default', async () => {
    sdk.frames = [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ finish_reason: 'stop' }] }];
    await makeProvider().generateStream({ messages: [{ role: 'user', content: 'hi' }] }, () => { /* drop */ });
    expect(sdk.createCalls[0]?.['max_tokens']).toBe(4_000);
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
  it('fetches the catalog URL with GitHub\'s four required headers', async () => {
    // Regression: nodeHttpFetch is a thin node:http/https wrapper with no
    // default User-Agent (unlike a browser fetch or the openai SDK's own
    // client) — GitHub's REST API 403s any request missing one, PAT or not.
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
      'User-Agent': 'Cascade-AI',
    });
  });

  it('stamps a real $0 on every model — never isLocal, never pricing-unknown', async () => {
    catalog.body = {
      models: [
        { id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', supported_parameters: ['tools'] },
        { id: 'meta/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', supported_parameters: ['tools'] },
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

  it('defaults supportsToolUse to false when the catalog entry does not positively advertise it', async () => {
    // Regression (Codex P2): every discovered model used to be hardcoded
    // supportsToolUse: true regardless of catalog data. A model that GitHub
    // actually can't route `tools` to (some of the multi-vendor catalog can't)
    // would then bypass t3-worker.ts's text-tool fallback — which only
    // engages on an explicit `false` — and the inference call would fail
    // outright on an unsupported parameter.
    catalog.body = {
      models: [
        { id: 'openai/gpt-4o', supported_parameters: ['tools', 'temperature'] },
        { id: 'meta/Llama-3.2-Instruct' }, // no capability metadata at all
      ],
    };
    const models = await makeProvider().listModels();
    const gpt4o = models.find((m) => m.id === 'openai/gpt-4o');
    const llama = models.find((m) => m.id === 'meta/Llama-3.2-Instruct');
    expect(gpt4o!.supportsToolUse).toBe(true);
    expect(llama!.supportsToolUse).toBe(false);
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

  it('reads context window and vision capability defensively across field names, capped to GitHub\'s real input quota', async () => {
    catalog.body = {
      models: [
        { id: 'a/one', context_window: 200_000, supported_input_modalities: ['text', 'image'] },
        { id: 'b/two', limits: { max_input_tokens: 64_000 } },
        { id: 'c/three' },
      ],
    };
    const models = await makeProvider().listModels();
    // Regression (Codex P1): the catalog-reported (or 128K default) window
    // used to be exposed as-is — GitHub enforces its own, much smaller
    // per-request input cap independent of the base model's real context,
    // so a run compacted to fit the uncapped number reached inference and
    // was rejected instead of being compacted correctly the first time.
    expect(models[0]).toMatchObject({ contextWindow: 8_000, isVisionCapable: true });
    expect(models[1]).toMatchObject({ contextWindow: 8_000, isVisionCapable: false });
    expect(models[2]!.contextWindow).toBe(8_000); // neutral default, also capped
  });

  it('never advertises more context than GitHub will actually accept, even for a catalog entry under the cap', async () => {
    catalog.body = { models: [{ id: 'a/small', context_window: 4_000 }] };
    const models = await makeProvider().listModels();
    // A genuinely small window is left alone — only the OVER-the-cap case is
    // clamped down; this must never be raised.
    expect(models[0]!.contextWindow).toBe(4_000);
  });

  it('returns empty, never the construction seed, on an empty or unrecognised catalog body', async () => {
    // Unlike openai-compatible, the seed here is always a non-callable
    // placeholder in every production path — surfacing it as a discovered
    // model would let it be selected and 404 with no diagnostic trail.
    for (const body of [{ models: [] }, { unexpected: 'shape' }, [{ no_id_field: true }], null]) {
      catalog.calls = [];
      catalog.body = body;
      const models = await makeProvider('openai/gpt-4o').listModels();
      expect(models).toEqual([]);
    }
  });

  it('throws only on a genuine HTTP failure', async () => {
    catalog.ok = false;
    catalog.status = 401;
    await expect(makeProvider().listModels()).rejects.toThrow(/401/);
  });

  it('follows Link: rel="next" pagination until exhausted', async () => {
    // Regression (Codex P2): the catalog endpoint is a GitHub REST list
    // resource, RFC 5988 paginated like every other one — a single request
    // used to silently drop every model past the first page.
    const page2Url = `${GITHUB_MODELS_CATALOG_URL}?page=2`;
    catalog.pages = {
      [GITHUB_MODELS_CATALOG_URL]: {
        body: { models: [{ id: 'openai/gpt-4o' }] },
        link: `<${page2Url}>; rel="next"`,
      },
      [page2Url]: {
        body: { models: [{ id: 'meta/Llama-3.3-70B-Instruct' }] },
        link: null,
      },
    };
    const models = await makeProvider().listModels();
    expect(models.map((m) => m.id).sort()).toEqual(['meta/Llama-3.3-70B-Instruct', 'openai/gpt-4o']);
    expect(catalog.calls.map((c) => c.url)).toEqual([GITHUB_MODELS_CATALOG_URL, page2Url]);
  });

  it('stops on the second sighting of a cyclic Link header, not the full page cap', async () => {
    catalog.pages = {
      [GITHUB_MODELS_CATALOG_URL]: {
        body: { models: [{ id: 'openai/gpt-4o' }] },
        link: `<${GITHUB_MODELS_CATALOG_URL}>; rel="next"`, // points right back at itself
      },
    };
    await makeProvider().listModels();
    // Visited-URL tracking catches this on the very next iteration — 20
    // identical authenticated requests would be 20 unnecessary PAT-bearing
    // calls against a ~10 RPM budget for a header that was never going anywhere.
    expect(catalog.calls).toHaveLength(1);
  });

  it('makes exactly one request when the catalog has no Link header', async () => {
    catalog.body = { models: [{ id: 'openai/gpt-4o' }] };
    await makeProvider().listModels();
    expect(catalog.calls).toHaveLength(1);
  });

  it('refuses a cross-origin pagination Link rather than sending the PAT there', async () => {
    // Regression (Codex P1): the Link header's next URL is server-supplied and
    // was followed verbatim, carrying catalogHeaders()'s Authorization header
    // to wherever it pointed. A malicious or misconfigured response pointing
    // `rel="next"` at an attacker-controlled origin would exfiltrate the PAT.
    const evilUrl = 'https://attacker.example/catalog?page=2';
    catalog.pages = {
      [GITHUB_MODELS_CATALOG_URL]: {
        body: { models: [{ id: 'openai/gpt-4o' }] },
        link: `<${evilUrl}>; rel="next"`,
      },
    };
    await expect(makeProvider().listModels()).rejects.toThrow(/cross-origin/i);
    // The first (legitimate) page was fetched — but the PAT never went to
    // the attacker's origin, because the second request was never made.
    expect(catalog.calls.map((c) => c.url)).toEqual([GITHUB_MODELS_CATALOG_URL]);
  });

  it('resolves a relative next Link against the current page origin, and still refuses if it escapes it', async () => {
    // A relative Link value (`</catalog/models?page=2>; rel="next"`) is valid
    // per RFC 3986 and resolves against the request it came from — must not
    // be treated as invalid or as an implicit same-origin bypass.
    const page2Url = `${GITHUB_MODELS_CATALOG_URL}?page=2`;
    catalog.pages = {
      [GITHUB_MODELS_CATALOG_URL]: {
        body: { models: [{ id: 'openai/gpt-4o' }] },
        link: `</catalog/models?page=2>; rel="next"`,
      },
      [page2Url]: { body: { models: [{ id: 'meta/Llama-3.3-70B-Instruct' }] }, link: null },
    };
    const models = await makeProvider().listModels();
    expect(models.map((m) => m.id).sort()).toEqual(['meta/Llama-3.3-70B-Instruct', 'openai/gpt-4o']);
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
