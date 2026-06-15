// ─────────────────────────────────────────────
//  Cascade AI — Ollama Local Provider
// ─────────────────────────────────────────────

import type {
  ConversationMessage,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  ProviderConfig,
  StreamChunk,
  ToolCall,
} from '../types.js';
import { OLLAMA_BASE_URL } from '../constants.js';
import { BaseProvider } from './base.js';

// ── Ollama API types ───────────────────────────

interface OllamaToolCall {
  function: {
    name: string;
    // Ollama delivers arguments as an already-parsed object, not a JSON string.
    // Some older Ollama releases may deliver a JSON string — handled defensively below.
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaConversationMessage {
  role: string;
  content: string;
  images?: string[];
  // Present in assistant messages that contain native tool calls
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatChunk {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaModelEntry { name: string; details?: { parameter_size?: string } }

// ── Model family detection ─────────────────────

const TOOL_CAPABLE_FAMILIES = [
  'llama3.1', 'llama3.2', 'llama3.3',
  'qwen2', 'qwen2.5', 'qwen3',
  'mistral-nemo', 'mistral-small',
  'command-r',
  'firefunction',
];

function isToolCapable(modelName: string): boolean {
  const name = modelName.toLowerCase();
  return TOOL_CAPABLE_FAMILIES.some((family) => name.includes(family));
}

// ── Provider ───────────────────────────────────

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

    // Convert tools to Ollama/OpenAI-compatible format when provided
    const ollamaTools = options.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model.id,
        messages,
        stream: true,
        tools: ollamaTools?.length ? ollamaTools : undefined,
        options: {
          num_predict: options.maxTokens ?? this.model.maxOutputTokens,
          temperature: options.temperature ?? 0.7,
        },
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Ollama chat request failed: ${response.status} ${response.statusText}`);
    }

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const pendingToolCalls: OllamaToolCall[] = [];

    // Parse one NDJSON line of the streaming response.
    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as OllamaChatChunk;
        if (parsed.message?.content) {
          fullContent += parsed.message.content;
          onChunk({ text: parsed.message.content, finishReason: null });
        }
        if (parsed.message?.tool_calls?.length) {
          pendingToolCalls.push(...parsed.message.tool_calls);
        }
        if (parsed.done) {
          inputTokens = parsed.prompt_eval_count ?? inputTokens;
          outputTokens = parsed.eval_count ?? outputTokens;
        }
      } catch { /* ignore parse errors */ }
    };

    // Node's fetch body is an async-iterable stream of byte chunks.
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    // Flush any trailing JSON line that was not newline-terminated (e.g. the
    // server disconnects on the last message) so `done` isn't lost.
    handleLine(buffer);

    // Convert Ollama tool calls to the normalised ToolCall format.
    // Ollama delivers arguments as an already-parsed object; some older versions
    // may deliver a JSON string — handle both defensively.
    const toolCalls: ToolCall[] = pendingToolCalls.map((tc, i) => {
      let input: Record<string, unknown>;
      if (typeof tc.function.arguments === 'string') {
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          input = { __rawArguments: tc.function.arguments };
        }
      } else {
        input = tc.function.arguments as Record<string, unknown>;
      }
      return {
        id: `ollama-tool-${Date.now()}-${i}`,
        name: tc.function.name,
        input,
      };
    });

    const finishReason = toolCalls.length ? 'tool_use' : 'stop';
    onChunk({ text: '', finishReason });

    return {
      content: fullContent,
      usage: this.makeUsage(inputTokens, outputTokens),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
    };
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];
      const data = await response.json() as { models: OllamaModelEntry[] };
      const supportedKeywords = ['llama3', 'llama2', 'gemma', 'mistral', 'mixtral', 'qwen', 'phi3', 'codellama', 'deepseek', 'llava', 'starcoder', 'stable-code', 'nomic-embed'];
      return data.models
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
          supportsToolUse: isToolCapable(m.name),
          minSizeB: this.parseSizeB(m.details?.parameter_size),
        }));
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: ac.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private convertMessages(messages: ConversationMessage[], systemPrompt?: string): OllamaConversationMessage[] {
    const result: OllamaConversationMessage[] = [];
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
    for (const m of messages) {
      if (m.role === 'system') {
        result.push({ role: 'system', content: typeof m.content === 'string' ? m.content : '' });
        continue;
      }

      // Tool result messages — role: 'tool' is supported by modern Ollama
      if (m.role === 'tool') {
        result.push({
          role: 'tool',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
        continue;
      }

      // Assistant messages that carried native tool calls
      if (m.role === 'assistant' && m.toolCalls?.length) {
        result.push({
          role: 'assistant',
          content: typeof m.content === 'string' ? m.content : '',
          tool_calls: m.toolCalls.map((tc) => ({
            function: {
              name: tc.name,
              arguments: tc.input,
            },
          })),
        });
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
