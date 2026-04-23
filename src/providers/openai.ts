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
} from '../types.js';
import { MODELS } from '../constants.js';
import { BaseProvider } from './base.js';

export class OpenAIProvider extends BaseProvider {
  protected client: OpenAI;

  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
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
    const messages = this.convertMessages(options.messages, options.systemPrompt);
    const tools = options.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: GenerateResult['finishReason'] = 'stop';

    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model.id,
      messages,
      max_tokens: options.maxTokens ?? this.model.maxOutputTokens,
      temperature: options.temperature ?? 0.7,
      tools: tools?.length ? tools : undefined,
      stream: true,
      stream_options: { include_usage: true },
    };

    let stream: any;
    try {
      stream = await this.client.chat.completions.create(params);
    } catch (err: any) {
      // Retry with max_completion_tokens instead if the model demands it (e.g., o1/o3 or custom proxy models)
      if (err.message && err.message.includes('max_completion_tokens')) {
        const fallbackParams = { ...params } as Record<string, unknown>;
        delete fallbackParams.max_tokens;
        fallbackParams.max_completion_tokens = options.maxTokens ?? this.model.maxOutputTokens;
        
        // o1 models also often strictly require temperature to be 1
        if (this.model.id.includes('o1') || this.model.id.includes('o3')) {
          fallbackParams.temperature = 1;
        }
        
        stream = await this.client.chat.completions.create(fallbackParams as any);
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

  async countTokens(text: string): Promise<number> {
    // Rough approximation: 4 chars ≈ 1 token
    return Math.ceil(text.length / 4);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list();
      return response.data.map((m) => {
        const known = Object.values(MODELS).find((km) => km.id === m.id && km.provider === 'openai');
        if (known) return known;

        return {
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
        };
      });
    } catch {
      return Object.values(MODELS).filter((m) => m.provider === 'openai');
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
            tool_calls: m.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.input),
              },
            })),
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
