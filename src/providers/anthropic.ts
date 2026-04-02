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
} from '../types.js';
import { MODELS } from '../constants.js';
import { BaseProvider } from './base.js';

export class AnthropicProvider extends BaseProvider {
  private client: Anthropic;

  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    this.client = new Anthropic({
      apiKey: config.apiKey,
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
    const messages = this.convertMessages(options.messages);
    const tools = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = this.client.messages.stream({
      model: this.model.id,
      max_tokens: options.maxTokens ?? this.model.maxOutputTokens,
      temperature: options.temperature ?? 0.7,
      system: options.systemPrompt,
      messages,
      tools: tools?.length ? tools : undefined,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const text = event.delta.text;
        fullContent += text;
        onChunk({ text, finishReason: null });
      } else if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens;
      } else if (event.type === 'message_start' && event.message.usage) {
        inputTokens = event.message.usage.input_tokens;
      }
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
    const result = await this.client.messages.countTokens({
      model: this.model.id,
      messages: [{ role: 'user', content: text }],
    });
    return result.input_tokens;
  }

  async listModels(): Promise<ModelInfo[]> {
    return Object.values(MODELS).filter((m) => m.provider === 'anthropic');
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list({ limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  private convertMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (typeof m.content === 'string') {
          return { role: m.role as 'user' | 'assistant', content: m.content };
        }
        const content: Anthropic.ContentBlockParam[] = m.content.map((block) => {
          if (block.type === 'text') return { type: 'text' as const, text: block.text };
          if (block.type === 'image') {
            const img = block.image as ImageAttachment;
            if (img.type === 'base64') {
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: img.mimeType,
                  data: img.data,
                },
              };
            }
            return {
              type: 'image' as const,
              source: { type: 'url' as const, url: img.data },
            };
          }
          return { type: 'text' as const, text: '' };
        });
        return { role: m.role as 'user' | 'assistant', content };
      });
  }
}
