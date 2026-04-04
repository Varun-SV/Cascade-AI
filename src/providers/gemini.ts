// ─────────────────────────────────────────────
//  Cascade AI — Google Gemini Provider
// ─────────────────────────────────────────────

import { GoogleGenAI, HarmBlockThreshold, HarmCategory, type Content, type FunctionDeclaration, type Part } from '@google/genai';
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

export class GeminiProvider extends BaseProvider {
  private client: GoogleGenAI;

  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    this.client = new GoogleGenAI({ apiKey: config.apiKey ?? '' });
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const chunks: StreamChunk[] = [];
    return this.generateStream(options, (c) => chunks.push(c));
  }

  async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<GenerateResult> {
    const contents = this.buildContents(options.messages, options.images);
    const stream = await this.client.models.generateContentStream({
      model: this.model.id,
      contents,
      config: {
        systemInstruction: options.systemPrompt,
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
        tools: options.tools?.length
          ? [{ functionDeclarations: options.tools.map(this.convertTool) }]
          : undefined,
      },
    });

    let fullContent = '';
    for await (const chunk of stream) {
      // The current version of @google/genai might yield objects with .text directly instead of a method
      const text = typeof chunk.text === 'function' ? chunk.text() : chunk.text;
      if (text) {
        fullContent += text;
        onChunk({ text, finishReason: null });
      }
    }

    onChunk({ text: '', finishReason: 'stop' });
    return {
      content: fullContent,
      usage: this.makeUsage(0, 0),
      finishReason: 'stop',
    };
  }

  async countTokens(text: string): Promise<number> {
    try {
      const result = await this.client.models.countTokens({ model: this.model.id, contents: [{ role: 'user', parts: [{ text }] }] });
      return result.totalTokens ?? 0;
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`);
      const data = await resp.json() as { models: Array<{ name: string; displayName: string; inputTokenLimit: number; outputTokenLimit: number }> };
      
      return data.models.map((m) => {
        const id = m.name.replace('models/', '');
        const known = Object.values(MODELS).find((km) => km.id === id && km.provider === 'gemini');
        if (known) return known;

        return {
          id,
          name: m.displayName || id,
          provider: 'gemini' as const,
          contextWindow: m.inputTokenLimit || 128_000,
          isVisionCapable: id.includes('vision') || id.includes('pro') || id.includes('flash'),
          inputCostPer1kTokens: 0,
          outputCostPer1kTokens: 0,
          maxOutputTokens: m.outputTokenLimit || 8_000,
          supportsStreaming: true,
          isLocal: false,
        };
      });
    } catch {
      return Object.values(MODELS).filter((m) => m.provider === 'gemini');
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.countTokens({ model: this.model.id, contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });
      return true;
    } catch {
      return false;
    }
  }

  private buildContents(messages: ConversationMessage[], extraImages?: ImageAttachment[]): Content[] {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: typeof m.content === 'string'
          ? [{ text: m.content }]
          : this.convertMessageContent(m, extraImages),
      }));
  }

  private convertMessageContent(msg: ConversationMessage, extraImages?: ImageAttachment[]): Part[] {
    const parts: Part[] = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') parts.push({ text: block.text });
        if (block.type === 'image') {
          const img = block.image as ImageAttachment;
          if (img.type === 'base64') {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
          }
        }
      }
    }

    for (const img of extraImages ?? []) {
      if (img.type === 'base64') {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
    }

    return parts;
  }

  private convertTool(tool: { name: string; description: string; inputSchema: Record<string, unknown> }): FunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as FunctionDeclaration['parameters'],
    };
  }
}
