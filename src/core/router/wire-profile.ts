import type { ConversationMessage, ProviderType } from '../../types.js';
import { toGeminiParameters } from '../../providers/gemini-schema.js';

/**
 * What each provider actually PUTS ON THE WIRE.
 *
 * The budget preflight has to size a request before it is sent, which means it
 * has to know what the provider will send. That is NOT the same as what the
 * caller passed: every provider's `convertMessages` / `buildContents` drops,
 * rewrites or duplicates parts of a `GenerateOptions`, and each does it
 * differently. Counting bytes a provider discards refuses runs that would have
 * completed — the exact failure this feature exists to avoid — and skipping
 * bytes it does send leaves the cap unenforced.
 *
 * Those rules used to live as one-off `model.provider === '...'` conditionals
 * scattered through the estimator, added one at a time as each mismatch was
 * found. That is how they drifted: nothing tied a conditional to the provider
 * code it was modelling, so a change on one side never showed up on the other.
 * They are collected here instead — one table, derived by reading each
 * provider's serializer end to end, so the whole set can be re-audited against
 * the providers in one pass rather than rediscovered a case at a time.
 *
 * ── ARRAY (block) content, by role ────────────────────────────────────────
 *
 *   provider            system            tool          assistant       user
 *   ─────────────────────────────────────────────────────────────────────────
 *   anthropic           message dropped   stringified   dropped         blocks
 *   gemini              message dropped   stringified   dropped         blocks
 *   openai / azure /
 *     openai-compatible dropped           dropped       blocks          blocks
 *   ollama              dropped           stringified   see below       blocks
 *
 *   "message dropped"  the message never reaches the request at all
 *   "dropped"          content is reduced to '' — text blocks AND images lost
 *   "stringified"      the array is JSON.stringify()d whole, base64 included
 *   "blocks"           text blocks sent as text, images per `sendsUrlImages`
 *
 *   Ollama assistant: 'dropped' when the turn carries tool calls (that branch
 *   returns early with `typeof content === 'string' ? content : ''`), 'blocks'
 *   otherwise.
 *
 * ── Everything else ───────────────────────────────────────────────────────
 *
 *   sendsUrlImages       false for Gemini alone — buildContents() emits
 *                        inlineData only for `type: 'base64'`, so a URL
 *                        attachment is silently discarded.
 *   readsTopLevelImages  true for Gemini alone — every other provider builds
 *                        its request from `messages` and never looks at
 *                        `options.images`.
 *   sendsToolCalls       assistant turns only, everywhere. OpenAI additionally
 *                        requires STRING content: its array branch pushes the
 *                        parts and never attaches `tool_calls`.
 *   sizeTools            Gemini rewrites every input schema through
 *                        toGeminiParameters (stripping $defs, $schema,
 *                        additionalProperties and MCP vendor extensions);
 *                        the rest send the schema verbatim.
 *
 * When a provider's serializer changes, change the row here and the estimator
 * follows. `wire-profile.test.ts` asserts the rows against the real providers.
 */

/** How a provider serializes one message's array content. */
export type BlockHandling = 'blocks' | 'dropped' | 'stringified';

export interface WireToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface WireProfile {
  /**
   * The message is not submitted at all — no framing, no content, no tool
   * calls. Distinct from `blockHandling: 'dropped'`, where an empty message
   * still occupies a turn.
   */
  dropsMessage(message: ConversationMessage): boolean;
  /** How this message's array content is serialized, if it has any. */
  blockHandling(message: ConversationMessage): BlockHandling;
  /** Whether this message's `toolCalls` are serialized into the request. */
  sendsToolCalls(message: ConversationMessage): boolean;
  /** Whether a `type: 'url'` image attachment is submitted (base64 always is). */
  readonly sendsUrlImages: boolean;
  /** Whether the top-level `options.images` field is read at all. */
  readonly readsTopLevelImages: boolean;
  /** Tool definitions shaped as this provider will actually serialize them. */
  sizeTools(tools: readonly WireToolDefinition[]): unknown;
}

const identityTools = (tools: readonly WireToolDefinition[]): unknown => tools;

const ANTHROPIC: WireProfile = {
  // convertMessages: `if (m.role === 'system') continue` — history system
  // messages are skipped outright; only options.systemPrompt goes as system
  // input. Compaction emits exactly such a message, holding a summary of the
  // whole conversation, so charging it refused runs over input never sent.
  dropsMessage: (m) => m.role === 'system',
  blockHandling: (m) => {
    if (m.role === 'tool') return 'stringified';
    // The assistant branch reads `typeof m.content === 'string' ? m.content : ''`
    // and builds tool_use blocks — array content never reaches the request.
    if (m.role === 'assistant') return 'dropped';
    return 'blocks';
  },
  sendsToolCalls: (m) => m.role === 'assistant',
  sendsUrlImages: true,
  readsTopLevelImages: false,
  sizeTools: identityTools,
};

const GEMINI: WireProfile = {
  // buildContents folds a system message into the next user turn, but only
  // when it has text: array content collapses to '' and the message is
  // skipped, as is a whitespace-only string.
  dropsMessage: (m) => m.role === 'system' && !(typeof m.content === 'string' ? m.content : '').trim(),
  blockHandling: (m) => {
    if (m.role === 'tool') return 'stringified';
    if (m.role === 'assistant' || m.role === 'system') return 'dropped';
    return 'blocks';
  },
  sendsToolCalls: (m) => m.role === 'assistant',
  sendsUrlImages: false,
  readsTopLevelImages: true,
  sizeTools: (tools) => tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiParameters(t.inputSchema),
  })),
};

const OPENAI: WireProfile = {
  dropsMessage: () => false,
  blockHandling: (m) => {
    // Both branches read `typeof m.content === 'string' ? m.content : ''` —
    // the message is still sent, with nothing in it.
    if (m.role === 'system' || m.role === 'tool') return 'dropped';
    return 'blocks';
  },
  // The tool_calls branch is inside `if (typeof m.content === 'string')`; an
  // assistant turn with array content falls through to the parts branch and
  // its tool calls are never attached.
  sendsToolCalls: (m) => m.role === 'assistant' && typeof m.content === 'string',
  sendsUrlImages: true,
  readsTopLevelImages: false,
  sizeTools: identityTools,
};

const OLLAMA: WireProfile = {
  dropsMessage: () => false,
  blockHandling: (m) => {
    if (m.role === 'system') return 'dropped';
    if (m.role === 'tool') return 'stringified';
    // The tool-call branch returns early with string-only content; without
    // tool calls the turn falls through to the text+images split.
    if (m.role === 'assistant' && m.toolCalls?.length) return 'dropped';
    return 'blocks';
  },
  sendsToolCalls: (m) => m.role === 'assistant',
  // The image split maps `b.image.data` with no check on `type`, so a URL is
  // submitted too (as a URL string in the `images` array).
  sendsUrlImages: true,
  readsTopLevelImages: false,
  sizeTools: identityTools,
};

const PROFILES: Record<ProviderType, WireProfile> = {
  anthropic: ANTHROPIC,
  gemini: GEMINI,
  openai: OPENAI,
  // AzureOpenAIProvider and OpenAICompatibleProvider both extend OpenAIProvider
  // and neither overrides convertMessages.
  azure: OPENAI,
  'openai-compatible': OPENAI,
  ollama: OLLAMA,
};

/**
 * The serialization rules for a provider. Unknown providers fall back to the
 * OpenAI shape, which is the common one and the least surprising default: it
 * drops the least, so an unknown provider is sized generously rather than
 * having content silently omitted from its estimate.
 */
export function wireProfile(provider: ProviderType): WireProfile {
  return PROFILES[provider] ?? OPENAI;
}

/**
 * How many times Gemini will submit each top-level image: once, or twice.
 *
 * buildContents() passes `extraImages` to a user turn when `contents` is still
 * EMPTY, and attaches them again to the last user turn once it is not — so two
 * copies are sent only when the first content entry is itself a user turn and
 * a later user turn follows it. Counting user roles alone got this wrong: a
 * history opening with a system, assistant or tool message already fills
 * `contents`, so those images are attached once, and charging for two refuses
 * requests over a copy that is never submitted.
 *
 * Mirrors the provider's own conditions rather than guessing at them, which
 * means tracking which messages actually produce a content entry: a system
 * message with text, a tool result, or an assistant turn with text or tool
 * calls. An empty system or assistant message produces nothing and is skipped
 * there too.
 */
export function geminiImageCopies(messages: readonly ConversationMessage[]): number {
  for (const m of messages) {
    if (m.role === 'user') {
      const laterUserTurn = messages.slice(messages.indexOf(m) + 1).some((x) => x.role === 'user');
      return laterUserTurn ? 2 : 1;
    }
    const text = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system' && text.trim()) return 1;       // fills contents first
    if (m.role === 'tool') return 1;                        // always pushes
    if (m.role === 'assistant' && (text || m.toolCalls?.length)) return 1;
  }
  return 1;
}
