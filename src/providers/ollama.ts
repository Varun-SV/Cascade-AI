// ─────────────────────────────────────────────
//  Cascade AI — Ollama Local Provider
// ─────────────────────────────────────────────

import axios from 'axios';
import type {
  ConversationMessage,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  ProviderConfig,
  StreamChunk,
} from '../types.js';
import { OLLAMA_BASE_URL } from '../constants.js';
import { BaseProvider } from './base.js';

interface OllamaMessage { role: string; content: string; images?: string[] }
interface OllamaChatChunk { message?: { content: string }; done: boolean; prompt_eval_count?: number; eval_count?: number }
interface OllamaModelEntry { name: string; details?: { parameter_size?: string } }

export class OllamaProvider extends BaseProvider {
  private baseUrl: string;

  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    this.baseUrl = config.baseUrl ?? OLLAMA_BASE_URL;
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

    const response = await axios.post<any>(
      `${this.baseUrl}/api/chat`,
      {
        model: this.model.id,
        messages,
        stream: true,
        options: {
          num_predict: options.maxTokens ?? this.model.maxOutputTokens,
          temperature: options.temperature ?? 0.7,
        },
      },
      { responseType: 'stream' },
    );

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      response.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as OllamaChatChunk;
            if (parsed.message?.content) {
              fullContent += parsed.message.content;
              onChunk({ text: parsed.message.content, finishReason: null });
            }
            if (parsed.done) {
              inputTokens = parsed.prompt_eval_count ?? 0;
              outputTokens = parsed.eval_count ?? 0;
            }
          } catch { /* ignore parse errors */ }
        }
      });
      response.data.on('end', () => {
        // Flush any trailing JSON line that was not newline-terminated.
        // Ollama usually ends each NDJSON line with "\n", but if the server
        // disconnects on the last message the final response would otherwise
        // be lost and the task would report `done: false`.
        const tail = buffer.trim();
        if (tail) {
          try {
            const parsed = JSON.parse(tail) as OllamaChatChunk;
            if (parsed.message?.content) {
              fullContent += parsed.message.content;
              onChunk({ text: parsed.message.content, finishReason: null });
            }
            if (parsed.done) {
              inputTokens = parsed.prompt_eval_count ?? inputTokens;
              outputTokens = parsed.eval_count ?? outputTokens;
            }
          } catch { /* ignore malformed tail */ }
        }
        resolve();
      });
      response.data.on('error', reject);
    });

    onChunk({ text: '', finishReason: 'stop' });

    return {
      content: fullContent,
      usage: this.makeUsage(inputTokens, outputTokens),
      finishReason: 'stop',
    };
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await axios.get<{ models: OllamaModelEntry[] }>(`${this.baseUrl}/api/tags`);
      const supportedKeywords = ['llama3', 'llama2', 'gemma', 'mistral', 'mixtral', 'qwen', 'phi3', 'codellama', 'deepseek', 'llava', 'starcoder', 'stable-code', 'nomic-embed'];
      return response.data.models
        .filter((m) => {
          const name = m.name.toLowerCase();
          return supportedKeywords.some((k) => name.includes(k));
        })
        .map((m) => ({
          id: m.name,
          name: m.name,
          provider: 'ollama' as const,
          contextWindow: 128_000,
          isVisionCapable: m.name.includes('llava') || m.name.includes('vision'),
          inputCostPer1kTokens: 0,
          outputCostPer1kTokens: 0,
          maxOutputTokens: 4_000,
          supportsStreaming: true,
          isLocal: true,
          supportsToolUse: false,
          minSizeB: this.parseSizeB(m.details?.parameter_size),
        }));
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/api/tags`, { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  private convertMessages(messages: ConversationMessage[], systemPrompt?: string): OllamaMessage[] {
    const result: OllamaMessage[] = [];
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
    for (const m of messages) {
      if (m.role === 'system') {
        result.push({ role: 'system', content: typeof m.content === 'string' ? m.content : '' });
        continue;
      }
      if (typeof m.content === 'string') {
        result.push({ role: m.role, content: m.content });
        continue;
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.type === 'text' ? b.text : '').join('');
      const images = m.content.filter((b) => b.type === 'image').map((b) => {
        if (b.type === 'image') return b.image.data;
        return '';
      }).filter(Boolean);
      result.push({ role: m.role, content: text, images: images.length ? images : undefined });
    }
    return result;
  }

  private parseSizeB(size?: string): number | undefined {
    if (!size) return undefined;
    const match = /(\d+(?:\.\d+)?)\s*([BbMmKkGg]?)/.exec(size);
    if (!match) return undefined;
    const num = parseFloat(match[1]!);
    const unit = (match[2] ?? '').toUpperCase();
    if (unit === 'B') return num;
    if (unit === 'M') return num / 1000;
    return undefined;
  }
}
