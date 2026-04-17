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
    // Anthropic token counting is often simplified to 4 chars per token if the SDK doesn't support it directly
    return Math.ceil(text.length / 4);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': this.config.apiKey ?? '',
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

      return data.data.map((m) => {
        const known = Object.values(MODELS).find((km) => km.id === m.id && km.provider === 'anthropic');
        if (known) return known;

        return {
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
        };
      });
    } catch {
      return Object.values(MODELS).filter((m) => m.provider === 'anthropic');
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Basic check for API key presence
      return !!this.config.apiKey;
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
        const content: any[] = m.content.map((block) => {
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
              source: { type: 'url' as const, url: img.data } as any,
            };
          }
          return { type: 'text' as const, text: '' };
        });
        return { role: m.role as 'user' | 'assistant', content };
      });
  }
}
