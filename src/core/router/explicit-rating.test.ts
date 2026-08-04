import { describe, expect, it } from 'vitest';
import { TaskAnalyzer } from './task-analyzer.js';

/** Minimal tracker double capturing what actually reaches persistence. */
function makeTracker() {
  const auto: string[] = [];
  const explicit: Array<{ modelId: string; rating: string }> = [];
  const explicitTyped: Array<{ modelId: string; taskType: string; rating: string }> = [];
  return {
    auto,
    explicit,
    explicitTyped,
    record: (modelId: string) => { auto.push(modelId); },
    recordExplicit: (modelId: string, taskType: string, rating: string) => {
      explicit.push({ modelId, rating });
      explicitTyped.push({ modelId, taskType, rating });
    },
    save: async () => {},
    getStats: () => undefined,
    performanceScore: () => 0.5,
    costEfficiencyScore: () => 0.5,
  };
}

describe('explicit ratings after a completed run', () => {
  it('still has models to rate once the run finalizer has recorded the outcome', async () => {
    // Regression: recordRunOutcome() cleared the ONLY selections map, and
    // rateLastRun() is by nature called afterwards — so every explicit rating
    // iterated an empty map, recorded nothing, and returned false. The 3x-weighted
    // user signal never reached the tracker at all.
    const tracker = makeTracker();
    const analyzer = new TaskAnalyzer(tracker as never);
    await analyzer.analyze('Refactor the auth module and add tests');

    const model = { id: 'model-a', provider: 'openai', contextWindow: 8000, tags: [] };
    const selector = {
      selectForTier: () => model,
      selectVisionModel: () => model,
      getCandidatesForTier: () => [model],
    } as never;
    await analyzer.selectModel('Refactor the auth module and add tests', 'T3', selector);

    analyzer.recordRunOutcome('success', { T3: 0.01 });
    expect(tracker.auto.length).toBeGreaterThan(0);

    const rated = analyzer.recordExplicitRating('good');
    expect(rated).toBe(true);
    expect(tracker.explicit).toEqual([{ modelId: 'model-a', rating: 'good' }]);
  });

  it('records a vision-routed selection — every exit must reach the snapshot', async () => {
    // selectModel() had two early returns that never wrote to the selections
    // map, so a vision run had nothing to rate at all and a fallback selection
    // was silently missing from the feedback meant to teach the router.
    const tracker = makeTracker();
    const analyzer = new TaskAnalyzer(tracker as never);
    const vision = { id: 'vision-model', provider: 'openai', contextWindow: 8000, tags: [] };
    const selector = {
      selectForTier: () => vision,
      selectVisionModel: () => vision,
      getCandidatesForTier: () => [vision],
    } as never;

    await analyzer.selectModel('Describe this screenshot image in detail', 'T3', selector);
    analyzer.recordRunOutcome('success', { T3: 0 });

    expect(analyzer.recordExplicitRating('good')).toBe(true);
    expect(tracker.explicit).toEqual([{ modelId: 'vision-model', rating: 'good' }]);
  });

  it('records a fallback selection when the tier has no candidates', async () => {
    const tracker = makeTracker();
    const analyzer = new TaskAnalyzer(tracker as never);
    const fallback = { id: 'fallback-model', provider: 'openai', contextWindow: 8000, tags: [] };
    const selector = {
      selectForTier: () => fallback,
      selectVisionModel: () => fallback,
      getCandidatesForTier: () => [],   // nothing eligible for this tier
    } as never;

    await analyzer.selectModel('Refactor the auth module', 'T3', selector);
    analyzer.recordRunOutcome('success', { T3: 0 });

    expect(analyzer.recordExplicitRating('good')).toBe(true);
    expect(tracker.explicit).toEqual([{ modelId: 'fallback-model', rating: 'good' }]);
  });

  it('counts a run once, however many times the button is pressed', async () => {
    // recordExplicit() weights a rating 3x by recording three samples, so a
    // double submit injected six — a stutter would count as two opinions.
    const tracker = makeTracker();
    const analyzer = new TaskAnalyzer(tracker as never);
    const model = { id: 'model-a', provider: 'openai', contextWindow: 8000, tags: [] };
    const selector = {
      selectForTier: () => model,
      selectVisionModel: () => model,
      getCandidatesForTier: () => [model],
    } as never;
    await analyzer.selectModel('Refactor the auth module', 'T3', selector);
    analyzer.recordRunOutcome('success', { T3: 0 });

    expect(analyzer.recordExplicitRating('good')).toBe(true);
    expect(analyzer.recordExplicitRating('good')).toBe(false);
    expect(analyzer.recordExplicitRating('bad')).toBe(false);
    expect(tracker.explicit).toHaveLength(1);
  });

  it('credits a rating to the task type the run actually had', async () => {
    // lastProfile is overwritten by the NEXT analyze(), so a run B that starts
    // before the user rates run A used to record A's models under B's task type
    // — teaching the router a coding model is good at creative writing, from a
    // rating that never said so.
    const tracker = makeTracker();
    const analyzer = new TaskAnalyzer(tracker as never);
    const model = { id: 'code-model', provider: 'openai', contextWindow: 8000, tags: [] };
    const selector = {
      selectForTier: () => model,
      selectVisionModel: () => model,
      getCandidatesForTier: () => [model],
    } as never;

    // Run A: a code task, completed.
    await analyzer.selectModel('Refactor the auth module, fix the failing test, and export the class', 'T3', selector);
    const codeType = analyzer.getLastProfile()?.type;
    expect(codeType).toBe('code');
    analyzer.recordRunOutcome('success', { T3: 0 });

    // Run B begins and re-analyzes with a very different prompt...
    await analyzer.analyze('Write a persuasive marketing blog post, imaginative and narrative in style');
    expect(analyzer.getLastProfile()?.type).not.toBe('code');

    // ...then the user finally rates run A. It must still count as code.
    expect(analyzer.recordExplicitRating('good')).toBe(true);
    expect(tracker.explicitTyped).toEqual([{ modelId: 'code-model', taskType: 'code', rating: 'good' }]);
  });

  it('counts one opinion once when the same model serves several tiers', async () => {
    // The tracker is keyed (modelId, taskType) — tier is NOT part of the key.
    // One model on T1+T2+T3 (the ordinary single-local-model setup) meant three
    // recordExplicit calls, each recording three samples for its 3x weighting:
    // nine samples from one thumbs-up.
    const tracker = makeTracker();
    const analyzer = new TaskAnalyzer(tracker as never);
    const model = { id: 'solo-model', provider: 'ollama', contextWindow: 8000, tags: [] };
    const selector = {
      selectForTier: () => model,
      selectVisionModel: () => model,
      getCandidatesForTier: () => [model],
    } as never;

    for (const tier of ['T1', 'T2', 'T3'] as const) {
      await analyzer.selectModel('Refactor the auth module', tier, selector);
    }
    analyzer.recordRunOutcome('success', { T1: 0, T2: 0, T3: 0 });

    expect(analyzer.recordExplicitRating('good')).toBe(true);
    expect(tracker.explicit).toEqual([{ modelId: 'solo-model', rating: 'good' }]);
  });

  it('reports false when there is genuinely no completed run to rate', () => {
    const tracker = makeTracker();
    const analyzer = new TaskAnalyzer(tracker as never);
    expect(analyzer.recordExplicitRating('good')).toBe(false);
    expect(tracker.explicit).toEqual([]);
  });
});
