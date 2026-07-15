// Shared lazy WebLLM engine. The heavy library is imported dynamically the
// first time the engine is actually needed, so it never enters the initial
// bundle. Both the on-device titler and the complexity classifier reuse this
// single engine — one model download, one worker per page.

// A small, capable instruct model from WebLLM's prebuilt list. ~0.5B params,
// a few hundred MB quantized — enough for short titles and a 3-way routing
// classification, both far narrower than open-ended chat.
export const LOCAL_MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

export interface EngineProgress {
  stage: 'loading' | 'ready' | 'generating';
  /** 0..1 while the model downloads/initializes. */
  progress?: number;
  text?: string;
}

// Minimal shape of the WebLLM engine we use — avoids importing its types at
// module load (which would pull the library into the main chunk).
export interface MlcEngine {
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
export async function getEngine(onProgress?: (p: EngineProgress) => void): Promise<MlcEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const engine = await CreateWebWorkerMLCEngine(worker, LOCAL_MODEL_ID, {
        initProgressCallback: (r: { progress: number; text: string }) =>
          onProgress?.({ stage: 'loading', progress: r.progress, text: r.text }),
      });
      onProgress?.({ stage: 'ready' });
      return engine as unknown as MlcEngine;
    })().catch((e) => {
      enginePromise = null; // a failed load shouldn't poison future attempts
      throw e;
    });
  }
  return enginePromise;
}

/** True once the engine has been created this session (model downloaded/cached). */
export function isEngineWarm(): boolean {
  return enginePromise !== null;
}

/**
 * Kicks off the model download/init in the background (fire-and-forget). Call
 * this on an idle callback when the user has opted into the on-device model so
 * the classifier and titler are ready before they're first needed. Errors are
 * swallowed — getEngine() already clears the promise so a later call retries.
 */
export function warmLocalModel(): void {
  void getEngine().catch(() => {});
}
