// ─────────────────────────────────────────────
//  Cascade AI — OpenAI Provider
// ─────────────────────────────────────────────

import OpenAI from 'openai';
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
import { isOpenAIReasoningModel, openaiReasoningEffort } from './thinking.js';

/**
 * Reasoning-family models (o1/o3/o4, gpt-5*) reject the classic `max_tokens`
 * and a non-default `temperature` — they require `max_completion_tokens` and
 * temperature 1 (i.e. omit it). Deployment names are user-chosen (an Azure
 * `gpt-5-mini` deployment could be named anything), so this heuristic is only a
 * first guess; the request path also LEARNS from the API's own error and adapts.
 */
export function isReasoningModel(id: string): boolean {
  return isOpenAIReasoningModel(id);
}

/**
 * Models whose function calling works ONLY through the Responses API.
 * OpenAI's GPT-6 guide: tool calling requires Responses for GPT-6 Astra,
 * GPT-6.1 Sol and GPT-6.1 Terra. Sent through Chat Completions with `tools`,
 * they cannot run a tool loop — which is everything T1 and T2 do.
 */
export function requiresResponsesForTools(id: string): boolean {
  return /gpt-?6(?:\.1-(?:sol|terra)|-astra)/i.test(id || '');
}

/**
 * Models that call functions through Chat Completions only at
 * `reasoning_effort: 'none'`: GPT-6 Luna and GPT-6 Sol (OpenAI's GPT-6 guide;
 * Luna's page: "Chat Completions supports function calling only with
 * `reasoning_effort` set to `none`"). Their default is `medium`, so a tool
 * request that does not say so gets no working tool calls. GPT-6.1 Sol is a
 * different model and goes through Responses instead.
 */
export function chatToolsNeedNoReasoning(id: string): boolean {
  return /gpt-?6-(?:luna|sol)(?![\w.])/i.test(id || '');
}

/** How many tool calls' reasoning items a provider keeps for replay. */
export const REASONING_REPLAY_LIMIT = 1000;

/**
 * An assistant turn's tool calls as Responses `function_call` ITEMS: the shape
 * `convertToResponsesInput` submits, shared with the budget preflight so the
 * estimate cannot drift from the request.
 */
export function toResponsesFunctionCalls(toolCalls: readonly ToolCall[]): Array<{ type: 'function_call'; call_id: string; name: string; arguments: string }> {
  return toolCalls.map((tc) => ({ type: 'function_call' as const, call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.input) }));
}

/** Tool definitions in the Responses API's flat function shape. */
export function toResponsesTools(tools: readonly ToolDefinition[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    // Cascade's tool schemas are not written for strict mode (optional fields,
    // open objects), which strict would reject outright.
    strict: false,
  }));
}

/** True when an API error indicates the wrong token param / temperature was sent. */
export function isParamShapeError(err: unknown): boolean {
  const e = err as { message?: string; error?: { message?: string } } | undefined;
  const msg = String(e?.message ?? e?.error?.message ?? '').toLowerCase();
  return (
    msg.includes('max_completion_tokens') ||
    (msg.includes('max_tokens') && (msg.includes('unsupported') || msg.includes('not supported') || msg.includes('use'))) ||
    (msg.includes('temperature') && (msg.includes('unsupported') || msg.includes('does not support') || msg.includes('only the default')))
  );
}

/**
 * Tool definitions in the shape this provider actually submits.
 *
 * Exported because the router's budget preflight has to size a request before
 * it is sent, and the envelope is not free: `{type, function:{...}}` around
 * every definition is a few tokens each, which a large MCP server turns into
 * hundreds. Sharing the one function means the estimate cannot drift from the
 * request — the alternative, a second copy over in the router, is exactly how
 * it drifted before.
 */
export function toOpenAITools(tools: readonly ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * An assistant turn's tool calls in the shape this provider actually submits.
 *
 * Note `arguments`: the input object is serialized to a STRING and then
 * embedded in JSON, so every quote inside it is escaped a second time. Sizing
 * the raw object instead under-counted a history of tool calls by most of that
 * escaping, which is the direction that lets a request slip a cap.
 */
export function toOpenAIToolCalls(
  toolCalls: readonly ToolCall[],
): OpenAI.Chat.ChatCompletionMessageToolCall[] {
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input),
    },
  }));
}

export class OpenAIProvider extends BaseProvider {
  protected client: OpenAI;
  /**
   * Reasoning items a Responses call returned alongside its function calls,
   * keyed by call_id. OpenAI: "any reasoning items returned in model responses
   * with tool calls must also be passed back with tool call outputs." Calls
   * are stateless (`store: false`), so the encrypted items are the only copy;
   * they are replayed before the matching function_call on the next turn of
   * the same loop. The router keeps one provider per model for its lifetime,
   * which is what lets a planner's second turn find its first turn's items.
   * Bounded, oldest out first; a missing entry just means no replay, which is
   * how every call behaved before.
   */
  protected reasoningByCallId = new Map<string, OpenAI.Responses.ResponseReasoningItem[]>();
  /** Once we learn (from the model id or an API error) that this deployment
   *  needs max_completion_tokens, remember it so we don't re-fail every call. */
  protected useMaxCompletionTokens: boolean;

  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    this.useMaxCompletionTokens = isReasoningModel(model.id);
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const chunks: StreamChunk[] = [];
    return this.generateStream(options, (c) => chunks.push(c));
  }

  async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<GenerateResult> {
    const modelId = this.model.baseModelId ?? this.model.id;
    // First-party OpenAI only: Azure and OpenAI-compatible gateways extend this
    // class but publish their own Responses support, so they stay on Chat
    // Completions (Azure marks these deployments tool-less instead).
    if (options.tools?.length && this.model.provider === 'openai' && requiresResponsesForTools(modelId)) {
      return this.generateViaResponses(options, onChunk);
    }
    const messages = this.convertMessages(options.messages, options.systemPrompt);
    const tools = options.tools && toOpenAITools(options.tools);

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: GenerateResult['finishReason'] = 'stop';

    const budget = options.maxTokens ?? this.model.maxOutputTokens;
    const effort = this.reasoningEffort(modelId, options, !!tools?.length);
    // Build the request shape based on what we currently believe this model
    // accepts. Reasoning models take `max_completion_tokens` and reject a custom
    // temperature (omit it); everyone else takes classic `max_tokens`.
    const buildParams = (useCompletionTokens: boolean): Record<string, unknown> => ({
      model: this.model.id,
      messages,
      ...(useCompletionTokens ? { max_completion_tokens: budget } : { max_tokens: budget }),
      ...(useCompletionTokens ? {} : { temperature: options.temperature ?? 0.7 }),
      tools: tools?.length ? tools : undefined,
      ...(effort ? { reasoning_effort: effort } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    let stream: any;
    try {
      stream = await this.client.chat.completions.create(buildParams(this.useMaxCompletionTokens) as any, { signal: options.signal });
    } catch (err: any) {
      // The API told us the param shape was wrong — flip to max_completion_tokens
      // (dropping temperature), remember it for the rest of this run, and retry.
      if (!this.useMaxCompletionTokens && isParamShapeError(err)) {
        this.useMaxCompletionTokens = true;
        stream = await this.client.chat.completions.create(buildParams(true) as any, { signal: options.signal });
      } else {
        throw err;
      }
    }

    const toolCallsMap: Record<number, { id: string; name: string; args: string }> = {};
    let isThinking = false;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      const reasoningContent = (delta as any)?.reasoning_content;
      if (reasoningContent) {
        if (!isThinking) {
          isThinking = true;
          fullContent += '<think>\n';
          onChunk({ text: '<think>\n', finishReason: null });
        }
        fullContent += reasoningContent;
        onChunk({ text: reasoningContent, finishReason: null });
      }

      if (delta?.content) {
        if (isThinking) {
          isThinking = false;
          fullContent += '\n</think>\n\n';
          onChunk({ text: '\n</think>\n\n', finishReason: null });
        }
        fullContent += delta.content;
        onChunk({ text: delta.content, finishReason: null });
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsMap[idx]) {
            toolCallsMap[idx] = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
          }
          if (tc.function?.arguments) toolCallsMap[idx]!.args += tc.function.arguments;
          if (tc.id) toolCallsMap[idx]!.id = tc.id;
          if (tc.function?.name) toolCallsMap[idx]!.name = tc.function.name;
        }
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = (chunk.choices[0].finish_reason as GenerateResult['finishReason']) ?? 'stop';
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    if (isThinking) {
      fullContent += '\n</think>\n\n';
      onChunk({ text: '\n</think>\n\n', finishReason: null });
    }

    const toolCalls = Object.values(toolCallsMap).map((tc) => {
      // OpenAI streams tool-call arguments as incremental fragments. If the
      // stream is truncated (e.g. max_tokens hit mid-argument, connection
      // dropped, or the model returned empty args) the concatenated string
      // may not be valid JSON. Crashing here throws away the whole response
      // — degrade gracefully by surfacing an empty input and letting the
      // tier decide what to do.
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.args || '{}') as Record<string, unknown>;
      } catch {
        input = { __rawArguments: tc.args, __parseError: true };
      }
      return { id: tc.id, name: tc.name, input };
    });

    onChunk({ text: '', finishReason });

    return {
      content: fullContent,
      usage: this.makeUsage(inputTokens, outputTokens),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
    };
  }

  /**
   * The reasoning effort to send, or undefined for none: the run's thinking
   * level (src/providers/thinking.ts), except that GPT-6 Luna and Sol call tools
   * through Chat Completions only at `none`. Azure deployments override this to
   * send none at all.
   */
  protected reasoningEffort(modelId: string, options: GenerateOptions, chatTools: boolean): string | undefined {
    if (chatTools && chatToolsNeedNoReasoning(modelId)) return 'none';
    return openaiReasoningEffort(modelId, options.thinking);
  }

  /**
   * The request body of one Responses call. A subclass whose route accepts
   * fewer fields (ChatGPT plan usage) narrows it here rather than rebuilding it.
   */
  protected responsesParams(options: GenerateOptions): Record<string, unknown> {
    const responsesEffort = this.reasoningEffort(this.model.baseModelId ?? this.model.id, options, false);
    return {
      model: this.model.id,
      input: this.convertToResponsesInput(options.messages),
      ...(options.systemPrompt ? { instructions: options.systemPrompt } : {}),
      tools: toResponsesTools(options.tools ?? []),
      max_output_tokens: options.maxTokens ?? this.model.maxOutputTokens,
      ...(responsesEffort ? { reasoning: { effort: responsesEffort as OpenAI.ReasoningEffort } } : {}),
      store: false,
      // Without storage, the encrypted reasoning is the only way the next
      // turn can carry this turn's reasoning forward.
      include: ['reasoning.encrypted_content'],
      stream: true,
    };
  }

  /** Opens the event stream. Overridden where the client or its credential changes per request. */
  protected async createResponsesStream(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>> {
    return await this.client.responses.create(params as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { signal }) as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
  }

  /** Called for each function call the model returns (its item, with any fields this SDK version does not type). */
  protected onResponsesFunctionCall(_item: Record<string, unknown>): void { /* nothing to remember by default */ }

  /**
   * True where only `response.completed` counts as success. A stream that
   * ends without it, or ends `response.incomplete`, is an error: the default
   * keeps the lenient behaviour every other Responses caller has had.
   */
  protected responsesRequireCompleted = false;

  /** The error for a `response.failed` / stream `error` event. */
  protected responsesFailure(err: { code?: string | null; message?: string | null; param?: string | null } | null | undefined): Error {
    return new Error(err ? `${err.code}: ${err.message}` : 'OpenAI Responses API request failed');
  }

  /** The error for a stream that did not finish with `response.completed` (only when required). */
  protected responsesIncomplete(reason?: string): Error {
    return new Error(reason ? `The response ended early (${reason}).` : 'The response stream ended without response.completed.');
  }

  /**
   * The same contract as the Chat Completions path — streamed text, tool calls
   * with parsed input, usage, finish reason — over the Responses API, for the
   * models that only call tools there.
   *
   * Stateless (`store: false`): Cascade owns the conversation and resends it
   * each turn, exactly as it does for Chat Completions, so nothing is kept on
   * OpenAI's side between calls.
   */
  protected async generateViaResponses(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<GenerateResult> {
    const params = this.responsesParams(options);
    const stream = await this.createResponsesStream(params, options.signal);

    let fullContent = '';
    let isThinking = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: GenerateResult['finishReason'] = 'stop';
    let completed = false;
    // Keyed by output item id, in the order the items appear.
    const calls = new Map<string, { id: string; name: string; args: string }>();
    const reasoning: OpenAI.Responses.ResponseReasoningItem[] = [];

    const closeThinking = () => {
      if (!isThinking) return;
      isThinking = false;
      fullContent += '\n</think>\n\n';
      onChunk({ text: '\n</think>\n\n', finishReason: null });
    };

    for await (const event of stream) {
      switch (event.type) {
        case 'response.reasoning_summary_text.delta': {
          if (!isThinking) {
            isThinking = true;
            fullContent += '<think>\n';
            onChunk({ text: '<think>\n', finishReason: null });
          }
          fullContent += event.delta;
          onChunk({ text: event.delta, finishReason: null });
          break;
        }
        case 'response.output_text.delta': {
          closeThinking();
          fullContent += event.delta;
          onChunk({ text: event.delta, finishReason: null });
          break;
        }
        case 'response.output_item.added': {
          if (event.item.type === 'function_call') {
            calls.set(event.item.id ?? event.item.call_id, {
              id: event.item.call_id, name: event.item.name, args: event.item.arguments ?? '',
            });
            this.onResponsesFunctionCall(event.item as unknown as Record<string, unknown>);
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          const call = calls.get(event.item_id);
          if (call) call.args += event.delta;
          break;
        }
        case 'response.output_item.done': {
          if (event.item.type === 'reasoning') reasoning.push(event.item);
          if (event.item.type === 'function_call') {
            // The item's own final form, even when its `added` event was not seen.
            const key = event.item.id ?? event.item.call_id;
            if (!calls.has(key)) calls.set(key, { id: event.item.call_id, name: event.item.name, args: event.item.arguments ?? '' });
            this.onResponsesFunctionCall(event.item as unknown as Record<string, unknown>);
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          // The complete string, authoritative over the accumulated deltas.
          const call = calls.get(event.item_id);
          if (call) call.args = event.arguments;
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          if (event.type === 'response.incomplete' && this.responsesRequireCompleted) {
            throw this.responsesIncomplete(event.response.incomplete_details?.reason ?? undefined);
          }
          completed = true;
          const usage = event.response.usage;
          if (usage) {
            inputTokens = usage.input_tokens;
            outputTokens = usage.output_tokens;
          }
          if (event.type === 'response.incomplete') {
            // A content-filter stop has no slot in GenerateResult; only a
            // token-budget stop is a truncation the caller can act on.
            if (event.response.incomplete_details?.reason === 'max_output_tokens') finishReason = 'length';
          }
          break;
        }
        case 'response.failed': {
          throw this.responsesFailure(event.response.error);
        }
        // A stream-level error (not a failed response). Returning normally here
        // would hand the tier an empty "success" instead of letting the router
        // retry or fail over.
        case 'error':
          throw this.responsesFailure({ code: event.code ?? 'error', message: event.message, param: event.param });
        default:
          break;
      }
    }
    closeThinking();
    if (this.responsesRequireCompleted && !completed) throw this.responsesIncomplete();

    const toolCalls = [...calls.values()].map((tc) => {
      // Same degradation as the Chat Completions path: a truncated argument
      // string is surfaced, not thrown.
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.args || '{}') as Record<string, unknown>;
      } catch {
        input = { __rawArguments: tc.args, __parseError: true };
      }
      return { id: tc.id, name: tc.name, input };
    });
    if (toolCalls.length && finishReason === 'stop') finishReason = 'tool_use';
    if (reasoning.length) for (const tc of toolCalls) this.rememberReasoning(tc.id, reasoning);

    onChunk({ text: '', finishReason });
    return {
      content: fullContent,
      usage: this.makeUsage(inputTokens, outputTokens),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
    };
  }

  private rememberReasoning(callId: string, items: OpenAI.Responses.ResponseReasoningItem[]): void {
    this.reasoningByCallId.delete(callId);
    this.reasoningByCallId.set(callId, items);
    while (this.reasoningByCallId.size > REASONING_REPLAY_LIMIT) {
      const oldest = this.reasoningByCallId.keys().next().value;
      if (oldest === undefined) break;
      this.reasoningByCallId.delete(oldest);
    }
  }

  /**
   * Cascade's conversation as Responses input items. A tool round trip is two
   * ITEMS here, not message fields: the assistant's `function_call` and the
   * matching `function_call_output`, joined by `call_id`. System prompts go in
   * `instructions`; system messages mid-conversation stay system messages.
   */
  protected convertToResponsesInput(messages: ConversationMessage[]): OpenAI.Responses.ResponseInputItem[] {
    const out: OpenAI.Responses.ResponseInputItem[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        out.push({
          type: 'function_call_output',
          call_id: m.toolCallId ?? '',
          output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
        continue;
      }
      if (m.role === 'assistant') {
        // The model's own order: reasoning, then its message, then the calls.
        // Several calls from one response share the same reasoning items, so
        // each is sent once.
        const sent = new Set<string>();
        for (const tc of m.toolCalls ?? []) {
          for (const item of this.reasoningByCallId.get(tc.id) ?? []) {
            if (sent.has(item.id)) continue;
            sent.add(item.id);
            out.push(item);
          }
        }
        const text = typeof m.content === 'string'
          ? m.content
          : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        if (text) out.push({ role: 'assistant', content: text });
        out.push(...toResponsesFunctionCalls(m.toolCalls ?? []));
        continue;
      }
      if (typeof m.content === 'string') {
        out.push({ role: m.role as 'user' | 'system', content: m.content });
        continue;
      }
      const parts: OpenAI.Responses.ResponseInputContent[] = m.content.map((block) => {
        if (block.type === 'image') {
          const img = block.image as ImageAttachment;
          const url = img.type === 'base64' ? `data:${img.mimeType};base64,${img.data}` : img.data;
          return { type: 'input_image' as const, image_url: url, detail: 'auto' as const };
        }
        return { type: 'input_text' as const, text: block.type === 'text' ? block.text : '' };
      });
      out.push({ role: m.role as 'user' | 'system', content: parts });
    }
    return out;
  }

  async countTokens(text: string): Promise<number> {
    // Rough approximation: 4 chars ≈ 1 token
    return Math.ceil(text.length / 4);
  }

  async listModels(options: { staticFallback?: boolean } = {}): Promise<ModelInfo[]> {
  // Same contract Anthropic honours (see BaseProvider.listModels). The bundled
  // catalogue is right for a settings list and wrong for router validation,
  // which reads a non-empty result as "the endpoint confirmed these ids",
  // caches it and pins Auto to them — so a 401 or an outage was being recorded
  // as confirmation of the PUBLIC catalogue. The parameter existed and this
  // provider ignored it, which is worse than not having it: the router asked
  // for confirmed models and was answered with a guess.
    const staticCatalog = () => (options.staticFallback === false
      ? []
      : Object.values(MODELS).filter((m) => m.provider === 'openai'));
    try {
      const response = await this.client.models.list();
      return response.data.filter((m) => isChatModel(m.id)).map((m) => {
        const known = Object.values(MODELS).find((km) => km.id === m.id && km.provider === 'openai');
        if (known) return known;

        // Dataset price, or an explicit "unknown" — never a silent $0.
        return withResolvedPricing({
          id: m.id,
          name: m.id,
          provider: 'openai' as const,
          contextWindow: 128_000,
          isVisionCapable: m.id.includes('vision') || m.id.includes('gpt-4o'),
          inputCostPer1kTokens: 0,
          outputCostPer1kTokens: 0,
          maxOutputTokens: 4_000,
          supportsStreaming: true,
          isLocal: false,
        });
      });
    } catch {
      return staticCatalog();
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  protected convertMessages(
    messages: ConversationMessage[],
    systemPrompt?: string,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const m of messages) {
      if (m.role === 'system') {
        result.push({ role: 'system', content: typeof m.content === 'string' ? m.content : '' });
        continue;
      }
      if (m.role === 'tool') {
        result.push({
          role: 'tool',
          content: typeof m.content === 'string' ? m.content : '',
          tool_call_id: m.toolCallId ?? '',
        });
        continue;
      }
      if (typeof m.content === 'string') {
        if (m.role === 'assistant' && m.toolCalls?.length) {
          result.push({
            role: 'assistant',
            content: m.content || '',
            tool_calls: toOpenAIToolCalls(m.toolCalls),
          } as any);
        } else {
          result.push({ role: m.role as 'user' | 'assistant', content: m.content });
        }
        continue;
      }

      const parts: OpenAI.Chat.ChatCompletionContentPart[] = m.content.map((block) => {
        if (block.type === 'text') return { type: 'text' as const, text: block.text };
        if (block.type === 'image') {
          const img = block.image as ImageAttachment;
          const url = img.type === 'base64' ? `data:${img.mimeType};base64,${img.data}` : img.data;
          return {
            type: 'image_url' as const,
            image_url: { url },
          };
        }
        return { type: 'text' as const, text: '' };
      });

      result.push({ role: m.role as 'user' | 'assistant', content: parts } as any);
    }

    return result;
  }
}
