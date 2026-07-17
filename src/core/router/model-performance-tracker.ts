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

interface ModelStat {
  successCount: number;
  failureCount: number;
  totalRetries: number;
  totalCostUsd: number;
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
  ): void {
    if (this.readOnly) return; // opted out — read scores, don't contribute
    const key = `${modelId}:${taskType}`;
    const s = this.stats.get(key) ?? {
      successCount: 0, failureCount: 0, totalRetries: 0, totalCostUsd: 0, sampleCount: 0,
      totalContextTokens: 0, failureContextTokens: 0,
    };
    this.stats.set(key, {
      successCount: s.successCount + (outcome === 'success' ? 1 : 0),
      failureCount: s.failureCount + (outcome === 'failure' ? 1 : 0),
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
   * Record an explicit user rating (good/bad). Counts as 3 automatic samples
   * so user feedback carries significantly more weight than auto-detected outcomes.
   */
  recordExplicit(modelId: string, taskType: TaskType, rating: 'good' | 'bad', costUsd = 0): void {
    const outcome = rating === 'good' ? 'success' : 'failure';
    // 3× weight: call record three times
    this.record(modelId, taskType, outcome, 0, costUsd);
    this.record(modelId, taskType, outcome, 0, 0);
    this.record(modelId, taskType, outcome, 0, 0);
  }

  /** Returns all stats keyed by "modelId:taskType" — used by `cascade stats`. */
  getAll(): Map<string, ModelStat> {
    return new Map(this.stats);
  }

  getAllFeatures(): Map<string, FeatureStat> {
    return new Map(this.featureStats);
  }

  /**
   * Returns 0.05–1.0; defaults to 0.5 (neutral prior) when no history exists.
   * High retry counts penalise the score.
   */
  performanceScore(modelId: string, taskType: TaskType): number {
    const key = `${modelId}:${taskType}`;
    const s = this.stats.get(key);
    if (!s || s.sampleCount === 0) return 0.5;
    const successRate = s.successCount / s.sampleCount;
    const avgRetries = s.totalRetries / s.sampleCount;
    const retryPenalty = Math.min(0.4, avgRetries / 3);
    return Math.max(0.05, successRate * (1 - retryPenalty));
  }

  /**
   * Returns 0.1–1.0. Cheaper models score higher, with the penalty scaled
   * down for complex tasks (where capability matters more than cost).
   *
   * blended cost = input + 2 × output (output tokens are typically pricier).
   * normalised over $0.05 blended as the "expensive" ceiling.
   */
  costEfficiencyScore(model: ModelInfo, complexity: 1 | 2 | 3 | 4 | 5): number {
    const blended = model.inputCostPer1kTokens + model.outputCostPer1kTokens * 2;
    const normalised = Math.min(1.0, blended / 0.05);
    // complexityWeight: 1.0 for trivial tasks → 0.2 for research-grade
    const complexityWeight = (6 - complexity) / 5;
    return Math.max(0.1, 1 - normalised * complexityWeight);
  }
}
