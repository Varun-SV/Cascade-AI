// Opt-in, in-browser routing classifier. When the user has the on-device model
// enabled and it's already warm, we ask it to bucket a prompt into
// Simple / Moderate / Complex BEFORE the run is sent. The server then skips its
// own paid classifier LLM call and uses this verdict as the starting point —
// still applying its heuristic floors and escalation as guardrails, so a tiny
// model's miss can never strand a complex task on a cheap tier.
//
// The verdict is only ever a hint: the classifier returns null on any doubt
// (cold engine, timeout, unparseable output), and the server falls back to its
// normal classification. Prompt-building and parsing are pure functions kept
// separate for unit testing.
import { getEngine, isEngineWarm } from './engine.js';

export type LocalComplexity = 'Simple' | 'Moderate' | 'Complex';

// A tiny model can't afford a wandering context, so keep the prior turns short.
const MAX_CONTEXT_CHARS = 600;
const MAX_PROMPT_CHARS = 1200;
// Once warm, classifying ~8 tokens on a 0.5B model is well under this. The cap
// only exists so a wedged worker never delays the send noticeably.
const CLASSIFY_TIMEOUT_MS = 1500;

/** Builds the single-turn classification prompt (few-shot, verdict-only). */
export function buildClassifierPrompt(prompt: string, contextSnippet?: string): string {
  const context = contextSnippet?.trim().slice(-MAX_CONTEXT_CHARS);
  const task = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  return (
    'You are a routing classifier. Bucket the user request into exactly one of: ' +
    'Simple, Moderate, Complex.\n' +
    '- Simple: basic conversation, a direct single-step answer, or reading/explaining existing content.\n' +
    '- Moderate: a few steps, some tool use, or one small artifact.\n' +
    '- Complex: planning, multiple parts, file/report production, verification, research, or substantial implementation.\n' +
    'Answer with ONLY the one word.\n\n' +
    'Request: Say hi\nAnswer: Simple\n\n' +
    'Request: Write a python script that saves a report to disk and verify it\nAnswer: Complex\n\n' +
    'Request: Fix the typo in this sentence\nAnswer: Simple\n\n' +
    (context ? `Recent context:\n${context}\n\n` : '') +
    `Request: ${task}\nAnswer:`
  );
}

/** Extracts the first Simple/Moderate/Complex word from model output, or null. */
export function parseComplexity(raw: string | null | undefined): LocalComplexity | null {
  const match = (raw ?? '').toLowerCase().match(/\b(simple|moderate|complex)\b/);
  if (!match) return null;
  return match[1] === 'simple' ? 'Simple' : match[1] === 'moderate' ? 'Moderate' : 'Complex';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * Classify a prompt on-device. Returns null (never throws) whenever the answer
 * would be unreliable — cold engine, timeout, or unparseable output — so the
 * caller simply omits the hint and lets the server classify. Only runs when the
 * engine is ALREADY warm, so it never blocks a send on a model download.
 */
export async function classifyLocalComplexity(prompt: string, contextSnippet?: string): Promise<LocalComplexity | null> {
  if (!prompt.trim() || !isEngineWarm()) return null;
  try {
    const engine = await getEngine();
    const reply = await withTimeout(
      engine.chat.completions.create({
        messages: [{ role: 'user', content: buildClassifierPrompt(prompt, contextSnippet) }],
        max_tokens: 4,
        temperature: 0,
      }),
      CLASSIFY_TIMEOUT_MS,
    );
    if (!reply) return null;
    return parseComplexity(reply.choices[0]?.message?.content ?? '');
  } catch {
    return null;
  }
}
