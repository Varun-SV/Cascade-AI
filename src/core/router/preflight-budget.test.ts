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

  it('reserves an admitted call, so a parallel wave cannot all pass the same budget', async () => {
    // The common case walks straight into this: T2 launches a T3 wave through
    // Promise.allSettled, so every call reaches the check before any response
    // has updated runCostUsd. Measuring against spent-so-far alone admitted all
    // of them against the same untouched allowance.
    const router = await makeRouter({ maxCostPerRunUsd: 0.10 });
    const r = router as unknown as {
      enforcePreflightBudget: (m: ModelInfo, o: unknown) => (() => void) | undefined;
    };
    const call = () => r.enforcePreflightBudget(PRICED, {
      // ~$0.09 of input: fits a $0.10 cap once, not twice.
      messages: [{ role: 'user', content: 'y'.repeat(120_000) }],
      maxTokens: 40,
    });

    const first = call();          // admitted, and now holding its estimate
    expect(first).toBeTypeOf('function');
    expect(() => call()).toThrow(/remains/); // second sees the reservation

    first!();                      // first call settles
    expect(() => call()).not.toThrow(); // allowance is free again
  });

  it('releases a reservation exactly once, however many times it is called', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 1.00 });
    const r = router as unknown as {
      enforcePreflightBudget: (m: ModelInfo, o: unknown) => (() => void) | undefined;
      reservedCostUsd: number;
    };
    const release = r.enforcePreflightBudget(PRICED, {
      messages: [{ role: 'user', content: 'z'.repeat(40_000) }], maxTokens: 40,
    });
    expect(r.reservedCostUsd).toBeGreaterThan(0);
    release!();
    release!();
    release!();
    expect(r.reservedCostUsd).toBeCloseTo(0, 10);
  });

  it('beginRun() clears a reservation left behind by a run that did not settle', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 0.10 });
    const r = router as unknown as {
      enforcePreflightBudget: (m: ModelInfo, o: unknown) => (() => void) | undefined;
      reservedCostUsd: number;
    };
    r.enforcePreflightBudget(PRICED, {
      messages: [{ role: 'user', content: 'y'.repeat(120_000) }], maxTokens: 40,
    });
    router.beginRun();
    expect(r.reservedCostUsd).toBe(0);
  });

  it('counts tool definitions, which the provider bills on every native-tool call', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 0.0005 });
    const r = router as unknown as { enforcePreflightBudget: (m: ModelInfo, o: unknown) => unknown };
    const bigTool = {
      name: 'search', description: 'd'.repeat(50_000),
      inputSchema: { type: 'object', properties: {} },
    };
    // A two-word prompt, but a schema the provider serializes and charges for.
    expect(() => r.enforcePreflightBudget(PRICED, {
      messages: [{ role: 'user', content: 'find it' }],
      tools: [bigTool],
      maxTokens: 40,
    })).toThrow(/would cost about/);
  });

  it('charges an image as an image, not as the "[image]" placeholder', async () => {
    // The block nests an ImageAttachment. An earlier version of this test
    // built a flattened shape, which is not a valid MessageContent, so it
    // passed while the estimator read a field that never exists.
    const router = await makeRouter({ maxCostPerRunUsd: 0.0005 });
    const r = router as unknown as { enforcePreflightBudget: (m: ModelInfo, o: unknown) => unknown };
    expect(() => r.enforcePreflightBudget(PRICED, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', image: { type: 'base64', data: 'A'.repeat(4_000_000), mimeType: 'image/png' } },
        ],
      }],
      maxTokens: 40,
    })).toThrow(/would cost about/);
  });

  it('still charges a url-referenced image something, not nothing', async () => {
    // A URL carries a link, not the picture, so its length says nothing about
    // the image — but the image is still billed, so it cannot count as zero.
    const router = await makeRouter({ maxCostPerRunUsd: 1.0 });
    const r = router as unknown as {
      enforcePreflightBudget: (m: ModelInfo, o: unknown) => (() => void) | undefined;
      reservedTokens: number;
    };
    r.enforcePreflightBudget(PRICED, {
      messages: [{ role: 'user', content: [{ type: 'image', image: { type: 'url', data: 'https://example.com/a.png', mimeType: 'image/png' } }] }],
      maxTokens: 40,
    });
    expect(r.reservedTokens).toBeGreaterThan(100);
  });

  it('releases the reservation when the local queue never admits the call', async () => {
    // The reservation is taken before the try/finally that frees it, so a
    // queue timeout used to strand it for the rest of the run — shrinking every
    // later allowance over a request that was never submitted anywhere.
    const router = await makeRouter({ maxTokensPerRun: 1_000_000 });
    const r = router as unknown as {
      localQueue: { acquire: (ms: number) => Promise<() => void> };
      reservedTokens: number;
      tierModels: Map<string, ModelInfo>;
      config: Record<string, unknown>;
    };
    r.localQueue = { acquire: async () => { throw new Error('queue wait timed out'); } };
    r.tierModels.set('T3', UNPRICED);
    (router as unknown as { getProvider: (m: ModelInfo) => unknown }).getProvider = () => ({
      generate: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0 } }),
    });

    await expect(router.generate('T3', { messages: [{ role: 'user', content: 'hello' }] }))
      .rejects.toThrow(/queue wait timed out/);
    expect(r.reservedTokens).toBe(0);
  });

  it('does not undercount CJK, which costs about a token per character', async () => {
    // estimateTokens divides by four, which suits English. For dense scripts
    // that underestimates roughly fourfold — and an underestimate in an
    // enforcement path is a cap that silently does not hold.
    const router = await makeRouter({ maxTokensPerRun: 1_000_000 });
    const r = router as unknown as {
      enforcePreflightBudget: (m: ModelInfo, o: unknown) => (() => void) | undefined;
      reservedTokens: number;
    };
    const size = (text: string) => {
      const release = r.enforcePreflightBudget(PRICED, { messages: [{ role: 'user', content: text }], maxTokens: 40 });
      const n = r.reservedTokens;
      release!();
      return n;
    };

    expect(size('速'.repeat(10_000))).toBeGreaterThanOrEqual(10_000);
    // ASCII is left exactly where it was — no inflation of ordinary prompts.
    expect(size('a'.repeat(10_000))).toBe(2_500);
  });

  it('counts an assistant turn\'s tool calls, which ride into the next request', async () => {
    const router = await makeRouter({ maxCostPerRunUsd: 0.0005 });
    const r = router as unknown as { enforcePreflightBudget: (m: ModelInfo, o: unknown) => unknown };
    expect(() => r.enforcePreflightBudget(PRICED, {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: '1', name: 'write', input: { body: 'b'.repeat(60_000) } }],
        },
      ],
      maxTokens: 40,
    })).toThrow(/would cost about/);
  });

  it('counts top-level options.images, not only nested blocks', async () => {
    // GeminiProvider feeds options.images straight into buildContents(), so a
    // whole vision path was going unreserved.
    const router = await makeRouter({ maxTokensPerRun: 5_000 });
    const r = router as unknown as { enforcePreflightBudget: (m: ModelInfo, o: unknown) => unknown };
    expect(() => r.enforcePreflightBudget(PRICED, {
      messages: [{ role: 'user', content: 'describe these' }],
      images: [
        { type: 'base64', data: 'A'.repeat(100), mimeType: 'image/png' },
        { type: 'base64', data: 'A'.repeat(100), mimeType: 'image/png' },
        { type: 'base64', data: 'A'.repeat(100), mimeType: 'image/png' },
      ],
      maxTokens: 40,
    })).toThrow(/per-task cap/);
  });

  it('charges a tiny compressed image the same as a large one', async () => {
    // Providers bill from DECODED dimensions, so a heavily compressed PNG can
    // be a few kilobytes and still billed near the megapixel maximum. Sizing
    // from bytes undercut exactly the images that would slip a tight cap.
    const router = await makeRouter({ maxTokensPerRun: 1_000_000 });
    const r = router as unknown as {
      enforcePreflightBudget: (m: ModelInfo, o: unknown) => (() => void) | undefined;
      reservedTokens: number;
    };
    const size = (data: string) => {
      const release = r.enforcePreflightBudget(PRICED, {
        messages: [{ role: 'user', content: [{ type: 'image', image: { type: 'base64', data, mimeType: 'image/png' } }] }],
        maxTokens: 40,
      });
      const n = r.reservedTokens;
      release!();
      return n;
    };
    expect(size('A'.repeat(2_000))).toBe(size('A'.repeat(4_000_000)));
  });

  it('does not submit a call that was admitted before a sibling killed the run', async () => {
    // A wave's calls pass the top-of-method guard together, then sit in the
    // TPM bucket or the local queue. If a sibling trips the ceiling while they
    // wait, every one of them used to go on and spend against a run that is
    // already over and whose output will be discarded.
    const router = await makeRouter({ maxCostPerRunUsd: 1.0 });
    const r = router as unknown as {
      tierModels: Map<string, ModelInfo>;
      runBudgetExceeded: boolean;
      runBudgetExceededReason: string;
      reservedCostUsd: number;
      tpmLimiter: { acquire: (p: string, n: number) => Promise<void> } | undefined;
    };
    r.tierModels.set('T3', PRICED);
    let submitted = 0;
    (router as unknown as { getProvider: (m: ModelInfo) => unknown }).getProvider = () => ({
      generate: async () => { submitted++; return { content: 'x', usage: { inputTokens: 1, outputTokens: 1 } }; },
    });
    // Stand in for a long wait: the sibling trips the ceiling while parked.
    r.tpmLimiter = {
      acquire: async () => {
        r.runBudgetExceeded = true;
        r.runBudgetExceededReason = 'Per-task cost cap reached';
      },
    };

    await expect(router.generate('T3', { messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/cost cap/);
    expect(submitted).toBe(0);
    // …and it did not walk off with the allowance it had reserved.
    expect(r.reservedCostUsd).toBeCloseTo(0, 10);
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
