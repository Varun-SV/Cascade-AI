// ─────────────────────────────────────────────
//  Cascade AI — Preflight Budget Tests
// ─────────────────────────────────────────────
//
// The per-run caps are enforced AFTER a call returns, which makes them a stop
// rather than a pre-authorisation: the tokens are already bought by the time
// they are counted. That was tolerable while a prompt could not exceed 20,000
// characters. Once that cap was removed, a multi-megabyte prompt could be
// billed in full on the very first call — the complexity classifier sends the
// whole thing — with no ceiling able to give the money back.

import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig, ModelInfo } from '../../types.js';

function makeConfig(budget?: CascadeConfig['budget']): CascadeConfig {
  return {
    providers: [],
    models: {},
    tools: { allowedTools: [] },
    ...(budget ? { budget } : {}),
  } as unknown as CascadeConfig;
}

async function makeRouter(budget?: CascadeConfig['budget']): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
  (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init(makeConfig(budget));
  router.beginRun();
  return router;
}

/** A priced cloud model: $3 per million input tokens. */
const PRICED: ModelInfo = {
  id: 'claude-sonnet-4', name: 'Sonnet', provider: 'anthropic',
  contextWindow: 200_000, maxOutputTokens: 8_000,
  inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015,
  isVisionCapable: false, supportsStreaming: true, isLocal: false,
} as unknown as ModelInfo;

/** A local model with no price attached — nothing to estimate against. */
const UNPRICED: ModelInfo = {
  ...PRICED, id: 'llama3', provider: 'ollama', isLocal: true,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
} as unknown as ModelInfo;

function preflight(router: CascadeRouter, model: ModelInfo, prompt: string, systemPrompt?: string): void {
  (router as unknown as {
    enforcePreflightBudget: (m: ModelInfo, o: unknown) => void;
  }).enforcePreflightBudget(model, {
    messages: [{ role: 'user', content: prompt }],
    ...(systemPrompt ? { systemPrompt } : {}),
    maxTokens: 40,
  });
}

// ~4 chars per token, so a megabyte of text is ~250k tokens ≈ $0.75 at $3/M.
const HUGE = 'x'.repeat(1_000_000);

describe('preflight budget', () => {
  it('refuses a call whose input alone cannot fit the cost cap', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 0.10 });
    expect(() => preflight(router, PRICED, HUGE)).toThrow(/would cost about/);
  });

  it('lets an ordinary request through untouched', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 0.10 });
    expect(() => preflight(router, PRICED, 'summarise this paragraph')).not.toThrow();
  });

  it('names the cap AND the estimate, so the user can act on it', async () => {
    // "Too expensive" with no numbers gives nobody anything to change.
    const router = await makeRouter({ maxCostPerRunUsd: 0.10 });
    let message = '';
    try { preflight(router, PRICED, HUGE); } catch (err) { message = (err as Error).message; }
    expect(message).toContain('$0.1000');            // the cap
    expect(message).toMatch(/\$\d+\.\d{4} in input/); // the estimate
    expect(message).toContain('anthropic:claude-sonnet-4');
    expect(message).toContain('raise budget.maxCostPerRunUsd');
  });

  it('judges against what REMAINS, not the whole cap', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1.00 });
    // ~$0.75 of input: fine against a fresh $1.00 budget.
    expect(() => preflight(router, PRICED, HUGE)).not.toThrow();

    // Spend most of it, and the same request no longer fits.
    (router as unknown as { runCostUsd: number }).runCostUsd = 0.95;
    expect(() => preflight(router, PRICED, HUGE)).toThrow(/remains/);
  });

  it('does not charge OUTPUT against the budget', async () => {
    // What a call returns is not knowable in advance. Reserving a worst-case
    // maxTokens of output would decline runs that would have finished fine —
    // a false refusal is worse than a late stop.
    const router = await makeRouter({ maxCostPerRunUsd: 0.001 });
    (router as unknown as { enforcePreflightBudget: (m: ModelInfo, o: unknown) => void })
      .enforcePreflightBudget(PRICED, {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 8_000, // ~$0.12 of output if it were counted
      });
  });

  it('skips a model with no usable price rather than refusing on ignorance', async () => {
    // Otherwise setting a cost cap would break every local and self-hosted
    // model outright. The post-hoc stop still applies to those.
    const router = await makeRouter({ maxCostPerRunUsd: 0.0001 });
    expect(() => preflight(router, UNPRICED, HUGE)).not.toThrow();
  });

  it('does nothing when no cap is configured', async () => {
    const router = await makeRouter();
    expect(() => preflight(router, PRICED, HUGE)).not.toThrow();
  });

  it('counts the system prompt as input too', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 0.10 });
    expect(() => preflight(router, PRICED, 'hi', HUGE)).toThrow(/would cost about/);
  });

  it('refuses when the input alone exceeds the remaining TOKEN cap', async () => {
    const router = await makeRouter({ maxTokensPerRun: 1_000 });
    expect(() => preflight(router, PRICED, HUGE)).toThrow(/per-task cap of 1,000/);
  });

  it('reports a preflight refusal the same way a post-hoc overrun is reported', async () => {
    // A worker that catches BudgetExceededError turns it into a FAILED result,
    // so the run-level flag is what tells the surfaces why.
    const router = await makeRouter({ maxCostPerRunUsd: 0.10 });
    const seen: string[] = [];
    router.on('budget:exceeded', (e: { reason: string }) => seen.push(e.reason));
    expect(() => preflight(router, PRICED, HUGE)).toThrow();
    expect(seen).toHaveLength(1);
    expect(router.budgetExceededInfo()?.reason).toContain('would cost about');
  });
});
