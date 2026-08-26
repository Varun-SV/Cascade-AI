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

/** A selector whose candidates DIFFER per tier, so notes are distinguishable. */
function selectorPerTier(byTier: Record<string, ModelInfo[]>): ModelSelector {
  return {
    getCandidatesForTier: (tier: string) => byTier[tier] ?? [],
    selectForTier: (tier: string) => byTier[tier]?.[0] ?? null,
    selectVisionModel: () => null,
  } as unknown as ModelSelector;
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
      note = (await analyzer.select(codePrompt(i), 'T3', selector)).note;
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
    const only = await analyzer.select(codePrompt(0), 'T3', selectorOver([model('only')]));

    expect(only.note).toBeNull();
  });

  it('gives each concurrent selection its own note', async () => {
    // Cascade.run selects every tier in play CONCURRENTLY — Promise.all over
    // the tiers, all against one analyzer. While the note lived on the
    // instance, three interleaved calls wrote one field and three
    // continuations read it in an order nothing established: /why could
    // attribute one tier's exploration to another and drop the rest. Clearing
    // the field per call did not fix that, it only fixed the sequential case.
    //
    // The candidate sets differ PER TIER deliberately. With one shared set,
    // every tier's note is the same string, so a note delivered to the wrong
    // tier is indistinguishable from the right one and this test passes
    // against the very bug it is supposed to catch — which is exactly what the
    // first draft of it did.
    const tracker = mem();
    for (const t of ['1', '2', '3']) {
      for (let i = 0; i < 5; i++) tracker.record(`incumbent${t}`, 'code', 'success');
    }
    const analyzer = new TaskAnalyzer(tracker);
    analyzer.setRng(seeded(2718));
    const selector = selectorPerTier({
      T1: [model('untried1'), model('incumbent1')],
      T2: [model('untried2'), model('incumbent2')],
      T3: [model('untried3'), model('incumbent3')],
    });

    let explored = 0;
    for (let i = 0; i < 300; i++) {
      TaskAnalyzer.clearCache();
      const batch = await Promise.all((['T1', 'T2', 'T3'] as const).map(async (tier) => {
        const sel = await analyzer.select(codePrompt(i), tier, selector);
        return { tier, id: sel.model?.id, note: sel.note };
      }));
      for (const b of batch) {
        // A note must name the model ITS OWN call chose. A note naming another
        // tier's model is the shared-field bug, and a note where the call did
        // not explore is the same bug wearing the other face.
        if (b.note) {
          explored++;
          expect(b.note, `${b.tier} got a note for ${b.id}`).toContain(b.id!);
          expect(b.note).toContain(b.tier.slice(1)); // tier-suffixed model ids
        }
      }
    }
    expect(explored, 'needed at least one exploratory pick to check attribution').toBeGreaterThan(0);
  });

  it('says nothing about a selection that did not explore', async () => {
    const tracker = mem();
    for (let i = 0; i < 300; i++) tracker.record('incumbent', 'code', 'success');
    const analyzer = new TaskAnalyzer(tracker);
    analyzer.setRng(seeded(2718));
    const selector = selectorOver([model('untried'), model('incumbent')]);

    for (let i = 0; i < 50; i++) {
      TaskAnalyzer.clearCache();
      const sel = await analyzer.select(codePrompt(i), 'T3', selector);
      if (sel.model?.id === 'incumbent') expect(sel.note).toBeNull();
    }
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

describe('an explored model learns from having been tried', () => {
  it('records the outcome for every model a tier used, not just the last', async () => {
    // Without this, exploration is a one-way door. `currentRunSelections` was
    // keyed Map<tier, model> and overwritten per selection — harmless while
    // argmax made every subtask in a tier pick the same model, and silently
    // wrong the moment selection started sampling. The explored model ran, and
    // then recorded nothing: no evidence, so its posterior never narrows, so it
    // is explored again forever and its trial never taught anyone anything.
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);

    // Two subtasks in ONE tier landing on different models, both of which ran —
    // exactly what a sampled selection produces.
    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(1), 'T3', selectorOver([model('alpha')]));
    analyzer.noteAttempted('T3', 'alpha');
    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(2), 'T3', selectorOver([model('beta')]));
    analyzer.noteAttempted('T3', 'beta');

    analyzer.recordRunOutcome('success', { T3: 0.09 });

    expect(tracker.sampleCountFor('alpha', 'code'), 'the earlier model must not be forgotten').toBe(1);
    expect(tracker.sampleCountFor('beta', 'code')).toBe(1);
  });

  it('splits a tier’s cost across the models that served it', async () => {
    // Charging each model the whole tier cost would multiply recorded spend by
    // the number of models used and make an explored model look ruinous purely
    // for having been tried.
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);

    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(1), 'T3', selectorOver([model('alpha')]));
    analyzer.noteAttempted('T3', 'alpha');
    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(2), 'T3', selectorOver([model('beta')]));
    analyzer.noteAttempted('T3', 'beta');

    analyzer.recordRunOutcome('success', { T3: 0.10 });

    const spend = (id: string) => tracker.getAll().get(`${id}:code`)?.totalCostUsd ?? 0;
    expect(spend('alpha') + spend('beta')).toBeCloseTo(0.10, 6);
  });

  it('does not double-count a model a tier used twice', async () => {
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);
    const selector = selectorOver([model('alpha')]);

    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(1), 'T3', selector);
    analyzer.noteAttempted('T3', 'alpha');
    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(2), 'T3', selector);
    analyzer.noteAttempted('T3', 'alpha');

    analyzer.recordRunOutcome('success', { T3: 0.04 });
    expect(tracker.sampleCountFor('alpha', 'code')).toBe(1);
  });
});

describe('a model is credited for the work it actually did', () => {
  it('records each selection under the task type it was chosen for', async () => {
    // One run is not one task type. `lastProfile` is whatever the LAST
    // selection analysed, so crediting the whole run to it teaches the router
    // that the model which wrote the closing prose is good at code — from an
    // observation that never said so.
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);

    TaskAnalyzer.clearCache();
    await analyzer.select('refactor the parser function', 'T3', selectorOver([model('coder')]));
    analyzer.noteAttempted('T3', 'coder');
    TaskAnalyzer.clearCache();
    await analyzer.select('write a short poem about the sea', 'T3', selectorOver([model('writer')]));
    analyzer.noteAttempted('T3', 'writer');

    analyzer.recordRunOutcome('success', { T3: 0.06 });

    expect(tracker.sampleCountFor('coder', 'code'), 'the coding subtask').toBe(1);
    expect(tracker.sampleCountFor('coder', 'creative'), 'must not be credited as prose').toBe(0);
    expect(tracker.sampleCountFor('writer', 'creative')).toBe(1);
  });

  it('rates each model under the type it served, not the run’s last profile', async () => {
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);

    TaskAnalyzer.clearCache();
    await analyzer.select('refactor the parser function', 'T3', selectorOver([model('coder')]));
    analyzer.noteAttempted('T3', 'coder');
    TaskAnalyzer.clearCache();
    await analyzer.select('write a short poem about the sea', 'T3', selectorOver([model('writer')]));
    analyzer.noteAttempted('T3', 'writer');
    analyzer.recordRunOutcome('success', { T3: 0 });

    expect(analyzer.recordExplicitRating('good')).toBe(true);
    // 1 automatic + 1 rated observation each, under their own types.
    expect(tracker.sampleCountFor('coder', 'code')).toBe(2);
    expect(tracker.sampleCountFor('coder', 'creative')).toBe(0);
    expect(tracker.sampleCountFor('writer', 'creative')).toBe(2);
  });
});

describe('the score floor does not become a bonus', () => {
  it('never amplifies a draw for a model with a long failure record', async () => {
    // performanceScore floors at 0.05. Recovering the retry factor as
    // performanceScore / posteriorMean therefore stops being the retry factor
    // once the mean falls under the floor — around 37 straight failures — and
    // becomes 0.05/mean, which GROWS without limit as the model gets worse.
    // 100 failures multiplied every draw by 2.6; 300 by 7.6. The worst models
    // in the catalogue were the ones getting their draws inflated.
    const tracker = mem();
    for (let i = 0; i < 300; i++) tracker.record('hopeless', 'code', 'failure');

    const analyzer = new TaskAnalyzer(tracker);
    analyzer.setRng(seeded(4242));
    const perfFor = (a: TaskAnalyzer) => (a as unknown as {
      perfFor(m: ModelInfo, p: { type: string }, mode: string): number;
    }).perfFor(model('hopeless'), { type: 'code' } as never, 'sample');

    // No retries were recorded, so a draw must not be scaled at all — and can
    // never exceed the belief floor by more than the floor itself allows.
    for (let i = 0; i < 200; i++) {
      const v = perfFor(analyzer);
      expect(v).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it('still applies a real retry penalty to a model that is not floored', async () => {
    const clean = mem();
    const retried = mem();
    for (let i = 0; i < 20; i++) {
      clean.record('m', 'code', 'success', 0);
      retried.record('m', 'code', 'success', 3);
    }
    expect(retried.retryFactorFor('m', 'code')).toBeCloseTo(0.6, 5);
    expect(clean.retryFactorFor('m', 'code')).toBe(1);
  });
});

describe('only a model that actually ran is rated', () => {
  it('ignores a selection that never reached a provider', async () => {
    // A rejected plan, a cancelled subtask, or a tier default that per-work
    // routing replaced: all leave a selection behind that never ran. Three
    // successive attempts to infer this from the selections themselves were
    // each wrong in a way the next exposed — the last of them read
    // `costByTier`, which beginRun() never clears, so after a tier ran once
    // every later run looked like it ran too.
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);

    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(1), 'T1', selectorOver([model('planner')]));
    analyzer.noteAttempted('T1', 'planner');
    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(2), 'T3', selectorOver([model('never-ran')]));

    // A cost key for T3 is NOT evidence that T3 ran — it survives from earlier
    // runs in the same session. Only noteAttempted() is.
    analyzer.recordRunOutcome('failure', { T1: 0.01, T3: 0.02 });

    expect(tracker.sampleCountFor('planner', 'code')).toBe(1);
    expect(tracker.sampleCountFor('never-ran', 'code'), 'served zero calls').toBe(0);
  });

  it('does not let a rating credit a model that never ran either', async () => {
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);

    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(1), 'T1', selectorOver([model('planner')]));
    analyzer.noteAttempted('T1', 'planner');
    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(2), 'T3', selectorOver([model('never-ran')]));
    analyzer.recordRunOutcome('failure', { T1: 0, T3: 0 });

    expect(analyzer.recordExplicitRating('good')).toBe(true);
    expect(tracker.sampleCountFor('never-ran', 'code')).toBe(0);
  });

  it('rates a tier default that did serve the call', async () => {
    // The other direction, which matters just as much: when no per-work
    // selection replaces it, the root pick IS the model that runs and dropping
    // it would lose the run entirely.
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);

    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(1), 'T3', selectorOver([model('served')]));
    analyzer.noteAttempted('T3', 'served');
    analyzer.recordRunOutcome('success', { T3: 0.03 });

    expect(tracker.sampleCountFor('served', 'code')).toBe(1);
  });

  it('ignores a served model it never selected', async () => {
    // A pinned tier or a failover replacement reaches a provider without this
    // analyzer having chosen it. Rating it would be an opinion about a decision
    // the router did not make.
    const tracker = mem();
    const analyzer = new TaskAnalyzer(tracker);

    TaskAnalyzer.clearCache();
    await analyzer.select(codePrompt(1), 'T3', selectorOver([model('chosen')]));
    analyzer.noteAttempted('T3', 'chosen');
    analyzer.noteAttempted('T3', 'some-failover-model');
    analyzer.recordRunOutcome('success', { T3: 0.01 });

    expect(tracker.sampleCountFor('chosen', 'code')).toBe(1);
    expect(tracker.sampleCountFor('some-failover-model', 'code')).toBe(0);
  });
});
