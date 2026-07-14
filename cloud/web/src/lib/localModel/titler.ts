// Opt-in, in-browser conversation titler. The heavy WebLLM engine is imported
// lazily (only when the user has enabled the feature and a title is needed), so
// it never touches the initial bundle. The prompt-building and output-cleaning
// are pure functions kept separate for unit testing.

// A small, capable instruct model from WebLLM's prebuilt list. ~0.5B params,
// a few hundred MB quantized — enough to summarize a chat into a short title.
export const TITLE_MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

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

export interface TitleProgress {
  stage: 'loading' | 'ready' | 'generating';
  /** 0..1 while the model downloads/initializes. */
  progress?: number;
  text?: string;
}

// Minimal shape of the WebLLM engine we use — avoids importing its types at
// module load (which would pull the library into the main chunk).
interface MlcEngine {
  chat: {
    completions: {
      create(req: {
        messages: Array<{ role: string; content: string }>;
        max_tokens?: number;
        temperature?: number;
      }): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
}

let enginePromise: Promise<MlcEngine> | null = null;

/** Lazily spins up the WebLLM engine in a Web Worker (once per page). */
async function getEngine(onProgress?: (p: TitleProgress) => void): Promise<MlcEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const engine = await CreateWebWorkerMLCEngine(worker, TITLE_MODEL_ID, {
        initProgressCallback: (r: { progress: number; text: string }) =>
          onProgress?.({ stage: 'loading', progress: r.progress, text: r.text }),
      });
      onProgress?.({ stage: 'ready' });
      return engine as unknown as MlcEngine;
    })();
  }
  return enginePromise;
}

/** True once the engine has been created this session (model downloaded/cached). */
export function isEngineWarm(): boolean {
  return enginePromise !== null;
}

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
