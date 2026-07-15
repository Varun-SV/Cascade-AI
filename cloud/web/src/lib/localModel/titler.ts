// Opt-in, in-browser conversation titler. The heavy WebLLM engine lives in the
// shared engine module and is imported lazily (only when the user has enabled
// the feature and a title is needed), so it never touches the initial bundle.
// The prompt-building and output-cleaning are pure functions kept separate for
// unit testing.
import { getEngine, isEngineWarm, LOCAL_MODEL_ID, type EngineProgress } from './engine.js';

// Kept as an alias for backwards compatibility with existing imports/tests.
export const TITLE_MODEL_ID = LOCAL_MODEL_ID;
export { isEngineWarm };

const MAX_TITLE_WORDS = 8;
const MAX_TITLE_CHARS = 60;

/** Builds the single-turn prompt that asks the model for a short title. */
export function buildTitlePrompt(firstUser: string, firstAssistant: string): string {
  const convo = `User: ${firstUser}\n\nAssistant: ${firstAssistant}`.slice(0, 1500);
  return (
    'Write a short, specific title (3 to 6 words) for the conversation below. ' +
    'Output ONLY the title text — no quotes, no trailing punctuation, no prefix like "Title:".\n\n' +
    convo
  );
}

/** Normalizes raw model output into a clean, bounded title (or '' if unusable). */
export function cleanTitle(raw: string): string {
  let t = (raw ?? '').trim().split('\n')[0] ?? '';
  // Strip a leading "Title:" label and surrounding quotes/backticks.
  t = t.replace(/^\s*title\s*:\s*/i, '');
  t = t.replace(/^["'`*]+|["'`*]+$/g, '').trim();
  t = t.replace(/[.\s]+$/g, '').trim();
  if (!t) return '';
  const words = t.split(/\s+/).slice(0, MAX_TITLE_WORDS);
  return words.join(' ').slice(0, MAX_TITLE_CHARS);
}

// Progress shape re-exported under the titler's historical name.
export type TitleProgress = EngineProgress;

/**
 * Generate a title for a conversation from its first user + assistant turns.
 * Returns '' on any failure — callers keep the existing title on empty.
 */
export async function generateLocalTitle(
  firstUser: string,
  firstAssistant: string,
  onProgress?: (p: TitleProgress) => void,
): Promise<string> {
  try {
    const engine = await getEngine(onProgress);
    onProgress?.({ stage: 'generating' });
    const reply = await engine.chat.completions.create({
      messages: [{ role: 'user', content: buildTitlePrompt(firstUser, firstAssistant) }],
      max_tokens: 24,
      temperature: 0.3,
    });
    return cleanTitle(reply.choices[0]?.message?.content ?? '');
  } catch {
    return '';
  }
}
