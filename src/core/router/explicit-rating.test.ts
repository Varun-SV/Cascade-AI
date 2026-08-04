import { describe, expect, it } from 'vitest';
import { TaskAnalyzer } from './task-analyzer.js';

/** Minimal tracker double capturing what actually reaches persistence. */
function makeTracker() {
  const auto: string[] = [];
  const explicit: Array<{ modelId: string; rating: string }> = [];
  return {
    auto,
    explicit,
    record: (modelId: string) => { auto.push(modelId); },
    recordExplicit: (modelId: string, _t: string, rating: string) => { explicit.push({ modelId, rating }); },
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

  it('reports false when there is genuinely no completed run to rate', () => {
    const tracker = makeTracker();
    const analyzer = new TaskAnalyzer(tracker as never);
    expect(analyzer.recordExplicitRating('good')).toBe(false);
    expect(tracker.explicit).toEqual([]);
  });
});
