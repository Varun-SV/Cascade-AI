import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.js';
import { CloudStore } from './db.js';
import { createNativeAccessToken } from './auth/session.js';
import type { CloudEnv } from './env.js';
import {
  CASCADE_MODELS, runControlsForModel, isCascadeModel, parseCompletionRequest, findUnsupportedParam,
  providersFromEnv, providerPolicy, describeProviderPolicy, reconcileStream, usageBlock, streamChunk,
  usageChunk, errorFrame, HttpRunSink,
} from './openai-compat.js';
import { parseChatRunPayload, runChatTurn, type ChatRunResult } from './runs.js';

// Every Cascade the run pipeline builds, captured so a test can inspect what
// the pipeline attached to it. The fake also records the listener count for
// each gate AT THE MOMENT `run()` starts — which is exactly when the SDK would
// consult `listenerCount(...)` to decide whether anyone is there to ask.
const h = vi.hoisted(() => ({ made: [] as Array<{ gateListenersAtRun: Record<string, number> }> }));

vi.mock('#cascade-ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { EventEmitter } = await import('node:events');
  const GATE_EVENTS = [
    'escalation:decision-required', 'escalation:timeout', 'context:approval-required',
    'context:compacted', 'plan:approval-required', 'stream:token', 'tier:status', 'log',
  ];

  class FakeCascade extends EventEmitter {
    gateListenersAtRun: Record<string, number> = {};
    setMediaSink(): void { /* unused here */ }
    setFeedbackSource(): void { /* unused here */ }
    resolvePlanApproval(): void { /* unused here */ }
    resolveContextApproval(): void { /* unused here */ }
    resolveEscalation(): void { /* unused here */ }
    getDecisionLog(): unknown[] { return []; }
    getRouter() {
      return {
        getStats: () => ({ costByTier: { T3: 0.001 }, tokensByTier: { T3: 5 }, totalCostUsd: 0.001, totalTokens: 5 }),
        getDelegationSavings: () => ({ savedUsd: 0.02, savedPct: 40 }),
        generate: async () => ({ content: '' }),
      };
    }
    async close(): Promise<void> { /* nothing to tear down */ }
    async run(options: { routingPrompt?: string }): Promise<unknown> {
      for (const ev of GATE_EVENTS) this.gateListenersAtRun[ev] = this.listenerCount(ev);
      // A prompt-driven escape hatch for the one case that cannot be produced
      // by a well-behaved run: presenter tokens that are NOT a prefix of the
      // answer the run then returns.
      if (options?.routingPrompt?.includes('DIVERGE')) {
        this.emit('stream:token', { tierId: 'T3', text: 'Hello there', primary: true });
        return {
          output: 'Hello world.',
          sessionId: '', taskId: '', t2Results: [], durationMs: 12,
          usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, estimatedCostUsd: 0.001 },
        };
      }
      // Two presenter tokens plus one background-worker token: the background
      // one must NOT reach the caller's delta stream.
      this.emit('stream:token', { tierId: 'T3', text: 'Hello ', primary: true });
      this.emit('stream:token', { tierId: 'T3_bg', text: '[worker noise]', primary: false });
      this.emit('stream:token', { tierId: 'T3', text: 'world.', primary: true });
      return {
        output: 'Hello world.',
        sessionId: '', taskId: '', t2Results: [], durationMs: 12,
        usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, estimatedCostUsd: 0.001 },
      };
    }
  }

  return {
    ...actual,
    createCascade: () => {
      const c = new FakeCascade();
      h.made.push(c);
      return c;
    },
  };
});

// ── Pure units ────────────────────────────────

describe('model → routing mode', () => {
  it('maps each served name onto run controls, and nothing else', () => {
    expect(runControlsForModel('cascade')).toEqual({ routingMode: 'auto' });
    expect(runControlsForModel('cascade-fast')).toEqual({ fastAnswer: true });
    expect(runControlsForModel('cascade-quality')).toEqual({ routingMode: 'quality' });
    expect(Object.keys(CASCADE_MODELS)).toEqual(['cascade', 'cascade-fast', 'cascade-quality']);
  });

  it('REJECTS a real model name rather than falling back to auto', () => {
    // The whole reason this is a rejection and not a default: a request that
    // asked for gpt-4o and silently got a full Cascade orchestration has been
    // billed for something it never asked for, and cannot tell.
    for (const name of ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'cascade-turbo', '']) {
      expect(runControlsForModel(name), name).toBeNull();
      expect(isCascadeModel(name), name).toBe(false);
    }
  });

  it('answers an unknown model with an OpenAI-shaped 404 model_not_found', () => {
    const out = parseCompletionRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
    expect(out.body.error.code).toBe('model_not_found');
    expect(out.body.error.param).toBe('model');
    expect(out.body.error.type).toBe('invalid_request_error');
    // The message has to name the alternatives, or a caller has no next step.
    expect(out.body.error.message).toContain('cascade-fast');
  });
});

describe('unsupported parameters', () => {
  it('rejects params that would change the answer', () => {
    expect(findUnsupportedParam({ n: 3 })?.name).toBe('n');
    expect(findUnsupportedParam({ logprobs: true })?.name).toBe('logprobs');
    expect(findUnsupportedParam({ presence_penalty: 0.5 })?.name).toBe('presence_penalty');
    expect(findUnsupportedParam({ tools: [{ type: 'function' }] })?.name).toBe('tools');
    expect(findUnsupportedParam({ response_format: { type: 'json_object' } })?.name).toBe('response_format');
    expect(findUnsupportedParam({ stop: ['\n'] })?.name).toBe('stop');
  });

  it('lets the NO-OP default through — that is a client with no opinion, not a request', () => {
    // Wrappers fill every field in. Rejecting `top_p: 1` would break them for
    // asking for exactly what they were going to get anyway.
    expect(findUnsupportedParam({ n: 1, top_p: 1, presence_penalty: 0, frequency_penalty: 0, logprobs: false })).toBeNull();
    expect(findUnsupportedParam({ tools: undefined, stop: null })).toBeNull();
  });

  it('surfaces the rejection as a 400 naming the offending param', () => {
    const out = parseCompletionRequest({ model: 'cascade', messages: [{ role: 'user', content: 'hi' }], n: 4 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(400);
    expect(out.body.error.param).toBe('n');
  });
});

describe('message mapping', () => {
  const req = (messages: unknown[], extra: Record<string, unknown> = {}) =>
    parseCompletionRequest({ model: 'cascade', messages, ...extra });

  it('splits system/developer turns out and answers the last user turn', () => {
    const out = req([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'developer', content: 'Cite sources.' },
      { role: 'user', content: 'second' },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.systemPrompt).toBe('Be terse.\n\nCite sources.');
    expect(out.value.prompt).toBe('second');
    expect(out.value.history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  it('flattens text parts and refuses non-text parts', () => {
    const ok = req([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
    expect(ok.ok && ok.value.prompt).toBe('ab');
    const bad = req([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.body.error.message).toContain('/api/uploads');
  });

  it('refuses tool turns rather than pretending to support tool calling', () => {
    const out = req([{ role: 'user', content: 'hi' }, { role: 'tool', content: 'result', tool_call_id: 't1' }]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.body.error.message).toContain('server-side');
  });

  it('requires the last message to be a user turn', () => {
    const out = req([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'partial' }]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.body.error.message).toContain("role 'user'");
  });

  it('maps temperature and either max-tokens spelling, bounding both', () => {
    const a = req([{ role: 'user', content: 'hi' }], { temperature: 0.4, max_tokens: 900 });
    expect(a.ok && a.value.temperature).toBe(0.4);
    expect(a.ok && a.value.maxTokens).toBe(900);
    // The current spelling wins over the legacy one.
    const b = req([{ role: 'user', content: 'hi' }], { max_tokens: 10, max_completion_tokens: 20 });
    expect(b.ok && b.value.maxTokens).toBe(20);
    expect(req([{ role: 'user', content: 'hi' }], { temperature: 5 }).ok).toBe(false);
    expect(req([{ role: 'user', content: 'hi' }], { max_tokens: 0 }).ok).toBe(false);
  });
});

describe('provider keys (self-host gate)', () => {
  let dir = '';
  let store: CloudStore | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-oai-policy-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
  });
  afterEach(async () => {
    store?.close();
    store = undefined;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  const envWith = (over: Partial<CloudEnv>) => ({ DATA_DIR: dir, ...over } as CloudEnv);

  it('reads each provider from its CLI-compatible variable', () => {
    const providers = providersFromEnv(envWith({
      ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GOOGLE_API_KEY: 'g', GITHUB_MODELS_TOKEN: 'gh',
      AZURE_OPENAI_KEY: 'az', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_DEPLOYMENT: 'dep',
      OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1/v1', OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    }));
    expect(providers.map((p) => p.type)).toEqual([
      'anthropic', 'openai', 'gemini', 'github-models', 'azure', 'openai-compatible', 'ollama',
    ]);
    // Exactly the bound ChatRunPayloadSchema enforces — a fuller env than this
    // would fail the run's own Zod gate rather than this function.
    expect(providers).toHaveLength(7);
    expect(providers.find((p) => p.type === 'gemini')?.apiKey).toBe('g');
  });

  it('prefers GEMINI_API_KEY over GOOGLE_API_KEY and never adds both', () => {
    const providers = providersFromEnv(envWith({ GEMINI_API_KEY: 'first', GOOGLE_API_KEY: 'second' }));
    expect(providers).toHaveLength(1);
    expect(providers[0]!.apiKey).toBe('first');
  });

  it('needs all three halves of an Azure deployment before offering it', () => {
    expect(providersFromEnv(envWith({ AZURE_OPENAI_KEY: 'az' }))).toEqual([]);
    expect(providersFromEnv(envWith({ AZURE_OPENAI_KEY: 'az', AZURE_OPENAI_ENDPOINT: 'https://x' }))).toEqual([]);
  });

  it('uses env keys on a single-account instance', () => {
    const env = envWith({ OPENAI_API_KEY: 'sk-operator' });
    expect(providerPolicy(env, store!).mode).toBe('env');            // zero accounts
    store!.upsertUser({ provider: 'dev', providerId: 'solo', email: null, name: null, avatar: null });
    const policy = providerPolicy(env, store!);
    expect(policy.mode).toBe('env');
    expect(policy.mode === 'env' && policy.providers[0]!.apiKey).toBe('sk-operator');
    expect(describeProviderPolicy(env, store!)).toContain('single-account');
  });

  it('STOPS using env keys the moment a second account exists', () => {
    // The bug this gate prevents: on a multi-tenant instance the operator's key
    // silently pays for every caller's run, with no per-user accounting.
    const env = envWith({ OPENAI_API_KEY: 'sk-operator' });
    store!.upsertUser({ provider: 'dev', providerId: 'one', email: null, name: null, avatar: null });
    store!.upsertUser({ provider: 'dev', providerId: 'two', email: null, name: null, avatar: null });
    const policy = providerPolicy(env, store!);
    expect(policy.mode).toBe('request-only');
    expect(policy.mode === 'request-only' && policy.reason).toContain('2 accounts');
    expect(describeProviderPolicy(env, store!)).toContain('supply their own provider keys');
  });

  it('is request-only when the operator set no keys at all', () => {
    const policy = providerPolicy(envWith({}), store!);
    expect(policy.mode).toBe('request-only');
    expect(policy.mode === 'request-only' && policy.reason).toContain('no provider keys');
  });
});

describe('SSE framing and usage', () => {
  it('frames a chunk the way an OpenAI client parses it', () => {
    const raw = streamChunk('chatcmpl-1', 1700000000, 'cascade', { content: 'hi' });
    expect(raw.startsWith('data: ')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(true);
    const parsed = JSON.parse(raw.slice('data: '.length));
    expect(parsed).toMatchObject({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'cascade',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    });
  });

  it('carries an extension at the top level, never inside choices', () => {
    // The cascade block rides the terminal frame, so a client looping over
    // chunk.choices[0].delta cannot trip over it.
    const parsed = JSON.parse(
      streamChunk('chatcmpl-1', 1, 'cascade', {}, 'stop', { cascade: { tier: 'T3' } }).slice('data: '.length),
    );
    expect(parsed.cascade).toEqual({ tier: 'T3' });
    expect(parsed.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
    expect(parsed.choices[0].cascade).toBeUndefined();
  });

  it('frames an in-stream error the way an SDK detects one', () => {
    // Both official SDKs raise when a data frame carries an `error` key.
    const parsed = JSON.parse(errorFrame({ error: { message: 'nope', type: 'server_error', param: null, code: 'x' } }).slice('data: '.length));
    expect(parsed.error.message).toBe('nope');
  });

  it('frames the terminal usage chunk with an empty choices array', () => {
    const parsed = JSON.parse(
      usageChunk('chatcmpl-1', 1, 'cascade', { total_tokens: 9 }, { tier: 'T3' }).slice('data: '.length),
    );
    expect(parsed.choices).toEqual([]);
    expect(parsed.usage).toEqual({ total_tokens: 9 });
    expect(parsed.cascade).toEqual({ tier: 'T3' });
  });

  it('reports the run\'s real token split', () => {
    const result = { totalTokens: 14 } as ChatRunResult;
    expect(usageBlock({ inputTokens: 11, outputTokens: 3, totalTokens: 14, estimatedCostUsd: 0.001 }, result)).toEqual({
      prompt_tokens: 11, completion_tokens: 3, total_tokens: 14,
    });
    // Fallback still adds up — a total its own parts contradict is worse than
    // an unsplit one.
    const fallback = usageBlock(null, result);
    expect(fallback.prompt_tokens + fallback.completion_tokens).toBe(fallback.total_tokens);
    expect(fallback.total_tokens).toBe(14);
  });

  it('forwards only the presenter tier\'s tokens, and captures usage on completion', () => {
    const seen: string[] = [];
    const sink = new HttpRunSink((t) => seen.push(t));
    sink.emit('stream:token', { text: 'a', primary: true });
    sink.emit('stream:token', { text: 'BACKGROUND', primary: false });
    sink.emit('stream:token', { text: 'b', primary: true });
    sink.emit('session:complete', { result: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCostUsd: 0 } } });
    expect(seen.join('')).toBe('ab');
    expect(sink.usage?.totalTokens).toBe(3);
  });
});

describe('reconcileStream', () => {
  it('is complete when the stream already carries the whole answer', () => {
    expect(reconcileStream('Hello world.', 'Hello world.')).toEqual({ kind: 'complete' });
  });

  it('appends only when the answer genuinely EXTENDS what streamed', () => {
    expect(reconcileStream('Hello ', 'Hello world.')).toEqual({ kind: 'append', text: 'world.' });
    expect(reconcileStream('', 'Hello world.')).toEqual({ kind: 'append', text: 'Hello world.' });
  });

  it('reports divergence instead of patching it from the common prefix', () => {
    // The case that must never become an append: emitting "world." after
    // "Hello there" makes a client assemble "Hello thereworld." — and SSE has
    // no way to take back the bytes already sent, so calling that a success
    // hands the caller corrupted output. It has to surface as a failure.
    expect(reconcileStream('Hello there', 'Hello world.')).toEqual({ kind: 'diverged' });
    // Also divergent: the stream ran PAST the answer. Truncation is no more
    // repairable than substitution.
    expect(reconcileStream('Hello world. Extra', 'Hello world.')).toEqual({ kind: 'diverged' });
  });
});

// ── Routes ────────────────────────────────────

describe('/v1 routes', () => {
  let dir: string;
  let store: CloudStore;
  let server: http.Server;
  let baseUrl: string;
  let token: string;
  let userId: string;

  const makeEnv = (over: Partial<CloudEnv> = {}): CloudEnv => ({
    PORT: 0,
    SESSION_SECRET: 'x'.repeat(20),
    DATA_DIR: dir,
    WEB_ORIGIN: 'http://localhost:5173',
    OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787',
    CLOUD_DEV_BYPASS: false,
    MAX_COST_PER_RUN_USD: 1,
    RAZORPAY_PRICE_LABEL: 'n/a',
    OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1/v1',
    ...over,
  } as CloudEnv);

  const start = async (env: CloudEnv) => {
    server = http.createServer(createApp(env, store));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    h.made.length = 0;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-oai-routes-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    const user = store.upsertUser({ provider: 'dev', providerId: 'api', email: null, name: 'API', avatar: null });
    userId = user.id;
    token = createNativeAccessToken(user.id, 'x'.repeat(20));
    await start(makeEnv());
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('serves exactly the three routing modes from /v1/models', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(['cascade', 'cascade-fast', 'cascade-quality']);
    expect(body.data[0]).toMatchObject({ object: 'model', owned_by: 'cascade' });
  });

  it('answers an unauthenticated call in OpenAI\'s error envelope, not the app\'s', async () => {
    for (const res of [
      await fetch(`${baseUrl}/v1/models`),
      await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    ]) {
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_api_key');
      expect(body.error.type).toBe('invalid_request_error');
    }
  });

  it('returns a chat.completion with the run\'s real usage', async () => {
    const res = await post({ model: 'cascade', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.model).toBe('cascade');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]).toMatchObject({ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello world.' } });
    expect(body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
    // `model` has to echo the routing mode the caller asked for, so which model
    // actually served the run is only visible through the extension block.
    expect(body.cascade.conversation_id).toBeTruthy();
    expect(body.cascade.saved_pct).toBe(40);
    // The turn is a real conversation the user can open in the web app.
    expect(store.getMessages(body.cascade.conversation_id).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  /** Splits an SSE body into its parsed frames, minus the `[DONE]` terminator. */
  const framesOf = (raw: string) => {
    const parts = raw.split('\n\n').filter(Boolean).map((f) => f.replace(/^data: /, ''));
    expect(parts.at(-1)).toBe('[DONE]');
    return parts.slice(0, -1).map((f) => JSON.parse(f));
  };

  it('streams OpenAI chunk frames whose deltas concatenate to the answer', async () => {
    const res = await post({ model: 'cascade', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const raw = await res.text();
    const events = framesOf(raw);
    expect(events.every((e) => e.object === 'chat.completion.chunk')).toBe(true);

    // First frame opens the message; the background worker's token never appears.
    expect(events[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    const text = events.map((e) => e.choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Hello world.');
    expect(raw).not.toContain('worker noise');

    // Exactly one terminal frame, and it carries the cascade block — so what
    // the run cost is on every stream without an opt-in frame.
    const stops = events.filter((e) => e.choices[0]?.finish_reason === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].cascade.saved_pct).toBe(40);
    expect(stops[0].cascade.conversation_id).toBeTruthy();
  });

  it('does NOT emit the choices-less usage frame unless it was asked for', async () => {
    // That frame is opt-in in the streaming shape. Forcing it into an ordinary
    // stream throws in any client that indexes chunk.choices[0] in its loop.
    for (const body of [
      { model: 'cascade', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { model: 'cascade', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: false } },
    ]) {
      const events = framesOf(await (await post(body)).text());
      expect(events.every((e) => Array.isArray(e.choices) && e.choices.length === 1), JSON.stringify(body)).toBe(true);
      expect(events.some((e) => e.usage)).toBe(false);
    }
  });

  it('emits it when stream_options.include_usage is true', async () => {
    const events = framesOf(await (await post({
      model: 'cascade', messages: [{ role: 'user', content: 'hi' }],
      stream: true, stream_options: { include_usage: true },
    })).text());
    const last = events.at(-1);
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
    // It comes AFTER the terminal frame, never instead of it.
    expect(events.at(-2).choices[0].finish_reason).toBe('stop');
  });

  it('validates stream_options rather than ignoring a malformed one', async () => {
    const cases: Array<[unknown, string]> = [
      [{ model: 'cascade', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: 'yes' }, 'must be an object'],
      [{ model: 'cascade', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: 'yes' } }, 'must be a boolean'],
      // Meaningless without a stream — OpenAI rejects this too.
      [{ model: 'cascade', messages: [{ role: 'user', content: 'hi' }], stream_options: { include_usage: true } }, "'stream' is true"],
    ];
    for (const [body, needle] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.message).toContain(needle);
    }
  });

  // ── The other thing a stream must never do ──
  it('terminates a DIVERGENT stream as an error, never as a successful stop', async () => {
    const res = await post({ model: 'cascade', messages: [{ role: 'user', content: 'DIVERGE please' }], stream: true });
    const events = framesOf(await res.text());

    // No success signal: appending a correction after bytes the client cannot
    // un-receive would assemble "Hello thereworld." and label it complete.
    expect(events.some((e) => e.choices?.[0]?.finish_reason === 'stop')).toBe(false);
    const error = events.at(-1);
    expect(error.error.code).toBe('stream_reconciliation_failed');
    // Nothing was appended after the divergent text.
    const text = events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Hello there');
    expect(text).not.toContain('world.');
  });

  // ── The regression this endpoint exists to avoid ──
  it('attaches NO escalation or context listener on the HTTP path', async () => {
    await post({ model: 'cascade', messages: [{ role: 'user', content: 'hi' }] });

    expect(h.made).toHaveLength(1);
    const gates = h.made[0]!.gateListenersAtRun;
    // Invisible in normal use — it only fires when a worker escalates — which
    // is why it is asserted rather than noticed. With a listener attached and
    // nobody able to answer it, the SDK parks the run for the full 5-minute
    // escalation timeout and then resolves WORSE than the `skip` it returns
    // for free when nothing is listening (cascade.ts). Same for the 120s
    // context-approval gate.
    expect(gates['escalation:decision-required']).toBe(0);
    expect(gates['escalation:timeout']).toBe(0);
    expect(gates['context:approval-required']).toBe(0);
    expect(gates['plan:approval-required']).toBe(0);
    // Streaming and diagnostics are NOT gates and stay attached — without them
    // the endpoint could not stream at all.
    expect(gates['stream:token']).toBe(1);
    expect(gates['tier:status']).toBe(1);
    expect(gates['log']).toBe(1);
  });

  // The contrast that gives the assertion above its meaning: deleting the
  // listeners outright would also make it pass, and would break the web UI.
  it('still attaches them on the interactive (socket) path', async () => {
    const socket = { emit: () => true, on: () => undefined, off: () => undefined };
    await runChatTurn(
      parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai', apiKey: 'k' }] }),
      { env: makeEnv(), store, userId, socket },
    );
    const gates = h.made[0]!.gateListenersAtRun;
    expect(gates['escalation:decision-required']).toBe(1);
    expect(gates['escalation:timeout']).toBe(1);
    expect(gates['context:approval-required']).toBe(1);
    expect(gates['plan:approval-required']).toBe(1);
  });

  it('rejects an unknown model, unsupported params and a non-user last turn before running anything', async () => {
    const cases: Array<[unknown, number]> = [
      [{ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, 404],
      [{ model: 'cascade', messages: [{ role: 'user', content: 'hi' }], n: 2 }, 400],
      [{ model: 'cascade', messages: [{ role: 'assistant', content: 'hi' }] }, 400],
      [{ model: 'cascade', messages: [] }, 400],
      [{ messages: [{ role: 'user', content: 'hi' }] }, 400],
    ];
    for (const [body, status] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect((await res.json()).error).toBeTruthy();
    }
    // Nothing was run — a rejected request must not cost a model call.
    expect(h.made).toHaveLength(0);
  });

  it('refuses the run when no provider keys are available, naming the way out', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    // A second account turns the env-key gate off (see providerPolicy).
    store.upsertUser({ provider: 'dev', providerId: 'second', email: null, name: null, avatar: null });
    await start(makeEnv());

    const res = await post({ model: 'cascade', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('no_provider_keys');
    expect(body.error.message).toContain('2 accounts');
    expect(body.error.message).toContain('extra_body');
    expect(h.made).toHaveLength(0);
  });

  it('accepts caller-supplied provider keys, validated by the run\'s own schema', async () => {
    const ok = await post({
      model: 'cascade-fast',
      messages: [{ role: 'user', content: 'hi' }],
      providers: [{ type: 'openai', apiKey: 'sk-caller' }],
    });
    expect(ok.status).toBe(200);

    // The same Zod gate the socket path uses — an API run can never build a
    // payload a socket run could not.
    const bad = await post({
      model: 'cascade',
      messages: [{ role: 'user', content: 'hi' }],
      providers: [{ type: 'not-a-provider' }],
    });
    expect(bad.status).toBe(400);
  });

  it('turns a daily-cap refusal into a 429, not a 500', async () => {
    for (let i = 0; i < 20; i++) store.incrementUsage(userId, new Date().toISOString().slice(0, 10));
    const res = await post({ model: 'cascade', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(429);
    expect((await res.json()).error.type).toBe('rate_limit_error');
  });

  // ── Persistence stays behind the admission guards ──
  it('persists NOTHING when a history-bearing request is refused by the daily cap', async () => {
    // Prior turns ride the payload rather than being written by the route, so
    // they are seeded inside runChatTurn — after checkDailyLimit/beginRun. When
    // the route did the import itself, every rejected retry left a conversation
    // and its whole transcript on disk: repeatable, unmetered, and invisible
    // until storage filled up.
    for (let i = 0; i < 20; i++) store.incrementUsage(userId, new Date().toISOString().slice(0, 10));
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(20_000),
    }));

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await post({
        model: 'cascade',
        messages: [...history, { role: 'user', content: 'and now?' }],
      });
      expect(res.status).toBe(429);
    }

    expect(store.listConversations(userId)).toEqual([]);
    expect(h.made).toHaveLength(0);
  });

  it('still seeds that history when the request IS admitted', async () => {
    const res = await post({
      model: 'cascade',
      messages: [
        { role: 'user', content: 'what is 2+2' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'and times 3?' },
      ],
    });
    const body = await res.json();
    // The seeded turns are the run's history AND the persisted transcript — the
    // reply hangs off the last of them rather than starting a second branch.
    expect(store.getActivePath(body.cascade.conversation_id).map((m) => m.content))
      .toEqual(['what is 2+2', '4', 'and times 3?', 'Hello world.']);
    expect(store.listConversations(userId)[0]!.title).toBe('what is 2+2');
  });
});
