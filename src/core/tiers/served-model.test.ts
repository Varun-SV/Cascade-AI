// ─────────────────────────────────────────────
//  Cascade AI — a tier reports the model that answered
// ─────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BaseTier } from './base.js';
import type { CascadeRouter } from '../router/index.js';
import type { TierStatusEvent } from '../../types.js';

/** The smallest thing that is a tier, so the wrapper can be exercised alone. */
class ProbeTier extends BaseTier {
  protected router: CascadeRouter;
  constructor(router: CascadeRouter) {
    super('T3');
    this.router = router;
  }
  seed(model: string) { this.setServingModel(model); }
  call() { return this.generateTracked('T3', { messages: [] } as never); }
  finish() { this.setStatus('COMPLETED'); }
}

function routerReturning(result: unknown): CascadeRouter {
  return { generate: vi.fn().mockResolvedValue(result) } as unknown as CascadeRouter;
}

describe('a tier reports the model that actually answered', () => {
  it('adopts servedBy when the router failed over mid-call', async () => {
    // Tiers set servingModel from the model they SELECTED, before the call. The
    // router can fail over — and then the terminal status names a model that
    // never ran. cloud/server persists that onto the assistant message, and
    // /why and thumbs feedback read it back, so the credit goes to the wrong
    // model and the performance history learns something untrue about two.
    const tier = new ProbeTier(routerReturning({
      content: 'x', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
      servedBy: { provider: 'anthropic', id: 'claude-opus-4-5' },
    }));
    tier.seed('openai:gpt-4o');

    await tier.call();

    const seen: TierStatusEvent[] = [];
    tier.on('tier:status', (e: TierStatusEvent) => seen.push(e));
    tier.finish();

    expect(tier.getServingModel()).toBe('anthropic:claude-opus-4-5');
    expect(seen[0]?.model).toBe('anthropic:claude-opus-4-5');
  });

  it('leaves the selected model alone when no failover happened', async () => {
    const tier = new ProbeTier(routerReturning({
      content: 'x', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
      servedBy: { provider: 'openai', id: 'gpt-4o' },
    }));
    tier.seed('openai:gpt-4o');

    await tier.call();

    expect(tier.getServingModel()).toBe('openai:gpt-4o');
  });

  it('keeps the selected model when the router reports nothing', async () => {
    // A provider path that predates servedBy must not blank the attribution.
    const tier = new ProbeTier(routerReturning({
      content: 'x', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    }));
    tier.seed('openai:gpt-4o');

    await tier.call();

    expect(tier.getServingModel()).toBe('openai:gpt-4o');
  });

  it('the fast path does not record a failover the router already recorded', () => {
    // The router emits `failover` for the transition and Cascade.init()
    // installs a listener that writes it to the decision trail. runFastAnswer
    // briefly wrote a second entry for the same switch, so /why showed the
    // transition twice and anything counting trail entries was inflated.
    //
    // Structural, and deliberately so: what needs preventing is a future
    // caller re-adding its own entry beside the listener's, which is a
    // property of the source rather than of any one run.
    const src = readFileSync(new URL('../cascade.ts', import.meta.url), 'utf-8');
    const fastAnswer = src.slice(src.indexOf('private async runFastAnswer'));
    expect(fastAnswer).not.toMatch(/recordDecision\(\s*'failover'/);
  });

  it('no tier calls router.generate directly, bypassing the attribution', () => {
    // The wrapper only works if everything goes through it. A new call site
    // added straight onto the router would silently reintroduce the bug, so
    // this is asserted structurally rather than trusted to review.
    for (const f of ['t1-administrator', 't2-manager', 't3-worker']) {
      const src = readFileSync(new URL(`./${f}.ts`, import.meta.url), 'utf-8');
      expect(src, `${f} should call generateTracked, not router.generate`)
        .not.toMatch(/this\.router\.generate\(/);
    }
  });
});
