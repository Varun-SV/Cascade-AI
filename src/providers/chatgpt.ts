// ─────────────────────────────────────────────
//  Cascade AI — ChatGPT plan provider
// ─────────────────────────────────────────────
//
//  Inference on the user's own ChatGPT plan, through Sign in with ChatGPT
//  (src/auth/chatgpt). Every request goes through the Responses path of
//  OpenAIProvider with a fresh access token as the bearer, narrowed to what
//  the preview route accepts:
//
//    - `store: false`, `stream: true`; history is resent in `input`
//    - the system prompt in `instructions`, never a system message item
//    - none of: max_output_tokens, temperature, top_p, metadata, user,
//      previous_response_id, truncation (and the rest of the spec's list)
//    - function tools grouped in one namespace
//    - success only on `response.completed`
//
//  Plan usage costs the user no per-token money: tokens are counted, cost is $0
//  (see isPlanBilled in core/router/pricing.ts). Nothing here switches to
//  another billing path; a failure is reported as it is.

import OpenAI from 'openai';
import type {
  ConversationMessage, GenerateOptions, ModelInfo, ProviderConfig, ToolDefinition,
} from '../types.js';
import { OpenAIProvider } from './openai.js';
import { ChatGptAuth, chatGptAuth } from '../auth/chatgpt/manager.js';
import { CHATGPT_RESOURCE } from '../auth/chatgpt/constants.js';
import { ChatGptAuthError, ChatGptRequestError, requestErrorFrom } from '../auth/chatgpt/errors.js';
import type { FetchLike } from '../auth/chatgpt/oidc.js';

/** The one namespace every Cascade tool is grouped in. */
export const TOOL_NAMESPACE = 'cascade';

/** Model ids registered by this provider are `chatgpt:<slug>`: a slug can equal an OpenAI API model id. */
export const CHATGPT_MODEL_PREFIX = 'chatgpt:';
export const chatGptSlug = (id: string): string => (id.startsWith(CHATGPT_MODEL_PREFIX) ? id.slice(CHATGPT_MODEL_PREFIX.length) : id);

/** Fields the preview route rejects (its Responses API requirements). Never sent. */
export const UNSUPPORTED_RESPONSES_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent',
  'prompt', 'prompt_cache_retention', 'previous_response_id', 'safety_identifier', 'temperature', 'top_logprobs',
  'top_p', 'truncation', 'user',
] as const;

/** Function tools in the one namespace the route requires them in. */
export function toNamespacedTools(tools: readonly ToolDefinition[]): Array<Record<string, unknown>> {
  if (!tools.length) return [];
  return [{
    type: 'namespace',
    name: TOOL_NAMESPACE,
    description: 'Cascade tools for reading, changing and running the user\'s project.',
    tools: tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
      strict: false,
    })),
  }];
}

export interface ChatGptProviderDeps {
  auth?: ChatGptAuth;
  fetch?: FetchLike;
  /** Waits between attempts at a temporary 503 (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

/** Bounded: a few tries at a 503, never a loop. */
const UNAVAILABLE_BACKOFF_MS = [1_000, 3_000];

/** An error in the SDK's shape, or ours, as the typed error. */
export function toChatGptError(err: unknown, rawBody?: string): unknown {
  if (err instanceof ChatGptRequestError || err instanceof ChatGptAuthError) return err;
  const e = err as { status?: number; error?: unknown; headers?: unknown; request_id?: string; message?: string; name?: string };
  if (typeof e?.status !== 'number') return err;
  // The SDK keeps only `body.error`, which drops the {detail} of a direct-admission
  // failure, so the raw body (captured by the fetch wrapper) is read first.
  let parsed: unknown;
  try { parsed = rawBody ? JSON.parse(rawBody) : undefined; } catch { parsed = undefined; }
  const body = (parsed && typeof parsed === 'object' ? parsed
    : e.error && typeof e.error === 'object' ? e.error : {}) as Record<string, unknown>;
  // Standard shape {error:{code,message,param}} (the SDK unwraps `error`), or the admission shape {detail}.
  const inner = (body['error'] && typeof body['error'] === 'object' ? body['error'] : body) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const headers = e.headers as { get?: (n: string) => string | null } | undefined;
  return requestErrorFrom({
    status: e.status,
    code: str(inner['code']),
    param: str(inner['param']),
    message: str(inner['message']) ?? str(body['detail']),
    requestId: e.request_id ?? headers?.get?.('x-request-id') ?? undefined,
  });
}

export class ChatGptProvider extends OpenAIProvider {
  private readonly auth: ChatGptAuth;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiBase: string;
  /** The namespace each returned function call came in, to echo it back. */
  private readonly namespaceByCallId = new Map<string, string>();
  /** Cleared if the route refuses `include`, so the request is not repeated with it. */
  private sendInclude = true;

  protected override responsesRequireCompleted = true;

  constructor(config: ProviderConfig, model: ModelInfo, deps: ChatGptProviderDeps = {}) {
    // The key is replaced with a fresh access token before every request.
    super({ ...config, apiKey: 'chatgpt-plan', baseUrl: deps.baseUrl ?? CHATGPT_RESOURCE }, model);
    this.auth = deps.auth ?? chatGptAuth();
    this.fetchImpl = deps.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.apiBase = deps.baseUrl ?? CHATGPT_RESOURCE;
  }

  // Everything goes through Responses, with or without tools.
  override async generateStream(
    options: GenerateOptions,
    onChunk: Parameters<OpenAIProvider['generateStream']>[1],
  ) {
    return this.generateViaResponses(options, onChunk);
  }

  protected override responsesParams(options: GenerateOptions): Record<string, unknown> {
    const params = super.responsesParams(options);
    for (const k of UNSUPPORTED_RESPONSES_FIELDS) delete params[k];
    params['model'] = chatGptSlug(this.model.id);
    params['store'] = false;
    params['stream'] = true;
    if (!this.sendInclude) delete params['include'];
    const tools = toNamespacedTools(options.tools ?? []);
    if (tools.length) params['tools'] = tools; else delete params['tools'];
    return params;
  }

  protected override async createResponsesStream(params: Record<string, unknown>, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      // A fresh token each time: it may have been renewed since the last call.
      const { accessToken } = await this.auth.getAccessToken();
      let rawBody: string | undefined;
      const send = this.fetchImpl ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
      const client = new OpenAI({
        apiKey: accessToken,
        baseURL: this.apiBase,
        // The route's own errors decide what happens next; the SDK must not retry a usage limit.
        maxRetries: 0,
        fetch: (async (input: string | URL, init?: RequestInit) => {
          const res = await send(input, init);
          if (!res.ok) rawBody = await res.clone().text().catch(() => undefined);
          return res;
        }) as never,
      });
      try {
        return await client.responses.create(
          params as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { signal },
        ) as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
      } catch (raw) {
        const err = toChatGptError(raw, rawBody);
        if (err instanceof ChatGptRequestError) {
          // Remove the one unsupported input and send once more. Never the same invalid body.
          if (err.kind === 'unsupported_capability' && this.sendInclude && params['include'] !== undefined
            && typeof err.param === 'string' && err.param.startsWith('include')) {
            this.sendInclude = false;
            delete params['include'];
            continue;
          }
          // A temporary 503: bounded backoff, credentials kept.
          if (err.retryable && attempt < UNAVAILABLE_BACKOFF_MS.length && !signal?.aborted) {
            await this.sleep(UNAVAILABLE_BACKOFF_MS[attempt]!);
            continue;
          }
          // A 401 from the route right after a token the store thought fresh: renew once.
          if (err.kind === 'admission_unauthorized' && attempt === 0) {
            await this.auth.getAccessToken({ forceRefresh: true });
            continue;
          }
        }
        throw err;
      }
    }
  }

  protected override onResponsesFunctionCall(item: Record<string, unknown>): void {
    if (typeof item['call_id'] === 'string' && typeof item['namespace'] === 'string' && item['namespace']) {
      this.namespaceByCallId.set(item['call_id'], item['namespace']);
    }
  }

  protected override responsesFailure(err: { code?: string | null; message?: string | null; param?: string | null } | null | undefined): Error {
    return requestErrorFrom({
      code: err?.code ?? undefined,
      param: err?.param ?? undefined,
      message: err?.message ?? undefined,
    });
  }

  protected override responsesIncomplete(reason?: string): Error {
    return new ChatGptRequestError(
      reason
        ? `The ChatGPT plan response was cut short (${reason}) and did not complete.`
        : 'The ChatGPT plan response stream ended without response.completed.',
      { kind: 'incomplete', retryable: false },
    );
  }

  /**
   * Responses input for the route: no system message items (a system message
   * partway through a conversation becomes a developer message), and each
   * echoed function call carries the namespace it was called in.
   */
  protected override convertToResponsesInput(messages: ConversationMessage[]): OpenAI.Responses.ResponseInputItem[] {
    return super.convertToResponsesInput(messages).map((item) => {
      const it = item as unknown as Record<string, unknown>;
      if (it['role'] === 'system') return { ...it, role: 'developer' } as unknown as OpenAI.Responses.ResponseInputItem;
      if (it['type'] === 'function_call') {
        const ns = this.namespaceByCallId.get(String(it['call_id'])) ?? TOOL_NAMESPACE;
        return { ...it, namespace: ns } as unknown as OpenAI.Responses.ResponseInputItem;
      }
      return item;
    });
  }

  /** The signed-in account's own catalogue: `slug`, `display_name`, `visibility === "list"`, in the server's order. */
  override async listModels(options: { staticFallback?: boolean } = {}): Promise<ModelInfo[]> {
    void options; // there is no bundled catalogue: an unreachable route lists nothing
    try {
      const { accessToken } = await this.auth.getAccessToken();
      const f = this.fetchImpl ?? ((input, init) => fetch(input, init));
      const res = await f(`${this.apiBase}/models`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return [];
      return parseModelCatalog(await res.json().catch(() => null));
    } catch {
      return [];
    }
  }

  /** Local and token-free: usable when a signed-in account approved plan usage. */
  override async isAvailable(): Promise<boolean> {
    if (this.auth.planReady()) return true;
    throw new Error('not signed in with ChatGPT, or plan usage is not enabled (run: cascade chatgpt signin)');
  }
}

/** The `/v1/models` body of this route as Cascade models. Exported for tests. */
export function parseModelCatalog(body: unknown): ModelInfo[] {
  const list = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  const out: ModelInfo[] = [];
  for (const m of list as Array<Record<string, unknown>>) {
    if (!m || m['visibility'] !== 'list' || typeof m['slug'] !== 'string' || !m['slug']) continue;
    const slug = m['slug'];
    const modalities = Array.isArray(m['input_modalities']) ? (m['input_modalities'] as unknown[]) : undefined;
    const ctx = [m['context_window'], m['max_context_window']].find((v): v is number => typeof v === 'number' && v > 0);
    out.push({
      id: `${CHATGPT_MODEL_PREFIX}${slug}`,
      name: typeof m['display_name'] === 'string' && m['display_name'] ? m['display_name'] : slug,
      provider: 'chatgpt',
      baseModelId: slug,
      contextWindow: ctx ?? 272_000,
      isVisionCapable: modalities ? modalities.includes('image') : true,
      // Plan usage: no per-token money. The price is a real zero, not a missing number.
      inputCostPer1kTokens: 0,
      outputCostPer1kTokens: 0,
      pricingUnknown: false,
      maxOutputTokens: 32_000,
      supportsStreaming: true,
      supportsToolUse: true,
      isLocal: false,
    });
  }
  return out;
}
