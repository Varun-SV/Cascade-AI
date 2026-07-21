// Rough client-side token accounting for the "Context" meter. This is a display
// estimate only — the server enforces the real budgets. ~4 chars/token is the
// standard English approximation; good enough to show "how full is this chat".

export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Sum an estimate over a conversation's message contents. */
export function estimateConversationTokens(messages: Array<{ content: string }>): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content);
  return total;
}

// Context windows for the model families the router picks, keyed by substring of
// the model id. Ordered roughly most-specific → least. A conservative default is
// used for anything unrecognised so the meter never claims a window we can't back.
const WINDOWS: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/gpt-?4\.1/i, 1_000_000],
  [/gpt-?5/i, 400_000],
  [/claude/i, 200_000],
  [/gpt-?4o/i, 128_000],
  [/llama|mistral|qwen|deepseek|gemma|codellama/i, 128_000],
];

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Best-effort context window (in tokens) for a run's model string, which arrives
 * as "provider:modelid" (e.g. "azure:gpt-5.4-mini", "openai:gpt-5"). Falls back
 * to a conservative default when the model is unknown or absent.
 */
export function contextWindowFor(model?: string | null): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const id = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
  for (const [re, win] of WINDOWS) if (re.test(id)) return win;
  return DEFAULT_CONTEXT_WINDOW;
}
