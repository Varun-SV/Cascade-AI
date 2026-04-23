// ─────────────────────────────────────────────
//  Cascade AI — Google Gemini Provider
// ─────────────────────────────────────────────

import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  type Content,
  type FunctionDeclaration,
  type Part,
} from '@google/genai';
import type {
  ConversationMessage,
  GenerateOptions,
  GenerateResult,
  ImageAttachment,
  ModelInfo,
  ProviderConfig,
  StreamChunk,
  ToolCall,
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
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls: ToolCall[] = [];
    let finishReason: GenerateResult['finishReason'] = 'stop';

    for await (const chunk of stream) {
      // ── Text content ──────────────────────────
      const text = chunk.text ?? '';
      if (text) {
        fullContent += text;
        onChunk({ text, finishReason: null });
      }

      // ── Tool / function calls ─────────────────
      const candidates = (chunk as any).candidates ?? [];
      for (const candidate of candidates) {
        for (const part of candidate?.content?.parts ?? []) {
          if (part.functionCall) {
              // Use function name as ID — Gemini matches functionResponse by name, not timestamp
              toolCalls.push({
                id: part.functionCall.name as string,
                name: part.functionCall.name as string,
                input: (part.functionCall.args ?? {}) as Record<string, unknown>,
              });
              finishReason = 'tool_use';
          }
        }
        // Capture finish reason from candidate
        if (candidate.finishReason) {
          const fr = (candidate.finishReason as string).toLowerCase();
          if (fr === 'stop') finishReason = toolCalls.length ? 'tool_use' : 'stop';
          else if (fr === 'max_tokens' || fr === 'length') finishReason = 'length';
        }
      }

      // ── Token usage ───────────────────────────
      const usage = (chunk as any).usageMetadata;
      if (usage) {
        inputTokens = usage.promptTokenCount ?? inputTokens;
        outputTokens = usage.candidatesTokenCount ?? outputTokens;
      }
    }

    onChunk({ text: '', finishReason });

    return {
      content: fullContent,
      usage: this.makeUsage(inputTokens, outputTokens), // ✅ real tokens now
      toolCalls: toolCalls.length ? toolCalls : undefined, // ✅ tool calls now returned
      finishReason,
    };
  }

  async countTokens(text: string): Promise<number> {
    try {
      const result = await this.client.models.countTokens({
        model: this.model.id,
        contents: [{ role: 'user', parts: [{ text }] }],
      });
      return result.totalTokens ?? 0;
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`,
      );
      if (!resp.ok) {
        // Invalid key / network error — fall back to the built-in model list
        // instead of crashing downstream consumers with a shape mismatch.
        return Object.values(MODELS).filter((m) => m.provider === 'gemini');
      }
      const data = await resp.json() as {
        models?: Array<{
          name: string;
          displayName: string;
          inputTokenLimit: number;
          outputTokenLimit: number;
        }>;
      };
      if (!Array.isArray(data?.models)) {
        return Object.values(MODELS).filter((m) => m.provider === 'gemini');
      }

      return data.models.map((m) => {
        const id = m.name.replace('models/', '');
        const known = Object.values(MODELS).find(
          (km) => km.id === id && km.provider === 'gemini',
        );
        if (known) return known;

        return {
          id,
          name: m.displayName || id,
          provider: 'gemini' as const,
          contextWindow: m.inputTokenLimit || 128_000,
          isVisionCapable:
            id.includes('vision') || id.includes('pro') || id.includes('flash'),
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
      await this.client.models.countTokens({
        model: this.model.id,
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Private ──────────────────────────────────

  private buildContents(
    messages: ConversationMessage[],
    extraImages?: ImageAttachment[],
  ): Content[] {
    const contents: Content[] = [];

    for (const m of messages) {
      // ── System messages in history: prepend to the next user turn ──────
      // Gemini only accepts systemInstruction at the top level; mid-conversation
      // system messages are folded into the following user turn as context.
      if (m.role === 'system') {
        const text = typeof m.content === 'string' ? m.content : '';
        if (!text.trim()) continue;
        // Merge into previous user turn or create a new one
        const prev = contents[contents.length - 1];
        if (prev?.role === 'user') {
          (prev.parts as Part[]).unshift({ text: `[System context]: ${text}\n\n` });
        } else {
          contents.push({ role: 'user', parts: [{ text: `[System context]: ${text}` }] });
        }
        continue;
      }

      // ── Tool result messages → Gemini functionResponse in a user turn ──
      if (m.role === 'tool') {
        const toolContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        // toolCallId carries the function name for Gemini (set by gemini provider using tool name)
        const functionName = m.toolCallId ?? 'unknown_function';
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: functionName,
              response: { output: toolContent },
            },
          }] as Part[],
        });
        continue;
      }

      // ── Assistant messages: may include functionCall parts ─────────────
      if (m.role === 'assistant') {
        const parts: Part[] = [];

        // Text content
        const textContent = typeof m.content === 'string' ? m.content : '';
        if (textContent) parts.push({ text: textContent });

        // Tool calls → functionCall parts
        for (const tc of m.toolCalls ?? []) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.input as Record<string, unknown>,
            },
          } as Part);
        }

        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
        continue;
      }

      // ── User messages ─────────────────────────────────────────────────
      if (m.role === 'user') {
        const parts = this.convertMessageContent(m, contents.length === 0 ? extraImages : undefined);
        // Attach extra images only to the LAST user message
        if (extraImages?.length && contents.length > 0) {
          const isLastUser = !messages.slice(messages.indexOf(m) + 1).some(x => x.role === 'user');
          if (isLastUser) {
            for (const img of extraImages) {
              if (img.type === 'base64') {
                parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
              }
            }
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'user', parts });
        }
      }
    }

    return contents;
  }

  private convertMessageContent(
    msg: ConversationMessage,
    extraImages?: ImageAttachment[],
  ): Part[] {
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

  private convertTool(tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }): FunctionDeclaration {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as FunctionDeclaration['parameters'],
    };
  }
}
