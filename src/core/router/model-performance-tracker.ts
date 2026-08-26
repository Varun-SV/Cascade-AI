// ─────────────────────────────────────────────
//  Cascade AI — Model Performance Tracker
// ─────────────────────────────────────────────
//
//  Non-AI auto-updating model selection support.
//  Records per-(model, taskType) outcomes across sessions and returns
//  numeric scores that drive cost-efficient model selection.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ModelInfo } from '../../types.js';
import type { TaskType } from './task-analyzer.js';
import { BLENDED_COST_CEILING, blendedCostPer1k } from './pricing.js';
import { posteriorMean, weightedPosterior, type BetaPosterior } from './bayes.js';

interface ModelStat {
  /**
   * Success and failure EVIDENCE, weighted — not observation counts.
   *
   * An explicit thumbs-up is worth more than "the HTTP call did not error",
   * and that difference is expressed here, in the evidence, where a Beta
   * posterior can read it. It used to be expressed by recording the same
   * observation three times, which also tripled `sampleCount` — so the one
   * number everything else treats as "how much do we know about this model"
   * was inflated by a factor of three every time somebody clicked a thumb.
   */
  successCount: number;
  failureCount: number;
  totalRetries: number;
  totalCostUsd: number;
  /** How many times this model was actually OBSERVED. Confidence, not score. */
  sampleCount: number;
  /** Sum of input/context tokens across samples — so we can see whether a
   *  model tends to fail on larger contexts and route less to it accordingly. */
  totalContextTokens: number;
  /** Sum of context tokens on the FAILED samples only. */
  failureContextTokens: number;
}

interface FeatureStat {
  totalCostUsd: number;
  runCount: number;
}

const DEFAULT_STATS_FILE = path.join(os.homedir(), '.cascade', 'model-perf.json');

export class ModelPerformanceTracker {
  private stats = new Map<string, ModelStat>();
  private featureStats = new Map<string, FeatureStat>();
  private readonly statsFile: string;
  private readonly readOnly: boolean;
  private loaded = false;

  /**
   * @param statsFile where stats persist (cloud → the persistent volume).
   * @param options.readOnly consume the shared scores but don't record/save this
   *        run's outcomes — the opt-out path for users who declined to contribute.
   */
  constructor(statsFile = DEFAULT_STATS_FILE, options: { readOnly?: boolean } = {}) {
    this.statsFile = statsFile;
    this.readOnly = options.readOnly ?? false;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.statsFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown> & { models?: Record<string, ModelStat>; features?: Record<string, FeatureStat> };
      if (parsed.models) {
        for (const [key, stat] of Object.entries(parsed.models)) this.stats.set(key, stat);
      } else {
        // Fallback for the old flat format: { "modelId:taskType": ModelStat }.
        for (const [key, stat] of Object.entries(parsed)) {
          if (stat && typeof stat === 'object' && typeof (stat as ModelStat).successCount === 'number') {
            this.stats.set(key, stat as ModelStat);
          }
        }
      }
      if (parsed.features) {
        for (const [key, stat] of Object.entries(parsed.features)) this.featureStats.set(key, stat);
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  async save(): Promise<void> {
    if (this.readOnly) return; // opted out — never write this user's outcomes
    try {
      await fs.mkdir(path.dirname(this.statsFile), { recursive: true });
      const modelsObj: Record<string, ModelStat> = {};
      const featuresObj: Record<string, FeatureStat> = {};
      for (const [key, stat] of this.stats) modelsObj[key] = stat;
      for (const [key, stat] of this.featureStats) featuresObj[key] = stat;
      const json = JSON.stringify({ models: modelsObj, features: featuresObj }, null, 2);
      // Atomic write (temp + rename) so concurrent writers on the shared cloud
      // file never observe a half-written, corrupt JSON — the rename swaps the
      // file in whole. A per-process temp suffix avoids two writers colliding on
      // the same temp path. Worst case under contention is a lost increment
      // (last rename wins), never a corrupt file.
      const tmp = `${this.statsFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, json, 'utf-8');
      await fs.rename(tmp, this.statsFile);
    } catch { /* non-critical */ }
  }

  record(
    modelId: string,
    taskType: TaskType,
    outcome: 'success' | 'failure',
    retries = 0,
    costUsd = 0,
    contextTokens = 0,
    /**
     * How much this observation counts as EVIDENCE. One for an automatic
     * outcome; more for a signal we trust further. It never touches
     * sampleCount: one thing happened, however much it tells us.
     */
    weight = 1,
  ): void {
    if (this.readOnly) return; // opted out — read scores, don't contribute
    const key = `${modelId}:${taskType}`;
    const s = this.stats.get(key) ?? {
      successCount: 0, failureCount: 0, totalRetries: 0, totalCostUsd: 0, sampleCount: 0,
      totalContextTokens: 0, failureContextTokens: 0,
    };
    const w = Math.max(0, weight);
    this.stats.set(key, {
      successCount: s.successCount + (outcome === 'success' ? w : 0),
      failureCount: s.failureCount + (outcome === 'failure' ? w : 0),
      totalRetries: s.totalRetries + retries,
      totalCostUsd: s.totalCostUsd + costUsd,
      sampleCount: s.sampleCount + 1,
      totalContextTokens: (s.totalContextTokens ?? 0) + Math.max(0, contextTokens),
      failureContextTokens: (s.failureContextTokens ?? 0) + (outcome === 'failure' ? Math.max(0, contextTokens) : 0),
    });
  }

  recordFeatureCost(featureTag: string, costUsd: number): void {
    if (this.readOnly) return;
    const s = this.featureStats.get(featureTag) ?? { totalCostUsd: 0, runCount: 0 };
    this.featureStats.set(featureTag, {
      totalCostUsd: s.totalCostUsd + costUsd,
      runCount: s.runCount + 1,
    });
  }

  /**
   * Weight an explicit rating carries relative to an automatic outcome.
   *
   * An automatic outcome says only that the call completed; a person saying
   * "this was good" is about the thing routing actually cares about. Three is
   * the ratio this has always used — kept, now that it is expressed honestly.
   */
  static readonly EXPLICIT_RATING_WEIGHT = 3;

  /**
   * Record an explicit user rating (good/bad), worth EXPLICIT_RATING_WEIGHT
   * automatic outcomes.
   *
   * ONE observation carrying that weight, not three observations. Recording it
   * three times also tripled `sampleCount` — the count of how many times this
   * model was actually run, which the exploration note reports and the
   * lifecycle states will read. One click claimed three runs' worth of
   * history that never happened.
   *
   * The weight is spent on belief, relative to the evidence it competes with;
   * it does not buy confidence. A lone thumbs-up moves the score exactly as
   * far as a lone successful run (0.5 → 0.6) — what it buys is winning the
   * argument against automatic outcomes that disagree with it.
   */
  recordExplicit(modelId: string, taskType: TaskType, rating: 'good' | 'bad', costUsd = 0): void {
    const outcome = rating === 'good' ? 'success' : 'failure';
    this.record(modelId, taskType, outcome, 0, costUsd, 0, ModelPerformanceTracker.EXPLICIT_RATING_WEIGHT);
  }

  /** Returns all stats keyed by "modelId:taskType" — used by `cascade stats`. */
  getAll(): Map<string, ModelStat> {
    return new Map(this.stats);
  }

  getAllFeatures(): Map<string, FeatureStat> {
    return new Map(this.featureStats);
  }

  /**
   * Whether outcomes recorded here go anywhere.
   *
   * A read-only tracker (routing.learnFromOutcomes = false) reads the shared
   * scores but drops every observation — not just the write to disk, the
   * in-memory update too. Anything whose correctness depends on evidence
   * accumulating has to know that: see TaskAnalyzer.perfFor, where sampling a
   * posterior that can never narrow means exploring forever.
   */
  learnsFromOutcomes(): boolean {
    return !this.readOnly;
  }

  /**
   * The Beta posterior over this model's success rate for this task type.
   *
   * Exposed as the posterior rather than a number so callers can ask the two
   * different questions it answers: what we believe (the mean, for ranking)
   * and how little we know (the spread, for deciding whether to explore).
   * Collapsing it to a scalar here is what made those inseparable.
   */
  posteriorFor(modelId: string, taskType: TaskType): BetaPosterior {
    const s = this.stats.get(`${modelId}:${taskType}`);
    // Weight decides where this sits, observation count decides how tight it
    // is — see weightedPosterior. Passing the weights straight in would make
    // one thumbs-up narrow the posterior exactly as much as three runs, which
    // is the "count is confidence" error wearing different clothes.
    return weightedPosterior(s?.successCount ?? 0, s?.failureCount ?? 0, s?.sampleCount ?? 0);
  }

  /**
   * The observed success rate, 0–1 — what actually happened, unshrunk.
   *
   * For display (`cascade stats`), not for routing: routing wants
   * `performanceScore`, which is shrunk toward 0.5 by how little is known.
   *
   * Lives here rather than at the call site because the denominator is not
   * obvious and getting it wrong is silent. It is the EVIDENCE total, not
   * `sampleCount`: an explicit rating contributes 3 units of evidence on 1
   * observation, so dividing by the observation count renders a single
   * thumbs-up as "300%" — and anything sorting on that column then ranks the
   * impossible rates first.
   */
  observedSuccessRate(modelId: string, taskType: TaskType): number {
    const s = this.stats.get(`${modelId}:${taskType}`);
    if (!s) return 0;
    const evidence = s.successCount + s.failureCount;
    return evidence > 0 ? s.successCount / evidence : 0;
  }

  /** How many times this model was observed on this task type. */
  sampleCountFor(modelId: string, taskType: TaskType): number {
    return this.stats.get(`${modelId}:${taskType}`)?.sampleCount ?? 0;
  }

  /**
   * The retry cost as a multiplier in (0.6, 1] — 1.0 when a model never
   * retries, 0.6 when it retries three times or more on average.
   *
   * Exposed separately because it is genuinely a separate quantity from the
   * success rate, and because the alternative — recovering it by dividing
   * `performanceScore` by `posteriorMean` — silently stops being the retry
   * penalty at all once the score floor engages. See perfFor().
   */
  retryFactorFor(modelId: string, taskType: TaskType): number {
    const s = this.stats.get(`${modelId}:${taskType}`);
    if (!s || s.sampleCount === 0) return 1;
    const avgRetries = s.totalRetries / s.sampleCount;
    return 1 - Math.min(0.4, avgRetries / 3);
  }

  /**
   * Believed success rate, 0–1, shrunk toward 0.5 by how little is known.
   *
   * Replaces a raw successCount/sampleCount. That rate read one failure as 0%
   * — floored to 0.05, a 10x penalty against a benchmark range spanning about
   * 1.5x — so a single bad moment outweighed every measured quality difference
   * in the catalogue, and with nothing exploring, the model was never tried
   * again to find out otherwise. See bayes.ts for the numbers.
   *
   * The retry penalty survives unchanged: retries are a real cost that a
   * success/failure verdict does not capture.
   */
  performanceScore(modelId: string, taskType: TaskType): number {
    const s = this.stats.get(`${modelId}:${taskType}`);
    const mean = posteriorMean(this.posteriorFor(modelId, taskType));
    if (!s || s.sampleCount === 0) return mean;
    return Math.max(0.05, mean * this.retryFactorFor(modelId, taskType));
  }

  /**
   * Returns 0.1–1.0. Cheaper models score higher, with the penalty scaled
   * down for complex tasks (where capability matters more than cost).
   *
   * blended cost = input + 2 × output (output tokens are typically pricier).
   * normalised over $0.05 blended as the "expensive" ceiling.
   */
  costEfficiencyScore(model: ModelInfo, complexity: 1 | 2 | 3 | 4 | 5): number {
    // blendedCostPer1k returns the "expensive" ceiling for a model whose price
    // is unknown. Reading its 0s literally scored it as maximally cost-efficient
    // — the routing half of the zero-cost sentinel bug.
    const blended = blendedCostPer1k(model);
    const normalised = Math.min(1.0, blended / BLENDED_COST_CEILING);
    // complexityWeight: 1.0 for trivial tasks → 0.2 for research-grade
    const complexityWeight = (6 - complexity) / 5;
    return Math.max(0.1, 1 - normalised * complexityWeight);
  }
}
