import { describe, expect, it } from 'vitest';
import { ChatGptProvider, UNSUPPORTED_RESPONSES_FIELDS, parseModelCatalog } from './chatgpt.js';
import { ChatGptRequestError } from '../auth/chatgpt/errors.js';
import type { ChatGptAuth } from '../auth/chatgpt/manager.js';
import type { ConversationMessage, ModelInfo, ToolDefinition } from '../types.js';
import { classifyProviderError, describeProviderError, enrichProviderError } from '../core/router/provider-errors.js';
import { buildTokenUsage } from '../utils/cost.js';
import { resolveModelPricing } from '../utils/cost.js';

const model: ModelInfo = {
  id: 'chatgpt:gpt-5.5', baseModelId: 'gpt-5.5', name: 'GPT-5.5', provider: 'chatgpt', contextWindow: 272_000,
  isVisionCapable: true, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 32_000,
  supportsStreaming: true, isLocal: false, supportsToolUse: true,
};
const tools: ToolDefinition[] = [
  { name: 'file_read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'shell', description: 'Run', inputSchema: { type: 'object', properties: {} } },
];

const sse = (events: unknown[]): Response => new Response(
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const completed = (extra: Record<string, unknown> = {}) => ({
  type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 }, ...extra },
});
const text = (t: string) => ({ type: 'response.output_text.delta', delta: t, item_id: 'm', output_index: 0, content_index: 0 });

interface Seen { url: string; headers: Headers; body: Record<string, unknown> }
function provider(responses: Array<() => Response>, opts: { auth?: Partial<ChatGptAuth> } = {}) {
  const seen: Seen[] = [];
  const waits: number[] = [];
  const auth = {
    getAccessToken: async () => ({ accessToken: 'tok-123', account: {} }),
    planReady: () => true,
    ...opts.auth,
  } as unknown as ChatGptAuth;
  const p = new ChatGptProvider({ type: 'chatgpt' }, model, {
    auth,
    sleep: async (ms) => { waits.push(ms); },
    fetch: async (input, init) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      seen.push({ url, headers: h, body });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      return next();
    },
  });
  return { p, seen, waits };
}
const err = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' } });

describe('request body', () => {
  it('uses the Responses endpoint with a bearer, store:false, stream:true, instructions and namespaced tools; no forbidden fields', async () => {
    const { p, seen } = provider([() => sse([text('hi'), completed()])]);
    const r = await p.generate({
      systemPrompt: 'You are Cascade.', messages: [{ role: 'user', content: 'hello' }], tools,
      maxTokens: 999, temperature: 0.3, thinking: 'high',
    });
    expect(r.content).toBe('hi');
    expect(r.usage.inputTokens).toBe(10);
    const s = seen[0]!;
    expect(s.url).toBe('https://api.openai.com/v1/responses');
    expect(s.headers.get('authorization')).toBe('Bearer tok-123');
    expect(s.body['store']).toBe(false);
    expect(s.body['stream']).toBe(true);
    expect(s.body['instructions']).toBe('You are Cascade.');
    expect(s.body['model']).toBe('gpt-5.5');
    for (const k of UNSUPPORTED_RESPONSES_FIELDS) expect(s.body).not.toHaveProperty(k);
    expect(s.body['reasoning']).toEqual({ effort: 'high' });
    const input = s.body['input'] as Array<Record<string, unknown>>;
    expect(input.some((i) => i['role'] === 'system')).toBe(false);
    const t = s.body['tools'] as Array<Record<string, unknown>>;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ type: 'namespace', name: 'cascade' });
    expect(typeof t[0]!['description']).toBe('string');
    expect((t[0]!['tools'] as Array<Record<string, unknown>>).map((x) => [x['type'], x['name']])).toEqual([['function', 'file_read'], ['function', 'shell']]);
  });

  it('omits tools entirely when there are none', async () => {
    const { p, seen } = provider([() => sse([text('x'), completed()])]);
    await p.generate({ messages: [{ role: 'user', content: 'hello' }] });
    expect(seen[0]!.body).not.toHaveProperty('tools');
    expect(seen[0]!.body).not.toHaveProperty('instructions');
  });

  it('a system message partway through a conversation becomes a developer message', async () => {
    const { p, seen } = provider([() => sse([completed()])]);
    await p.generate({ messages: [{ role: 'system', content: 'summary so far' }, { role: 'user', content: 'go' }] });
    const input = seen[0]!.body['input'] as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ role: 'developer', content: 'summary so far' });
  });

  it('sends images as input_image items', async () => {
    const { p, seen } = provider([() => sse([completed()])]);
    await p.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', image: { type: 'base64', mimeType: 'image/png', data: 'AAAA' } }] }] });
    const input = seen[0]!.body['input'] as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0]!.content.map((c) => c['type'])).toEqual(['input_text', 'input_image']);
  });
});

describe('function calls with a namespace', () => {
  const call = (extra: Record<string, unknown>) => ({
    type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'file_read', arguments: '', ...extra,
  });
  it('returns the call, and echoes call and output back with the namespace on the next turn', async () => {
    const { p, seen } = provider([
      () => sse([
        { type: 'response.output_item.added', output_index: 0, item: call({ namespace: 'cascade' }) },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"a.ts"}' },
        { type: 'response.output_item.done', output_index: 0, item: call({ namespace: 'cascade', arguments: '{"path":"a.ts"}' }) },
        completed(),
      ]),
      () => sse([text('done'), completed()]),
    ]);
    const first = await p.generate({ messages: [{ role: 'user', content: 'read it' }], tools });
    expect(first.finishReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([{ id: 'call_1', name: 'file_read', input: { path: 'a.ts' } }]);

    const history: ConversationMessage[] = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', toolCalls: first.toolCalls },
      { role: 'tool', content: 'file text', toolCallId: 'call_1' },
    ];
    await p.generate({ messages: history, tools });
    const input = seen[1]!.body['input'] as Array<Record<string, unknown>>;
    const fc = input.find((i) => i['type'] === 'function_call')!;
    expect(fc).toMatchObject({ call_id: 'call_1', name: 'file_read', namespace: 'cascade', arguments: '{"path":"a.ts"}' });
    expect(input.find((i) => i['type'] === 'function_call_output')).toMatchObject({ call_id: 'call_1', output: 'file text' });
  });

  it('echoes a different namespace the server used, and defaults to cascade when none came back', async () => {
    const { p, seen } = provider([
      () => sse([{ type: 'response.output_item.done', output_index: 0, item: call({ namespace: 'other', arguments: '{}' }) }, completed()]),
      () => sse([completed()]),
    ]);
    const first = await p.generate({ messages: [{ role: 'user', content: 'x' }], tools });
    await p.generate({
      messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [...first.toolCalls!, { id: 'call_9', name: 'shell', input: {} }] }],
      tools,
    });
    const fcs = (seen[1]!.body['input'] as Array<Record<string, unknown>>).filter((i) => i['type'] === 'function_call');
    expect(fcs.map((f) => f['namespace'])).toEqual(['other', 'cascade']);
  });
});

describe('only response.completed is success', () => {
  it('an incomplete response is an error', async () => {
    const { p } = provider([() => sse([text('part'), { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }])]);
    await expect(p.generate({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ kind: 'incomplete' });
  });
  it('a stream that ends early is an error', async () => {
    const { p } = provider([() => sse([text('part')])]);
    await expect(p.generate({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ kind: 'incomplete' });
  });
});

describe('errors', () => {
  const req = { messages: [{ role: 'user' as const, content: 'x' }] };

  it('usage limit (429): clear message with the usage URL, no retry, and the router will not loop on it', async () => {
    const { p, seen } = provider([err(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } })]);
    const e = await p.generate(req).catch((x: unknown) => x) as ChatGptRequestError;
    expect(e).toBeInstanceOf(ChatGptRequestError);
    expect(e).toMatchObject({ kind: 'usage_limit', status: 429, code: 'subscription_sharing_usage_limit_exceeded', requestId: 'req_1' });
    expect(e.message).toContain('https://chatgpt.com/settings/usage');
    expect(seen).toHaveLength(1);
    // The router sees a spent limit that does not ease: not the 30s backoff ladder.
    const c = classifyProviderError(e);
    expect(c.kind).toBe('quota_exhausted');
    expect(c.systemic).toBe(true);
    const wrapped = enrichProviderError(e, c, model.id);
    expect(classifyProviderError(wrapped).kind).toBe('quota_exhausted');
    expect(describeProviderError(classifyProviderError(wrapped), model.id)).toContain('chatgpt.com/settings/usage');
  });

  it('not eligible (403) is final and not retried', async () => {
    const { p, seen } = provider([err(403, { error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } })]);
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'not_eligible', status: 403 });
    expect(seen).toHaveLength(1);
    expect(classifyProviderError(await p.generate(req).catch((x: unknown) => x)).kind).not.toBe('rate_limit');
  });

  it('unsupported capability (400) reports error.param and is not repeated', async () => {
    const { p, seen } = provider([err(400, { error: { code: 'subscription_sharing_unsupported_capability', message: 'nope', param: 'tools[0].type' } })]);
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'unsupported_capability', param: 'tools[0].type' });
    expect(seen).toHaveLength(1);
  });

  it('if the route refuses `include`, it is dropped once and remembered', async () => {
    const { p, seen } = provider([
      err(400, { error: { code: 'subscription_sharing_unsupported_capability', message: 'x', param: 'include' } }),
      () => sse([completed()]),
      () => sse([completed()]),
    ]);
    await p.generate(req);
    await p.generate(req);
    expect(seen[0]!.body).toHaveProperty('include');
    expect(seen[1]!.body).not.toHaveProperty('include');
    expect(seen[2]!.body).not.toHaveProperty('include');
  });

  it('the *_unavailable 503s back off a bounded number of times, then stop', async () => {
    const un = () => err(503, { error: { code: 'subscription_sharing_usage_unavailable', message: 'x' } })();
    const { p, seen, waits } = provider([un, un, un, un]);
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'unavailable', retryable: true });
    expect(seen).toHaveLength(3);
    expect(waits).toHaveLength(2);
    const ok = provider([un, () => sse([text('ok'), completed()])]);
    expect((await ok.p.generate(req)).content).toBe('ok');
  });

  it('direct-admission {detail} bodies for 401, 403 and 503 map to clear typed errors', async () => {
    expect(await provider([err(403, { detail: 'region not permitted' })]).p.generate(req).catch((x: unknown) => x))
      .toMatchObject({ kind: 'admission_forbidden', status: 403 });
    expect((await provider([err(403, { detail: 'region not permitted' })]).p.generate(req).catch((x: Error) => x) as Error).message).toContain('region not permitted');
    const un = provider([err(503, { detail: 'direct routing is off' }), err(503, { detail: 'x' }), err(503, { detail: 'x' })]);
    expect(await un.p.generate(req).catch((x: unknown) => x)).toMatchObject({ kind: 'admission_unavailable' });
    expect(un.seen).toHaveLength(3);
  });

  it('a 401 admission failure renews the token once, then reports', async () => {
    let forced = 0;
    const { p, seen } = provider([err(401, { detail: 'bad' }), err(401, { detail: 'bad' })], {
      auth: { getAccessToken: (async (o?: { forceRefresh?: boolean }) => { if (o?.forceRefresh) forced++; return { accessToken: 't', account: {} }; }) as never },
    });
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'admission_unauthorized', status: 401 });
    expect(forced).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it('response.failed mid-stream carries the structured code', async () => {
    const { p } = provider([() => sse([text('start'), { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }])]);
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'usage_limit', code: 'subscription_sharing_usage_limit_exceeded' });
    const u = provider([() => sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable', message: 'x' } } }])]);
    await expect(u.p.generate(req)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('the rest of the documented codes map to their kinds', async () => {
    const cases: Array<[string, number, string]> = [
      ['subscription_sharing_route_not_supported', 403, 'route_not_supported'],
      ['subscription_sharing_invalid_user', 401, 'invalid_user'],
      ['chatpass_v2_scope_not_authorized', 403, 'scope_not_authorized'],
      ['chatpass_v2_invalid_authorization_context', 403, 'scope_not_authorized'],
    ];
    for (const [code, status, kind] of cases) {
      const e = await provider([err(status, { error: { code, message: 'm' } })]).p.generate(req).catch((x: unknown) => x);
      expect(e).toMatchObject({ kind, code });
    }
  });
});

describe('model list', () => {
  it('keeps visibility "list" only, in the server\'s order, namespaced ids, $0 and tool-capable', () => {
    const models = parseModelCatalog({ models: [
      { slug: 'gpt-b', display_name: 'Beta', visibility: 'list' },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'gpt-a', display_name: 'Alpha', visibility: 'list', input_modalities: ['text'] },
      { slug: 'gpt-c', visibility: 'list' },
      { display_name: 'no slug', visibility: 'list' },
    ] });
    expect(models.map((m) => m.id)).toEqual(['chatgpt:gpt-b', 'chatgpt:gpt-a', 'chatgpt:gpt-c']);
    expect(models.map((m) => m.name)).toEqual(['Beta', 'Alpha', 'gpt-c']);
    expect(models[0]).toMatchObject({ provider: 'chatgpt', baseModelId: 'gpt-b', supportsToolUse: true, isLocal: false, pricingUnknown: false });
    expect(models[1]!.isVisionCapable).toBe(false);
  });

  it('lists from GET /v1/models with the bearer, and returns nothing when unreachable', async () => {
    const { p, seen } = provider([() => new Response(JSON.stringify({ models: [{ slug: 'm1', display_name: 'M1', visibility: 'list' }] }), { status: 200 })]);
    expect((await p.listModels()).map((m) => m.id)).toEqual(['chatgpt:m1']);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer tok-123');
    expect(await provider([err(503, { detail: 'x' })]).p.listModels({ staticFallback: false })).toEqual([]);
  });
});

describe('cost', () => {
  it('plan usage counts tokens but costs $0 and is not an unknown price', () => {
    const u = buildTokenUsage(1_000_000, 500_000, model);
    expect(u.totalTokens).toBe(1_500_000);
    expect(u.estimatedCostUsd).toBe(0);
    expect(u.costUnknown).toBeUndefined();
    expect(resolveModelPricing({ ...model, inputCostPer1kTokens: 9, outputCostPer1kTokens: 9 })).toEqual({ input: 0, output: 0, unknown: false });
  });
});
