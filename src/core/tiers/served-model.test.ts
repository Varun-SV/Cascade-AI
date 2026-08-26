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

  it('a grading call does not steal the answer model\'s attribution', async () => {
    // Graders and critics run beside the answer, deliberately on a different
    // model — the T2 critic exists so a model is not marking its own work.
    // Routing those through the tracker let the last grading call overwrite
    // servingModel, so the subtask output, its terminal status and the
    // feedback history all named the grader.
    class AuxTier extends BaseTier {
      protected router: CascadeRouter;
      constructor(router: CascadeRouter) { super('T3'); this.router = router; }
      answer() { return this.generateTracked('T3', { messages: [] } as never); }
      grade() { return this.generateAuxiliary('T2', { messages: [] } as never); }
    }
    let served = { provider: 'openai', id: 'the-answer-model' };
    const router = {
      generate: vi.fn().mockImplementation(() => Promise.resolve({
        content: 'x', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
        servedBy: served,
      })),
    } as unknown as CascadeRouter;

    const tier = new AuxTier(router);
    await tier.answer();
    expect(tier.getServingModel()).toBe('openai:the-answer-model');

    served = { provider: 'anthropic', id: 'the-critic-model' };
    await tier.grade();

    expect(tier.getServingModel()).toBe('openai:the-answer-model');
  });

  it('the graders in t3-worker do not run through the tracker', () => {
    // Which calls are auxiliary is a judgement about each site, so it is
    // pinned here: the critic verdict, the self-test and the knowledge
    // extractor grade or summarise the answer; 853 and the post-critique
    // rewrite PRODUCE it and must keep attribution.
    const src = readFileSync(new URL('./t3-worker.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/const verdictResult = await this\.generateAuxiliary\(/);
    expect(src).toMatch(/const testResult = await this\.generateAuxiliary\(/);
    // …while the answer and its rewrite stay tracked.
    expect(src).toMatch(/const improved = await this\.generateTracked\(/);
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
