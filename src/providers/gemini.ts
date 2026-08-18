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
  ToolDefinition,
  ToolCall,
} from '../types.js';
import { MODELS } from '../constants.js';
import { BaseProvider, ProviderUnreachableError } from './base.js';
import { withResolvedPricing } from '../core/router/pricing.js';
import { isChatModel } from './model-filter.js';
import { toGeminiParameters } from './gemini-schema.js';
import { stripVersionSuffix } from '../utils/net.js';

/**
 * The version segment the Gemini client owns.
 *
 * The SDK appends it to whatever `httpOptions.baseUrl` it is given, so a
 * configured endpoint is an API ROOT, not a versioned path — and discovery has
 * to append the same thing to reach the same service.
 */
const GEMINI_API_VERSION = 'v1beta';

/** Where Gemini sends when nothing is configured. */
const GEMINI_PUBLIC_ROOT = 'https://generativelanguage.googleapis.com';

/**
 * The API root for a configured Gemini endpoint.
 *
 * A trailing version segment is stripped rather than trusted: the SDK adds its
 * own, so a user who writes the URL the way it appears in Google's docs would
 * otherwise generate against `/v1beta/v1beta`.
 *
 * Delegates, exactly as `anthropicApiRoot()` does and for the same two
 * reasons. Credential-scope comparison in `config/` has to agree with this
 * about which spellings name one root — `CLIENT_OWNS_VERSION` lists Gemini
 * precisely because of the concatenation above — and a hand-rolled copy also
 * reintroduced the polynomial `replace(/\/+$/, '')` that
 * `stripTrailingSlashes()` exists to keep out of the codebase.
 */
export function geminiApiRoot(baseUrl?: string): string {
  const configured = baseUrl?.trim();
  return configured ? stripVersionSuffix(configured) || GEMINI_PUBLIC_ROOT : GEMINI_PUBLIC_ROOT;
}

/**
 * Tool definitions in the shape this provider actually submits.
 *
 * Exported so the router's budget preflight sizes what goes on the wire rather
 * than what the caller passed. That matters more here than anywhere else: the
 * sanitiser below strips exactly the metadata a large MCP schema is mostly made
 * of, so charging the raw JSON refuses budgets over bytes Gemini never sees.
 * One function, used by the request and the estimate alike.
 */
export function toGeminiTools(tools: readonly ToolDefinition[]): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Convert, never cast. Gemini's parameters field is an OpenAPI subset
    // that 400s on unknown keys, and MCP servers ship schemas carrying their
    // own extensions (GitHub's adds `x-mcp-header` to every header-bound
    // property). Casting sent those through verbatim and every request failed
    // before the model saw it. See providers/gemini-schema.ts.
    parameters: toGeminiParameters(tool.inputSchema) as FunctionDeclaration['parameters'],
  }));
}

/**
 * An assistant turn's tool calls in the shape this provider actually submits.
 *
 * Gemini's envelope carries no call id — the parts are matched to their
 * responses by function name — so this is the one provider where the history
 * costs LESS than Cascade's normalized form, and sizing that form refused
 * budgets over ids never sent.
 */
export function toGeminiFunctionCalls(toolCalls: readonly ToolCall[]): Part[] {
  return toolCalls.map((tc) => ({
    functionCall: {
      name: tc.name,
      args: tc.input as Record<string, unknown>,
    },
  } as Part));
}

/**
 * Statuses that are genuinely about the credential.
 *
 * 400 belongs here because it is what Google returns for "API key not valid" —
 * the request itself carries no body to be malformed, so a 400 on a bare model
 * list is the key. 429 and 5xx deliberately do not: the key can be perfect and
 * still meet a spent quota or a bad afternoon at Google.
 */
function isGeminiAuthStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/**
 * The API's own explanation, when it gives one.
 *
 * Google returns `{error:{message}}` with a genuinely useful string — "API key
 * not valid", "API has not been used in project X", "location is not
 * supported" — and each points at a different fix. Reporting only the status
 * code turns all of them into the same shrug.
 */
async function describeGeminiError(resp: Response): Promise<string> {
  try {
    const body = await resp.json() as { error?: { message?: string; status?: string } };
    const detail = body?.error?.message ?? body?.error?.status;
    return detail ? ` — ${detail}` : '';
  } catch {
    return '';
  }
}

export class GeminiProvider extends BaseProvider {
  private client: GoogleGenAI;

  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    // `baseUrl` was accepted by the config schema, preserved across edits and
    // compared by `credentialEndpointIdentity` — and then ignored here, so a
    // key configured for a proxy was sent to Google's public backend anyway.
    // A configured endpoint that silently does nothing is worse than one that
    // is refused: everything upstream reports the routing as honoured.
    this.client = new GoogleGenAI({
      apiKey: config.apiKey ?? '',
      ...(config.baseUrl ? { httpOptions: { baseUrl: geminiApiRoot(config.baseUrl) } } : {}),
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
          ? [{ functionDeclarations: toGeminiTools(options.tools) }]
          : undefined,
        abortSignal: options.signal,
      },
    });

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls: ToolCall[] = [];
    let finishReason: GenerateResult['finishReason'] = 'stop';

    for await (const chunk of stream) {
      // Walk candidate parts directly instead of the `chunk.text` convenience
      // getter. On a response that also carries functionCall/thinking parts,
      // `chunk.text` logs "non-text parts … returning concatenation of all text
      // parts" AND can come back empty — which stranded the classifier and the
      // T3 self-test with no content, surfacing as "Task failed". Reading parts
      // ourselves is warning-free and always yields the real answer text.
      const candidates = (chunk as any).candidates ?? [];
      for (const candidate of candidates) {
        for (const part of candidate?.content?.parts ?? []) {
          // A model's private "thinking" (gemini-2.5 thinking models) is not the
          // answer — never fold it into the streamed/aggregated content.
          if (part.thought) continue;
          if (typeof part.text === 'string' && part.text) {
            fullContent += part.text;
            onChunk({ text: part.text, finishReason: null });
          }
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
      : Object.values(MODELS).filter((m) => m.provider === 'gemini'));
    try {
      const resp = await this.fetchModelList();
      if (!resp.ok) {
        // Invalid key / network error — fall back to the built-in model list
        // instead of crashing downstream consumers with a shape mismatch.
        return staticCatalog();
      }
      const data = await resp.json() as {
        models?: Array<{
          name: string;
          displayName: string;
          inputTokenLimit: number;
          outputTokenLimit: number;
          supportedGenerationMethods?: string[];
        }>;
      };
      if (!Array.isArray(data?.models)) {
        return staticCatalog();
      }

      return data.models
        .filter((m) => isChatModel(m.name.replace('models/', ''), m.supportedGenerationMethods))
        .map((m) => {
        const id = m.name.replace('models/', '');
        const known = Object.values(MODELS).find(
          (km) => km.id === id && km.provider === 'gemini',
        );
        if (known) return known;

        // Price from the dataset. A model it doesn't cover (a fresh preview id,
        // say) comes back flagged `pricingUnknown` rather than $0 — the exact
        // path that made an unpriced Gemini preview model report as free.
        return withResolvedPricing({
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
        });
      });
    } catch {
      return staticCatalog();
    }
  }

  /**
   * Is this KEY usable — not "does one particular model answer".
   *
   * This used to call countTokens() against `this.model.id`, which the router
   * fills from the first Gemini entry in the bundled catalogue. That made the
   * whole provider's fate depend on one hard-coded model id: a key that cannot
   * reach that one model — retired, not enabled for the key's project, served
   * on a different API version — failed the probe, and because every later step
   * is gated on the result (`validateCloudProviderModels` and
   * `discoverProviderModels` both return early for an unavailable provider) the
   * real model list was never fetched. Gemini vanished entirely, and the CLI
   * reported "add a provider API key first" about a key that was present and
   * working.
   *
   * Listing models asks the account-level question instead, the same one
   * OpenAI's probe asks, and it is the same request `listModels()` already
   * makes for discovery.
   *
   * Throws rather than returning false. The router logs the reason it catches,
   * and "bad key, wrong endpoint/deployment, or unreachable" — three guesses,
   * no answer — is what made this take a user report to find. A swallowed probe
   * error is the same defect that once hid a misconfigured Azure deployment.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config.apiKey) throw new Error('no Gemini API key configured');

    let resp: Response;
    try {
      resp = await this.fetchModelList();
    } catch (err) {
      // Never reached the API — DNS, a proxy, a reset connection. That is not a
      // verdict on the key.
      throw new ProviderUnreachableError(
        `could not reach the Gemini API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (resp.ok) return true;

    const status = `HTTP ${resp.status} ${resp.statusText}`.trim();
    const detail = await describeGeminiError(resp);
    // Only an authentication or authorisation status is evidence about the key.
    // A 429 is a quota that will refill and a 5xx is Google's problem, and
    // calling either one "your key was rejected" sends the user to regenerate a
    // credential that was never the issue — the same class of misdirection this
    // whole change exists to remove, just with a more confident voice.
    if (isGeminiAuthStatus(resp.status)) {
      throw new Error(`Gemini rejected the API key: ${status}${detail}`);
    }
    throw new ProviderUnreachableError(`Gemini model list failed: ${status}${detail}`);
  }

  // ── Private ──────────────────────────────────

  /**
   * The account's model list. One place so the availability probe and
   * discovery cannot ask different questions of the same endpoint.
   *
   * The key goes in a header, not the query string: a URL carries into proxy
   * logs, error reports and shell history, and this one would carry the key
   * with it.
   */
  private fetchModelList(): Promise<Response> {
    // Built from the SAME root the SDK client was given. Hardcoding the public
    // host here meant discovery and generation asked different endpoints the
    // moment a proxy was configured: the proxy's restricted catalogue was
    // replaced by Google's public one, and routing then picked models the
    // proxy does not serve — with the key going to the wrong host on the way.
    return fetch(`${geminiApiRoot(this.config.baseUrl)}/${GEMINI_API_VERSION}/models`, {
      headers: { 'x-goog-api-key': this.config.apiKey ?? '' },
    });
  }

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
        parts.push(...toGeminiFunctionCalls(m.toolCalls ?? []));

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

}
