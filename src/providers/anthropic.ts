// ─────────────────────────────────────────────
//  Cascade AI — Anthropic Provider
// ─────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import type {
  ConversationMessage,
  GenerateOptions,
  GenerateResult,
  ImageAttachment,
  ModelInfo,
  ProviderConfig,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import { MODELS } from '../constants.js';
import { BaseProvider } from './base.js';
import { withResolvedPricing } from '../core/router/pricing.js';
import { isChatModel } from './model-filter.js';
import { fetchSameOrigin, stripTrailingSlashes } from '../utils/net.js';

// Anthropic extended thinking — only the 4.x reasoning models (Opus 4 / Sonnet 4)
// support it. budget_tokens must be >= 1024 and < max_tokens; we cap well under
// the cap. Returns {} for unsupported models so their requests are unchanged.
function anthropicThinkingParam(modelId: string, maxTokens: number): { thinking?: { type: 'enabled'; budget_tokens: number } } {
  if (!/claude-(opus|sonnet)-4/i.test(modelId)) return {};
  const budget = Math.min(8000, maxTokens - 1024);
  if (budget < 1024) return {};
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

/**
 * Tool definitions in the shape this provider actually submits.
 *
 * Exported so the router's budget preflight sizes the request the provider
 * will send rather than the one the caller passed — `inputSchema` goes as
 * `input_schema`, and the estimate has to agree with the wire, not with
 * itself. One function, used by both, so the two cannot drift.
 */
export function toAnthropicTools(tools: readonly ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));
}

/**
 * An assistant turn's tool calls in the shape this provider actually submits.
 *
 * Exported for the same reason as the tool definitions: the budget preflight
 * has to size the envelope the provider adds, not Cascade's normalized
 * `{id,name,input}`. Sharing the function means the estimate cannot drift from
 * the request.
 */
export function toAnthropicToolUse(toolCalls: readonly ToolCall[]): Anthropic.ToolUseBlockParam[] {
  return toolCalls.map((tc) => ({
    type: 'tool_use' as const,
    id: tc.id,
    name: tc.name,
    input: tc.input,
  }));
}

/**
 * A configured Anthropic endpoint reduced to the ROOT the SDK expects.
 *
 * The SDK owns the version segment: every resource path it builds already
 * starts `/v1/…`, and `buildURL()` is a plain `baseURL + path` concatenation.
 * So a gateway written the natural way — `https://gw.example/v1`, the form
 * discovery and `cascade link` both accept — produced `/v1/v1/messages` and
 * failed EVERY generation call. Model discovery did not fail with it, because
 * that request is issued by hand, so a gateway could list its models and then
 * refuse every message: the two disagreed about what `baseUrl` meant.
 *
 * One trailing version segment is stripped, and both callers below derive their
 * URL from this, so they cannot drift apart again.
 */
export function anthropicApiRoot(configured: string | undefined): string | undefined {
  if (!configured) return undefined;
  const trimmed = stripTrailingSlashes(configured.trim());
  if (!trimmed) return undefined;
  return trimmed.replace(/\/v\d+$/, '');
}

/**
 * The fetch the SDK client uses, refusing to follow a redirect off-origin.
 *
 * Generation carries `x-api-key`, and a custom header is not stripped across
 * origins the way `Authorization` is — the same leak closed for the model-list
 * request, arriving by the other door. Model discovery issues its request by
 * hand and was guarded first; generation goes through the SDK, so the guard has
 * to be installed there rather than at a call site.
 *
 * The SDK invokes this as `fetch(url, init)` with a string URL (`client.js`
 * `this.fetch.call(undefined, url, fetchOptions)`), so unwrapping a `Request`
 * is not a case that arises; it is handled for the URL only, and would fail
 * loudly rather than quietly skip the guard.
 */
const sameOriginFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.toString()
    : input.url;
  return fetchSameOrigin(url, init);
}) as unknown as typeof fetch;

/**
 * Which credential this config may put on the wire, and how to send it.
 *
 * ONE decision, because the constructor and `listModels()` each made it
 * separately and disagreed — the third time in this release that discovery and
 * generation have diverged on the same question. `listModels()` builds its
 * request by hand and read `config.authToken` directly, so a config carrying a
 * bearer AND an api key with no gateway had generation correctly use the key
 * while discovery sent `Authorization: Bearer` to the public default host.
 *
 * The rule both now share: a bearer is valid only at the gateway that issued
 * it, so without `baseUrl` it is not sendable. An api key alongside it is, and
 * is used instead. A bearer with neither gateway nor key is refused outright
 * rather than downgraded to an anonymous request.
 */
export function anthropicAuth(
  config: { apiKey?: string; authToken?: string; baseUrl?: string },
): { mode: 'bearer'; token: string } | { mode: 'apiKey'; key: string } | { mode: 'none' } {
  const gateway = anthropicApiRoot(config.baseUrl);
  if (config.authToken && gateway) return { mode: 'bearer', token: config.authToken };
  if (config.apiKey) return { mode: 'apiKey', key: config.apiKey };
  if (config.authToken) {
    throw new Error(
      'Anthropic bearer token configured without a gateway URL. A bearer is only valid at the '
      + 'gateway that issued it, so it will not be sent to the public API. Set `baseUrl` to that '
      + 'gateway, or configure `apiKey` instead.',
    );
  }
  return { mode: 'none' };
}

export class AnthropicProvider extends BaseProvider {
  private client: Anthropic;

  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    // `baseUrl` is honoured on BOTH paths. Dropping it was what made
    // `authToken` close to useless: the sanctioned use of a bearer credential
    // is routing through an LLM gateway or corporate proxy — which is what
    // Anthropic documents ANTHROPIC_AUTH_TOKEN for — and that needs the
    // endpoint. Without it, a user who configured a gateway had their request
    // sent to api.anthropic.com with a token that gateway had issued.
    // Through anthropicApiRoot(), because the SDK appends its own `/v1`.
    const baseURL = anthropicApiRoot(config.baseUrl);
    // A bearer token authenticates via Authorization: Bearer instead of
    // x-api-key, which the SDK's `authToken` option does on its own.
    //
    // NO oauth beta header. `anthropic-beta: oauth-2025-04-20` belongs to the
    // Claude subscription flow, which this release makes non-adoptable — the
    // only bearer that can reach here now is a gateway's, and asking a gateway
    // to honour an Anthropic beta it knows nothing about is a way to have a
    // perfectly valid credential rejected.
    //
    // This constructor is the last gate before the credential goes on the wire
    // and it enforced nothing. The public SDK reaches it without touching the
    // config paths that do: `createCascade()` runs `CascadeConfigSchema.parse()`
    // alone, and `ProviderConfigSchema` permits `authToken` with no `baseUrl`,
    // so `createCascade({ providers: [{ type: 'anthropic', authToken }] })`
    // built a client with `baseURL` undefined — the SDK's public default host
    // — and sent a gateway's token to api.anthropic.com.
    const auth = anthropicAuth(config);
    if (auth.mode === 'bearer') {
      this.client = new Anthropic({ authToken: auth.token, fetch: sameOriginFetch, baseURL });
    } else {
      this.client = new Anthropic({
        apiKey: auth.mode === 'apiKey' ? auth.key : undefined,
        fetch: sameOriginFetch,
        ...(baseURL ? { baseURL } : {}),
      });
    }
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const chunks: StreamChunk[] = [];
    return this.generateStream(options, (c) => chunks.push(c));
  }

  async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<GenerateResult> {
    const messages = this.convertMessages(options.messages);
    const tools = options.tools && toAnthropicTools(options.tools);

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const maxTokens = options.maxTokens ?? this.model.maxOutputTokens;
    const thinkParam = anthropicThinkingParam(this.model.id, maxTokens);
    const useThinking = !!thinkParam.thinking;
    const stream = this.client.messages.stream({
      model: this.model.id,
      max_tokens: maxTokens,
      // Extended thinking requires temperature = 1; otherwise honor the request.
      temperature: useThinking ? 1 : (options.temperature ?? 0.7),
      system: options.systemPrompt,
      messages,
      tools: tools?.length ? tools : undefined,
      ...thinkParam,
    }, { signal: options.signal });

    let isThinking = false;

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if ((event.delta as any).type === 'thinking_delta') {
          if (!isThinking) {
            isThinking = true;
            fullContent += '<think>\n';
            onChunk({ text: '<think>\n', finishReason: null });
          }
          const text = (event.delta as any).thinking;
          fullContent += text;
          onChunk({ text, finishReason: null });
        } else if (event.delta.type === 'text_delta') {
          if (isThinking) {
            isThinking = false;
            fullContent += '\n</think>\n\n';
            onChunk({ text: '\n</think>\n\n', finishReason: null });
          }
          const text = event.delta.text;
          fullContent += text;
          onChunk({ text, finishReason: null });
        }
      } else if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens;
      } else if (event.type === 'message_start' && event.message.usage) {
        inputTokens = event.message.usage.input_tokens;
      }
    }

    if (isThinking) {
      fullContent += '\n</think>\n\n';
      onChunk({ text: '\n</think>\n\n', finishReason: null });
    }

    const finalMessage = await stream.finalMessage();
    const toolCalls = finalMessage.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      }));

    onChunk({ text: '', finishReason: finalMessage.stop_reason as GenerateResult['finishReason'] });

    return {
      content: fullContent,
      usage: this.makeUsage(inputTokens, outputTokens),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: (finalMessage.stop_reason as GenerateResult['finishReason']) ?? 'stop',
    };
  }

  async countTokens(text: string): Promise<number> {
    // Anthropic token counting is often simplified to 4 chars per token if the SDK doesn't support it directly
    return Math.ceil(text.length / 4);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      // Discovery follows the SAME endpoint and auth mode as generation. It
      // used to hardcode api.anthropic.com with `x-api-key`, which meant a
      // gateway deployment sent the GATEWAY'S key to Anthropic's real API — a
      // credential going to a host that was never meant to see it — and then
      // replaced the gateway's own catalogue with the public one, so routing
      // picked models the gateway may not serve. With a bearer token
      // configured it sent an empty `x-api-key` and always fell through.
      // The version segment comes from the SAME place the client's does. A
      // gateway baseUrl is commonly written with the version in it, and
      // appending unconditionally produced /v1/v1/models — a 404 that fell
      // silently back to the bundled catalogue and looked exactly like a
      // gateway with no models of its own. Deriving both from
      // anthropicApiRoot() is what keeps discovery and generation addressing
      // one host: an earlier fix corrected this URL alone, leaving the client
      // still pointed at /v1/v1/messages.
      const base = anthropicApiRoot(this.config.baseUrl) ?? 'https://api.anthropic.com';
      const modelsUrl = `${base}/v1/models`;
      const auth = anthropicAuth(this.config);
      // Same-origin redirects only: `x-api-key` is a custom header, so the
      // platform does NOT strip it across origins the way it strips
      // Authorization. A gateway that redirected elsewhere would be handed the
      // key configured for it.
      const resp = await fetchSameOrigin(modelsUrl, {
        headers: {
          // Same decision the constructor makes — see anthropicAuth(). Read
          // straight off `config`, this branch sent a bearer to the public
          // default host whenever no gateway was configured.
          ...(auth.mode === 'bearer'
            ? { authorization: `Bearer ${auth.token}` }
            : { 'x-api-key': auth.mode === 'apiKey' ? auth.key : '' }),
          'anthropic-version': '2023-06-01',
        },
      });
      // Anthropic returns JSON-encoded error objects ({ type: "error", ... })
      // for 4xx/5xx responses. Calling `.data.map` on that crashes the caller
      // and hides the real authentication / network error. Fall through to
      // the hardcoded model list instead.
      if (!resp.ok) {
        return Object.values(MODELS).filter((m) => m.provider === 'anthropic');
      }
      const data = await resp.json() as { data?: Array<{ id: string; display_name: string }> };
      if (!Array.isArray(data?.data)) {
        return Object.values(MODELS).filter((m) => m.provider === 'anthropic');
      }

      return data.data.filter((m) => isChatModel(m.id)).map((m) => {
        const known = Object.values(MODELS).find((km) => km.id === m.id && km.provider === 'anthropic');
        if (known) return known;

        // Dataset price, or an explicit "unknown" — never a silent $0.
        return withResolvedPricing({
          id: m.id,
          name: m.display_name || m.id,
          provider: 'anthropic' as const,
          contextWindow: m.id.includes('3.5-sonnet') ? 200_000 : 100_000,
          isVisionCapable: true,
          inputCostPer1kTokens: 0,
          outputCostPer1kTokens: 0,
          maxOutputTokens: 8_000,
          supportsStreaming: true,
          isLocal: false,
        });
      });
    } catch {
      return Object.values(MODELS).filter((m) => m.provider === 'anthropic');
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Available with either an API key or an OAuth bearer token.
      return !!(this.config.apiKey || this.config.authToken);
    } catch {
      return false;
    }
  }

  private convertMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const m of messages) {
      // System messages in history are skipped — they're passed via the top-level `system` field
      if (m.role === 'system') continue;

      // ── Tool result messages → Anthropic tool_result content block ─────
      if (m.role === 'tool') {
        const toolContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        result.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: toolContent,
          }] as any,
        });
        continue;
      }

      // ── Assistant messages: may carry tool_use blocks ──────────────────
      if (m.role === 'assistant') {
        const content: any[] = [];

        // Text part
        const text = typeof m.content === 'string' ? m.content : '';
        if (text) content.push({ type: 'text', text });

        // Tool calls → tool_use blocks
        content.push(...toAnthropicToolUse(m.toolCalls ?? []));

        if (content.length > 0) {
          result.push({ role: 'assistant', content });
        }
        continue;
      }

      // ── User messages ──────────────────────────────────────────────────
      if (m.role === 'user') {
        if (typeof m.content === 'string') {
          result.push({ role: 'user', content: m.content });
        } else {
          const content: any[] = m.content.map((block) => {
            if (block.type === 'text') return { type: 'text' as const, text: block.text };
            if (block.type === 'image') {
              const img = block.image as ImageAttachment;
              if (img.type === 'base64') {
                return {
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: img.mimeType, data: img.data },
                };
              }
              return { type: 'image' as const, source: { type: 'url' as const, url: img.data } as any };
            }
            return { type: 'text' as const, text: '' };
          });
          result.push({ role: 'user', content });
        }
      }
    }

    return result;
  }
}
