// ─────────────────────────────────────────────
//  Cascade AI — Google Gemini Provider
// ─────────────────────────────────────────────

import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  type Content,
  type FunctionDeclaration,
  type Part,
} from '@google/generative-ai';
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
  private client: GoogleGenerativeAI;

  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    this.client = new GoogleGenerativeAI(config.apiKey ?? '');
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const chunks: StreamChunk[] = [];
    return this.generateStream(options, (c) => chunks.push(c));
  }

  async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<GenerateResult> {
    const genModel = this.client.getGenerativeModel({
      model: this.model.id,
      systemInstruction: options.systemPrompt,
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
      tools: options.tools?.length
        ? [{ functionDeclarations: options.tools.map(this.convertTool) }]
        : undefined,
    });

    const history = this.buildHistory(options.messages.slice(0, -1));
    const chat = genModel.startChat({ history });

    const lastMsg = options.messages[options.messages.length - 1];
    const parts = this.convertMessageContent(lastMsg!, options.images);

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const result = await chat.sendMessageStream(parts);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullContent += text;
        onChunk({ text, finishReason: null });
      }
    }

    const finalResponse = await result.response;
    const usage = finalResponse.usageMetadata;
    if (usage) {
      inputTokens = usage.promptTokenCount ?? 0;
      outputTokens = usage.candidatesTokenCount ?? 0;
    }

    const toolCalls = finalResponse.functionCalls()?.map((fc) => ({
      id: `${fc.name}-${Date.now()}`,
      name: fc.name,
      input: fc.args as Record<string, unknown>,
    }));

    onChunk({ text: '', finishReason: 'stop' });

    return {
      content: fullContent,
      usage: this.makeUsage(inputTokens, outputTokens),
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      finishReason: toolCalls?.length ? 'tool_use' : 'stop',
    };
  }

  async countTokens(text: string): Promise<number> {
    const genModel = this.client.getGenerativeModel({ model: this.model.id });
    const result = await genModel.countTokens(text);
    return result.totalTokens;
  }

  async listModels(): Promise<ModelInfo[]> {
    return Object.values(MODELS).filter((m) => m.provider === 'gemini');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const genModel = this.client.getGenerativeModel({ model: this.model.id });
      await genModel.countTokens('ping');
      return true;
    } catch {
      return false;
    }
  }

  private buildHistory(messages: ConversationMessage[]): Content[] {
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: typeof m.content === 'string'
          ? [{ text: m.content }]
          : this.convertMessageContent(m),
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
