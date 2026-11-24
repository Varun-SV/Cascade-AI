// ─────────────────────────────────────────────
//  Cascade AI — A run's thinking level, in each provider's terms
// ─────────────────────────────────────────────
//
//  One setting per run (ThinkingLevel: auto, off, low, medium, high). Every
//  provider takes it differently, and several models reject the settings their
//  neighbours need, so each mapping below sends only what that model accepts:
//
//  - Anthropic: adaptive thinking and `output_config.effort` on current models,
//    a token budget on older ones. Several current models can't turn thinking
//    off; there, 'off' is the lowest effort. Sampling settings (temperature)
//    are rejected by most current models and are sent only where accepted.
//  - OpenAI: `reasoning_effort` (Chat Completions) or `reasoning.effort`
//    (Responses), for reasoning models only.
//  - Gemini: `thinkingConfig`: a level on Gemini 3, a token budget on 2.5.
//  - Azure deployments, Ollama and OpenAI-compatible endpoints: nothing is sent.
//
//  'auto' sends what Cascade has always sent, minus what the model rejects.

import { THINKING_LEVELS, type ThinkingLevel } from '../types.js';

/** A thinking level from untrusted input (a socket payload); anything else, or 'auto', is undefined. */
export function thinkingLevelFrom(value: unknown): Exclude<ThinkingLevel, 'auto'> | undefined {
  return typeof value === 'string' && value !== 'auto' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? value as Exclude<ThinkingLevel, 'auto'>
    : undefined;
}

type Effort = 'low' | 'medium' | 'high';
const LEVEL_EFFORT: Record<'low' | 'medium' | 'high', Effort> = { low: 'low', medium: 'medium', high: 'high' };

// ── Anthropic ──────────────────────────────────────────────────────────────

interface ClaudeId { family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos'; version: number }

/** `claude-opus-4-8`, `claude-sonnet-4-5-20250929`, `us.anthropic.claude-haiku-5-5` → family and version. */
export function parseClaudeId(id: string): ClaudeId | null {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?![\d])/i.exec(id || '');
  if (!m) return null;
  const minor = m[3] ? Number(m[3]) : 0;
  return { family: m[1]!.toLowerCase() as ClaudeId['family'], version: Number(m[2]) + minor / 10 };
}

/**
 * How a Claude model takes thinking:
 *
 * - `always`: thinking can't be turned off; effort is the only control, no
 *   sampling settings (Fable, Mythos, Opus 5.5).
 * - `adaptive-off-disabled`: adaptive by default; `disabled` turns it off; no
 *   sampling settings (Opus 5, Sonnet 5, Haiku 5.5).
 * - `adaptive-off-between-tools`: adaptive by default; off is `between_tools`;
 *   no sampling settings (Sonnet 5.5).
 * - `adaptive-opt-in`: thinks only when asked (adaptive); no sampling settings
 *   (Opus 4.7, 4.8).
 * - `adaptive-sampling`: thinks only when asked (adaptive); temperature allowed
 *   when it doesn't think (Opus 4.6, Sonnet 4.6).
 * - `budget`: a token budget; temperature allowed when it doesn't think
 *   (Opus and Sonnet 4.0 to 4.5, Haiku 4.5).
 * - `none`: no thinking (anything older).
 */
export type ClaudeThinkingKind = 'always' | 'adaptive-off-disabled' | 'adaptive-off-between-tools' | 'adaptive-opt-in' | 'adaptive-sampling' | 'budget' | 'none';

export function claudeThinkingKind(modelId: string): ClaudeThinkingKind {
  const c = parseClaudeId(modelId);
  if (!c) return 'none';
  const { family, version: v } = c;
  // A model newer than this table is assumed to work like the newest it knows.
  if (family === 'fable' || family === 'mythos' || v >= 6) return 'always';
  if (family === 'opus') {
    if (v >= 5.5) return 'always';
    if (v >= 5) return 'adaptive-off-disabled';
    if (v >= 4.7) return 'adaptive-opt-in';
    if (v >= 4.6) return 'adaptive-sampling';
    return v >= 4 ? 'budget' : 'none';
  }
  if (family === 'sonnet') {
    if (v >= 5.5) return 'adaptive-off-between-tools';
    if (v >= 5) return 'adaptive-off-disabled';
    if (v >= 4.6) return 'adaptive-sampling';
    return v >= 4 ? 'budget' : 'none';
  }
  // haiku
  if (v >= 5) return 'adaptive-off-disabled';
  return v >= 4.5 ? 'budget' : 'none';
}

export interface AnthropicThinkingParams {
  thinking?:
    | { type: 'adaptive'; display?: 'summarized' }
    | { type: 'disabled' }
    | { type: 'between_tools' }
    | { type: 'enabled'; budget_tokens: number };
  output_config?: { effort: Effort };
  temperature?: number;
}

const BUDGET: Record<'low' | 'medium' | 'high', number> = { low: 2048, medium: 8000, high: 16000 };

/**
 * The thinking, effort and temperature fields of one Anthropic request.
 * `temperature` is the caller's (or the 0.7 default); it is sent only where the
 * model accepts it, which on current models is nowhere.
 */
export function anthropicThinkingParams(modelId: string, level: ThinkingLevel | undefined, maxTokens: number, temperature: number | undefined): AnthropicThinkingParams {
  const lvl = level ?? 'auto';
  const kind = claudeThinkingKind(modelId);
  const temp = temperature ?? 0.7;
  // Summaries, so a run's thinking can be shown; it's billed the same either way.
  const adaptive = { thinking: { type: 'adaptive' as const, display: 'summarized' as const } };
  const effort = lvl === 'low' || lvl === 'medium' || lvl === 'high' ? { output_config: { effort: LEVEL_EFFORT[lvl] } } : {};

  switch (kind) {
    case 'always':
      // Can't be turned off: 'off' is the least thinking it does.
      return { ...adaptive, ...(lvl === 'off' ? { output_config: { effort: 'low' } } : effort) };
    case 'adaptive-off-disabled':
      return lvl === 'off' ? { thinking: { type: 'disabled' } } : { ...adaptive, ...effort };
    case 'adaptive-off-between-tools':
      // between_tools takes no other field, and no effort above high (none is sent).
      return lvl === 'off' ? { thinking: { type: 'between_tools' } } : { ...adaptive, ...effort };
    case 'adaptive-opt-in':
      // Without `thinking` these don't think, which is what 'off' asks.
      return lvl === 'off' ? {} : { ...adaptive, ...effort };
    case 'adaptive-sampling':
      // Thinking is on by Cascade's default here, as it was before levels existed.
      return lvl === 'off' ? { temperature: temp } : { thinking: { type: 'adaptive' }, ...effort };
    case 'budget': {
      // 'auto' is what Cascade always did: Opus and Sonnet think (8k), Haiku doesn't.
      const want = lvl === 'off' ? 0 : lvl === 'auto' ? (parseClaudeId(modelId)?.family === 'haiku' ? 0 : BUDGET.medium) : BUDGET[lvl];
      const budget = Math.min(want, maxTokens - 1024);
      // A thinking request takes the default temperature (1): none is sent.
      return want > 0 && budget >= 1024 ? { thinking: { type: 'enabled', budget_tokens: budget } } : { temperature: temp };
    }
    default:
      return { temperature: temp };
  }
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

/** o-series, GPT-5 and GPT-6 models reason; earlier GPT models don't. (openai.ts's isReasoningModel.) */
export function isOpenAIReasoningModel(id: string): boolean {
  const m = (id || '').toLowerCase();
  return /(^o[1345]\b)|(^o[1345]-)|gpt-?[56]/.test(m);
}

/**
 * The reasoning effort for an OpenAI model at this level, or undefined to send
 * none. 'off' is the least each family takes: `none` where it exists (GPT-5.1
 * and later, GPT-6), `minimal` on GPT-5, `low` on the o-series.
 */
export function openaiReasoningEffort(modelId: string, level: ThinkingLevel | undefined): 'none' | 'minimal' | Effort | undefined {
  if (!level || level === 'auto' || !isOpenAIReasoningModel(modelId)) return undefined;
  if (level !== 'off') return LEVEL_EFFORT[level];
  if (/gpt-?6|gpt-?5\.[1-9]/i.test(modelId)) return 'none';
  if (/gpt-?5/i.test(modelId)) return 'minimal';
  return 'low';
}

// ── Gemini ─────────────────────────────────────────────────────────────────

export interface GeminiThinkingConfig { thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'; thinkingBudget?: number }

/**
 * The `thinkingConfig` for a Gemini model at this level, or undefined to send
 * none. Gemini 3 and later take a level (minimal only on Gemini 3 Flash, medium
 * on all but the original Gemini 3 Pro); Gemini 2.5 a token budget (Pro can't go
 * below 128; Flash can be off).
 */
export function geminiThinkingConfig(modelId: string, level: ThinkingLevel | undefined): GeminiThinkingConfig | undefined {
  if (!level || level === 'auto') return undefined;
  const m = /gemini-(\d+(?:\.\d+)?)/i.exec(modelId || '');
  if (!m) return undefined;
  const version = Number(m[1]);
  const pro = /-pro/i.test(modelId);
  if (version >= 3) {
    // Low and high are taken by every Gemini 3 and later. Minimal only by Gemini
    // 3 Flash (later Flash models and Gemini 4 dropped it), so 'off' is low
    // elsewhere. Medium by all but the original Gemini 3 Pro, where it is high.
    if (level === 'off') return { thinkingLevel: version === 3 && !pro ? 'MINIMAL' : 'LOW' };
    if (level === 'medium') return { thinkingLevel: pro && version < 3.1 ? 'HIGH' : 'MEDIUM' };
    return { thinkingLevel: level === 'low' ? 'LOW' : 'HIGH' };
  }
  if (version >= 2.5) {
    if (level === 'off') return { thinkingBudget: pro ? 128 : 0 };
    return { thinkingBudget: ({ low: 1024, medium: 8192, high: pro ? 32768 : 24576 } as const)[level] };
  }
  return undefined;
}
