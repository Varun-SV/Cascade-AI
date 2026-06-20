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
}

const DEFAULT_STATS_FILE = path.join(os.homedir(), '.cascade', 'model-perf.json');

export class ModelPerformanceTracker {
  private stats = new Map<string, ModelStat>();
  private readonly statsFile: string;
  private loaded = false;

  constructor(statsFile = DEFAULT_STATS_FILE) {
    this.statsFile = statsFile;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.statsFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, ModelStat>;
      for (const [key, stat] of Object.entries(parsed)) {
        this.stats.set(key, stat);
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.statsFile), { recursive: true });
      const obj: Record<string, ModelStat> = {};
      for (const [key, stat] of this.stats) obj[key] = stat;
      await fs.writeFile(this.statsFile, JSON.stringify(obj, null, 2), 'utf-8');
    } catch { /* non-critical */ }
  }

  record(
    modelId: string,
    taskType: TaskType,
    outcome: 'success' | 'failure',
    retries = 0,
    costUsd = 0,
  ): void {
    const key = `${modelId}:${taskType}`;
    const s = this.stats.get(key) ?? {
      successCount: 0, failureCount: 0, totalRetries: 0, totalCostUsd: 0, sampleCount: 0,
    };
    this.stats.set(key, {
      successCount: s.successCount + (outcome === 'success' ? 1 : 0),
      failureCount: s.failureCount + (outcome === 'failure' ? 1 : 0),
      totalRetries: s.totalRetries + retries,
      totalCostUsd: s.totalCostUsd + costUsd,
      sampleCount: s.sampleCount + 1,
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
