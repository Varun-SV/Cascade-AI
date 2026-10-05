// ─────────────────────────────────────────────
//  Cascade AI — Wrap-up: work, then the answer
// ─────────────────────────────────────────────
//
// A per-run cap used to end a run the moment it was crossed, answer or not.
// Now work may spend 80% of it; past that, work is refused and the rest pays
// for writing the answer from what is done. See run-budget.ts.

import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig, ModelInfo } from '../../types.js';

async function makeRouter(budget?: CascadeConfig['budget']): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
  (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init({
    providers: [], models: {}, tools: { allowedTools: [] }, ...(budget ? { budget } : {}),
  } as unknown as CascadeConfig);
  router.beginRun();
  return router;
}

/** $3 per million input tokens, $15 per million output. */
const PRICED: ModelInfo = {
  id: 'claude-sonnet-4', name: 'Sonnet', provider: 'anthropic',
  contextWindow: 200_000, maxOutputTokens: 8_000,
  inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015,
  isVisionCapable: false, supportsStreaming: true, isLocal: false,
} as unknown as ModelInfo;

type Internals = {
  tierModels: Map<string, ModelInfo>;
  getProvider: (m: ModelInfo) => unknown;
  runCostUsd: number;
  runTokens: number;
};

/** Answers every call with `usage`, recording the output limit each was sent with. */
function answering(router: CascadeRouter, usage = { inputTokens: 10, outputTokens: 10 }) {
  const r = router as unknown as Internals;
  r.tierModels.set('T1', PRICED);
  r.tierModels.set('T3', PRICED);
  const sent: Array<number | undefined> = [];
  r.getProvider = () => ({
    generate: async (opts: { maxTokens?: number }) => {
      sent.push(opts.maxTokens);
      return { content: 'ok', usage: { ...usage }, finishReason: 'stop' };
    },
  });
  return sent;
}

const ask = { messages: [{ role: 'user' as const, content: 'work' }], maxTokens: 1_000 };

describe('wrapping up a run', () => {
  it('stops starting work once work has spent its share of the cap, and says why', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    answering(router);
    (router as unknown as Internals).runCostUsd = 0.79;
    const heard = vi.fn();
    router.on('budget:wrap-up', heard);

    // $0.79 spent, and this call can write $0.015 more: past the $0.80 for work.
    await expect(router.generate('T3', ask)).rejects.toMatchObject({ name: 'BudgetWrapUpError' });
    expect(router.isWrappingUp()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0]![0]).toMatchObject({ capUsd: 1, spentUsd: 0.79 });
    expect(heard.mock.calls[0]![0].reason).toMatch(/\$0\.7900 of this task's \$1\.00 budget/);
    // A wrap-up is not the hard stop: the run goes on to write its answer.
    expect(router.budgetExceededInfo()).toBeNull();
  });

  it('refuses later work, but still writes the answer', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    answering(router);
    (router as unknown as Internals).runCostUsd = 0.85;
    await expect(router.generate('T3', ask)).rejects.toMatchObject({ name: 'BudgetWrapUpError' });
    await expect(router.generate('T3', ask)).rejects.toMatchObject({ name: 'BudgetWrapUpError' });
    await expect(router.generate('T1', { ...ask, budgetClass: 'final' })).resolves.toMatchObject({ content: 'ok' });
    // Both refusals count as work held back; the answer does not.
    expect(router.runBudget().workNotStarted).toBe(2);
  });

  it('counts the work a tier chose not to start', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    router.noteWorkNotStarted(3);
    expect(router.runBudget().workNotStarted).toBe(3);
    router.beginRun();
    expect(router.runBudget().workNotStarted).toBe(0);
  });

  it('once wrapping up, refuses even a small call that would still fit', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    answering(router);
    (router as unknown as Internals).runCostUsd = 0.79;
    // This one can write $0.015 more, which crosses $0.80: wrap-up starts…
    await expect(router.generate('T3', ask)).rejects.toMatchObject({ name: 'BudgetWrapUpError' });
    // …and a call small enough to fit is still not work the run starts now.
    await expect(router.generate('T3', { ...ask, maxTokens: 10 })).rejects.toMatchObject({ name: 'BudgetWrapUpError' });
  });

  it('wraps up after a call crosses the line, without cancelling anything', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    // 56,667 output tokens at $15 per million: $0.85.
    answering(router, { inputTokens: 0, outputTokens: 56_667 });
    await expect(router.generate('T3', ask)).resolves.toMatchObject({ content: 'ok' });
    expect(router.isWrappingUp()).toBe(true);
    expect(router.budgetExceededInfo()).toBeNull();
  });

  it('holds what each call in a wave may write, so the wave cannot spend the reserve', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    const r = router as unknown as Internals;
    r.tierModels.set('T3', PRICED);
    let reached = 0;
    r.getProvider = () => ({
      generate: () => { reached++; return new Promise(() => {}); },
    });
    r.runCostUsd = 0.7;
    // Each admitted call holds 1,500 output tokens ($0.0225): four fit under $0.80.
    const wave = Array.from({ length: 6 }, () => router.generate('T3', { messages: ask.messages, maxTokens: 4_000 }));
    const settled = await Promise.race([
      Promise.allSettled(wave.slice(4)),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ]);
    expect(settled).not.toBe('timeout');
    expect((settled as PromiseSettledResult<unknown>[]).map((s) => s.status)).toEqual(['rejected', 'rejected']);
    await vi.waitFor(() => expect(reached).toBe(4));
  });

  it('fits the answer to what the cap has left', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    const sent = answering(router);
    (router as unknown as Internals).runCostUsd = 0.9;
    await router.generate('T1', { ...ask, maxTokens: 8_000, budgetClass: 'final' });
    // $0.10 left buys about 6,600 output tokens at $15 per million.
    expect(sent[0]).toBeGreaterThan(6_000);
    expect(sent[0]).toBeLessThan(6_700);
  });

  it('declines the answer, without stopping the run, when too little is left to write one', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    const sent = answering(router);
    (router as unknown as Internals).runCostUsd = 0.999;
    await expect(router.generate('T1', { ...ask, budgetClass: 'final' })).rejects.toMatchObject({ name: 'BudgetWrapUpError' });
    expect(sent).toEqual([]);
    expect(router.budgetExceededInfo()).toBeNull();
  });

  it('keeps an answer that lands past the cap, then stops the run', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    // The estimate allowed it; the model wrote more than expected.
    answering(router, { inputTokens: 0, outputTokens: 7_000 });
    (router as unknown as Internals).runCostUsd = 0.95;
    await expect(router.generate('T1', { ...ask, maxTokens: 3_000, budgetClass: 'final' })).resolves.toMatchObject({ content: 'ok' });
    expect(router.budgetExceededInfo()).not.toBeNull();
  });

  it('keeps the same reserve on the token cap', async () => {
    const router = await makeRouter({ maxTokensPerRun: 10_000 });
    answering(router);
    (router as unknown as Internals).runTokens = 7_900;
    await expect(router.generate('T3', { ...ask, maxTokens: 500 })).rejects.toMatchObject({ name: 'BudgetWrapUpError' });
    expect(router.runBudget()).toMatchObject({ capTokens: 10_000, usedTokens: 7_900, wrappingUp: true });
  });

  it('starts the next run with work allowed again', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1 });
    answering(router);
    (router as unknown as Internals).runCostUsd = 0.85;
    await expect(router.generate('T3', ask)).rejects.toMatchObject({ name: 'BudgetWrapUpError' });
    router.beginRun();
    expect(router.isWrappingUp()).toBe(false);
    await expect(router.generate('T3', ask)).resolves.toMatchObject({ content: 'ok' });
  });

  it('changes nothing without a cap', async () => {
    const router = await makeRouter();
    const sent = answering(router, { inputTokens: 0, outputTokens: 1_000_000 });
    await expect(router.generate('T3', ask)).resolves.toMatchObject({ content: 'ok' });
    await expect(router.generate('T1', { ...ask, maxTokens: 8_000, budgetClass: 'final' })).resolves.toMatchObject({ content: 'ok' });
    expect(sent).toEqual([1_000, 8_000]);
    expect(router.isWrappingUp()).toBe(false);
  });
});
