// ─────────────────────────────────────────────
//  Cascade AI — exploration in model selection
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { TaskAnalyzer } from './task-analyzer.js';
import { ModelPerformanceTracker } from './model-performance-tracker.js';
import type { ModelSelector } from './selector.js';
import type { ModelInfo } from '../../types.js';
import type { Rng } from './bayes.js';

const mem = () => new ModelPerformanceTracker('/nonexistent/model-perf.json');

function model(id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id, name: id, provider: 'openai',
    contextWindow: 128_000, maxOutputTokens: 4096,
    inputCostPer1kTokens: 0.001, outputCostPer1kTokens: 0.002,
    isVisionCapable: false, supportsStreaming: true, isLocal: false,
    ...over,
  } as ModelInfo;
}

function selectorOver(models: ModelInfo[]): ModelSelector {
  return {
    getCandidatesForTier: () => models,
    selectForTier: () => models[0] ?? null,
    selectVisionModel: () => null,
  } as unknown as ModelSelector;
}

/**
 * Deterministic uniform stream.
 *
 * mulberry32, NOT xorshift32. xorshift32 seeded with a small integer opens
 * with badly biased output — seed 1 gives 0.0001, 0.0157, … — which is
 * invisible in a long-run mean but wrecks any test that reseeds and takes a
 * handful of draws. Two of these tests reseed per iteration.
 */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A prompt the heuristic analyser types as `code`, so the history recorded
 * under 'code' below is the history the selection actually reads.
 *
 * Not incidental: the first draft of these tests used "write some code", which
 * ties CODE_SIGNALS against CREATIVE_SIGNALS ("write") and analyses as `mixed`.
 * Every model then had an empty history, every selection was a coin flip, and
 * the tests failed in both directions at once — 48% exploration against an
 * incumbent on 300 successes, and none at all against an untried model. The
 * guard test below keeps that from being re-learned silently.
 */
const codePrompt = (i: number) => `refactor the parser function ${i}`;

/** How often `id` wins over `runs` selections, cache cleared between each. */
async function pickRate(
  analyzer: TaskAnalyzer,
  selector: ModelSelector,
  id: string,
  runs: number,
): Promise<number> {
  let picked = 0;
  for (let i = 0; i < runs; i++) {
    TaskAnalyzer.clearCache();
    const chosen = await analyzer.selectModel(codePrompt(i), 'T3', selector);
    if (chosen?.id === id) picked++;
  }
  return picked / runs;
}

describe('the fixture measures what it claims to', () => {
  it('routes the test prompt through the same task type the history is under', async () => {
    // If this drifts, every test below still runs and still passes or fails —
    // just against models with no history at all, which is a coin flip dressed
    // up as a measurement. Assert it once, loudly, rather than debugging the
    // symptoms again.
    const profile = await new TaskAnalyzer().analyze(codePrompt(0));
    expect(profile.type).toBe('code');
  });
});

describe('a model that failed once is not written off forever', () => {
  it('earns turns back from a lightly-established incumbent', async () => {
    // The absorbing state, as a behaviour: `perf` was
    // successCount/sampleCount floored at 0.05, so one failure ranked a model
    // below everything — and because selection was a pure argmax, nothing ever
    // routed to it again to find out whether that failure meant anything.
    const tracker = mem();
    tracker.record('unlucky', 'code', 'failure');
    for (let i = 0; i < 5; i++) tracker.record('incumbent', 'code', 'success');

    const analyzer = new TaskAnalyzer(tracker);
    analyzer.setRng(seeded(4242));
    const rate = await pickRate(
      analyzer, selectorOver([model('unlucky'), model('incumbent')]), 'unlucky', 400,
    );

    expect(rate, 'a once-failed model must be able to earn a turn back').toBeGreaterThan(0);
    // …but the incumbent still wins the clear majority. Otherwise this is not
    // exploration, it is ignoring the evidence.
    expect(rate).toBeLessThan(0.25);
  });

  it('explores less the better the incumbent is measured', async () => {
    // This IS the decay the design calls for, and the reason there is no rate
    // to tune: the posterior narrows as evidence arrives, so the draws stop
    // overlapping on their own. Asserted as an ordering across incumbent
    // strengths rather than against a magic threshold.
    const rateAgainst = async (incumbentWins: number) => {
      const tracker = mem();
      tracker.record('unlucky', 'code', 'failure');
      for (let i = 0; i < incumbentWins; i++) tracker.record('incumbent', 'code', 'success');
      const analyzer = new TaskAnalyzer(tracker);
      analyzer.setRng(seeded(31337));
      return pickRate(analyzer, selectorOver([model('unlucky'), model('incumbent')]), 'unlucky', 600);
    };

    const weak = await rateAgainst(2);
    const middling = await rateAgainst(10);
    const strong = await rateAgainst(40);

    expect(weak).toBeGreaterThan(middling);
    expect(middling).toBeGreaterThan(strong);
  });

  it('stops entirely once the evidence is overwhelming', async () => {
    const tracker = mem();
    for (let i = 0; i < 300; i++) {
      tracker.record('weak', 'code', 'failure');
      tracker.record('strong', 'code', 'success');
    }
    const analyzer = new TaskAnalyzer(tracker);
    analyzer.setRng(seeded(99));

    const rate = await pickRate(analyzer, selectorOver([model('weak'), model('strong')]), 'weak', 200);
    expect(rate).toBe(0);
  });
});

describe('an exploratory pick explains itself', () => {
  it('leaves a note naming what was tried and how little is known', async () => {
    const tracker = mem();
    for (let i = 0; i < 5; i++) tracker.record('incumbent', 'code', 'success');

    const analyzer = new TaskAnalyzer(tracker);
    analyzer.setRng(seeded(2718));
    const selector = selectorOver([model('untried'), model('incumbent')]);

    let note: string | null = null;
    for (let i = 0; i < 200 && !note; i++) {
      TaskAnalyzer.clearCache();
      await analyzer.selectModel(codePrompt(i), 'T3', selector);
      note = analyzer.takeExplorationNote();
    }

    expect(note, 'an untried model should be explored within 200 selections').toBeTruthy();
    expect(note).toContain('untried');
    expect(note).toContain('incumbent');
    expect(note).toContain('never used it for this');
  });

  it('says nothing when the pick was what the evidence already favoured', async () => {
    const analyzer = new TaskAnalyzer(mem());
    analyzer.setRng(seeded(7));

    TaskAnalyzer.clearCache();
    await analyzer.selectModel(codePrompt(0), 'T3', selectorOver([model('only')]));

    expect(analyzer.takeExplorationNote()).toBeNull();
  });

  it('consumes the note, so it cannot be blamed on a later selection', async () => {
    const tracker = mem();
    for (let i = 0; i < 5; i++) tracker.record('incumbent', 'code', 'success');
    const analyzer = new TaskAnalyzer(tracker);
    analyzer.setRng(seeded(2718));
    const selector = selectorOver([model('untried'), model('incumbent')]);

    let seen: string | null = null;
    for (let i = 0; i < 200 && !seen; i++) {
      TaskAnalyzer.clearCache();
      await analyzer.selectModel(codePrompt(i), 'T3', selector);
      seen = analyzer.takeExplorationNote();
    }
    expect(seen).toBeTruthy();
    expect(analyzer.takeExplorationNote()).toBeNull();
  });
});

describe('exploration does not launder a model past its costs', () => {
  it('still carries the retry penalty onto an explored draw', async () => {
    // A draw is a belief about the success rate, not an amnesty: a model that
    // needs three retries every time carries a real cost that a
    // success/failure verdict does not capture, and exploring must not hide it.
    const clean = mem();
    const retried = mem();
    clean.record('m', 'code', 'success', 0);
    retried.record('m', 'code', 'success', 3);

    const drawn = (t: ModelPerformanceTracker) => {
      const a = new TaskAnalyzer(t);
      a.setRng(seeded(11));
      return (a as unknown as {
        perfFor(m: ModelInfo, p: { type: string }, mode: string): number;
      }).perfFor(model('m'), { type: 'code' } as never, 'sample');
    };

    expect(drawn(retried)).toBeLessThan(drawn(clean));
  });
});
