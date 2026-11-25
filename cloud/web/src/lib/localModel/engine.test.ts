import { describe, it, expect, vi, beforeEach } from 'vitest';

let finish!: (engine: unknown) => void;
vi.mock('@mlc-ai/web-llm', () => ({
  CreateWebWorkerMLCEngine: vi.fn((_w: unknown, _id: string, opts: { initProgressCallback: (r: { progress: number; text: string }) => void }) => {
    opts.initProgressCallback({ progress: 0.4, text: 'loading' });
    return new Promise((r) => { finish = r; });
  }),
}));

class FakeWorker { constructor(public url: unknown) {} terminate() {} }

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
});

describe('the on-device engine', () => {
  it('is warm while it loads but ready only once loaded, and says how far along it is', async () => {
    const engine = await import('./engine.js');
    const seen: string[] = [];
    engine.subscribeEngineStatus((s) => seen.push(`${s.stage}${s.progress !== undefined ? `:${s.progress}` : ''}`));
    const loading = engine.getEngine();
    await vi.waitFor(() => expect(seen).toContain('loading:0.4'));
    expect(engine.isEngineWarm()).toBe(true);
    expect(engine.isEngineReady()).toBe(false);
    finish({ chat: { completions: { create: vi.fn() } } });
    await loading;
    expect(engine.isEngineReady()).toBe(true);
    expect(engine.getEngineStatus().stage).toBe('ready');
  });

  it('a classification asked while the model still loads returns at once, without waiting for it', async () => {
    const engine = await import('./engine.js');
    const { classifyLocalComplexity } = await import('./classifier.js');
    void engine.getEngine();
    await vi.waitFor(() => expect(engine.getEngineStatus().stage).toBe('loading'));
    const started = Date.now();
    await expect(classifyLocalComplexity('Refactor the parser')).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
});
