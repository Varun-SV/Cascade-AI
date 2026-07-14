// Web Worker host for the WebLLM engine. Running inference off the main thread
// keeps the chat UI responsive while the local title model works. Vite bundles
// this via the `new Worker(new URL('./worker.ts', import.meta.url))` reference
// in titler.ts.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg);
};
