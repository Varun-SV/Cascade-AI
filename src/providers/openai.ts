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

    const stream = await this.client.chat.completions.create({
      model: this.model.id,
      messages,
      max_tokens: options.maxTokens ?? this.model.maxOutputTokens,
      temperature: options.temperature ?? 0.7,
      tools: tools?.length ? tools : undefined,
      stream: true,
      stream_options: { include_usage: true },
    });

    const toolCallsMap: Record<number, { id: string; name: string; args: string }> = {};

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
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

    const toolCalls = Object.values(toolCallsMap).map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: JSON.parse(tc.args || '{}') as Record<string, unknown>,
    }));

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
    return Object.values(MODELS).filter((m) => m.provider === 'openai');
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
      if (typeof m.content === 'string') {
        result.push({ role: m.role as 'user' | 'assistant', content: m.content });
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

      result.push({ role: m.role as 'user' | 'assistant', content: parts });
    }

    return result;
  }
}
