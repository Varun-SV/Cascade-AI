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
  /**
   * How many of `sampleCount` were explicit ratings rather than runs. A rating is
   * an observation of the model, not another execution of it: run totals and
   * per-run costs leave it out. Absent in pools written before it was kept.
   */
  explicitCount?: number;
}

interface FeatureStat {
  totalCostUsd: number;
  runCount: number;
}

const DEFAULT_STATS_FILE = path.join(os.homedir(), '.cascade', 'model-perf.json');

/** How long a save waits for another writer's lock before giving up until the next save. */
const LOCK_WAIT_MS = 5_000;
/** A lock older than this was left by a writer that died mid-save. */
const LOCK_STALE_MS = 30_000;

/**
 * Saves of one file in this process, in order. The cloud server runs every run
 * through its own tracker in one process, all on the same pool file.
 */
const saveQueues = new Map<string, Promise<unknown>>();

type Pool = { models: Map<string, ModelStat>; features: Map<string, FeatureStat> };
const emptyPool = (): Pool => ({ models: new Map(), features: new Map() });

/** a + b, field by field. Either may be missing fields an older pool never kept. */
function addStat(a: ModelStat | undefined, b: ModelStat): ModelStat {
  const explicit = (a?.explicitCount ?? 0) + (b.explicitCount ?? 0);
  return {
    successCount: (a?.successCount ?? 0) + b.successCount,
    failureCount: (a?.failureCount ?? 0) + b.failureCount,
    totalRetries: (a?.totalRetries ?? 0) + b.totalRetries,
    totalCostUsd: (a?.totalCostUsd ?? 0) + b.totalCostUsd,
    sampleCount: (a?.sampleCount ?? 0) + b.sampleCount,
    totalContextTokens: (a?.totalContextTokens ?? 0) + (b.totalContextTokens ?? 0),
    failureContextTokens: (a?.failureContextTokens ?? 0) + (b.failureContextTokens ?? 0),
    ...(explicit ? { explicitCount: explicit } : {}),
  };
}

function addFeature(a: FeatureStat | undefined, b: FeatureStat): FeatureStat {
  return { totalCostUsd: (a?.totalCostUsd ?? 0) + b.totalCostUsd, runCount: (a?.runCount ?? 0) + b.runCount };
}

/** base plus every delta, as a new pool. */
function merged(base: Pool, delta: Pool): Pool {
  const out: Pool = { models: new Map(base.models), features: new Map(base.features) };
  for (const [k, d] of delta.models) out.models.set(k, addStat(out.models.get(k), d));
  for (const [k, d] of delta.features) out.features.set(k, addFeature(out.features.get(k), d));
  return out;
}

/** The pool a file holds: the current format, or the old flat one ({ "modelId:taskType": ModelStat }). */
function poolFrom(parsed: unknown): Pool {
  const pool = emptyPool();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a pool');
  const p = parsed as Record<string, unknown> & { models?: Record<string, ModelStat>; features?: Record<string, FeatureStat> };
  const isStat = (v: unknown): v is ModelStat => !!v && typeof v === 'object' && typeof (v as ModelStat).successCount === 'number';
  if (p.models && typeof p.models === 'object') {
    for (const [key, stat] of Object.entries(p.models)) if (isStat(stat)) pool.models.set(key, stat);
  } else {
    for (const [key, stat] of Object.entries(p)) if (isStat(stat)) pool.models.set(key, stat);
  }
  if (p.features && typeof p.features === 'object') {
    for (const [key, stat] of Object.entries(p.features)) {
      if (stat && typeof stat === 'object' && typeof stat.totalCostUsd === 'number') pool.features.set(key, stat);
    }
  }
  return pool;
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * The pool on disk. Missing is an empty pool. A read that fails throws: the
 * caller must not write over a pool it couldn't read. A file that isn't a pool
 * reads as empty; a writer (`setAside`) first moves it to `<file>.corrupt-<time>`,
 * so it is kept rather than written over.
 */
async function readPool(file: string, setAside = false): Promise<Pool> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf-8'); } catch (e) { if (isMissing(e)) return emptyPool(); throw e; }
  try { return poolFrom(JSON.parse(raw)); } catch {
    if (setAside) await fs.rename(file, `${file}.corrupt-${Date.now()}`);
    return emptyPool();
  }
}

/** Creates `file` holding `token`, or returns false if it exists. */
async function create(file: string, token: string): Promise<boolean> {
  try {
    const h = await fs.open(file, 'wx');
    try { await h.writeFile(token); } finally { await h.close(); }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw e;
  }
}

const ageOf = (st: { mtimeMs: number }): number => Date.now() - st.mtimeMs;

/**
 * Removes `lock` if it is still the stale lock it was found to be.
 *
 * Two writers can find the same stale lock. If each simply removed it, the
 * second could remove the lock the first had just taken in its place, and both
 * would write at once. So a stale lock is only removed under a second, briefly
 * held lock (`<lock>.takeover`), after checking again, under it, that it is the
 * same file (inode) and still stale. The takeover lock is held for two system
 * calls; one left by a writer that died holding it is cleared after a while.
 */
async function removeIfStale(lock: string, seen: { ino: number }, token: string): Promise<boolean> {
  const takeover = `${lock}.takeover`;
  if (!(await create(takeover, token))) {
    // Another writer is taking it over (or died doing so): wait like for any lock.
    const st = await fs.stat(takeover).catch(() => null);
    if (st && ageOf(st) > LOCK_STALE_MS) await fs.rm(takeover, { force: true });
    return false;
  }
  try {
    const now = await fs.stat(lock).catch(() => null);
    if (now && now.ino === seen.ino && ageOf(now) > LOCK_STALE_MS) { await fs.rm(lock, { force: true }); return true; }
    return false;
  } finally {
    await fs.rm(takeover, { force: true }).catch(() => {});
  }
}

/**
 * Holds `<file>.lock` while `fn` runs, so writers in other processes (CLI,
 * desktop) take turns. Exported for tests.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const lock = `${file}.lock`;
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  while (!(await create(lock, token))) {
    const st = await fs.stat(lock).catch(() => null);
    // Removed: try again at once. Otherwise it is waited for, within the deadline, like a live lock.
    if (st && ageOf(st) > LOCK_STALE_MS && await removeIfStale(lock, st, token)) continue;
    if (Date.now() > deadline) throw new Error('model-perf pool is locked');
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
  }
  try { return await fn(); } finally {
    // Only our own: had this run past the stale age, the lock may now be someone else's.
    const held = await fs.readFile(lock, 'utf-8').catch(() => null);
    if (held === token) await fs.rm(lock, { force: true }).catch(() => {});
  }
}

export class ModelPerformanceTracker {
  /**
   * What this tracker reads scores from: the pool as last read from disk, plus
   * everything recorded here that isn't saved yet.
   */
  private stats = new Map<string, ModelStat>();
  private featureStats = new Map<string, FeatureStat>();
  /** The pool as last read from (or written to) disk. */
  private base: Pool = emptyPool();
  /** What this tracker recorded since its last save: the only thing a save adds to the file. */
  private pending: Pool = emptyPool();
  private readonly statsFile: string;
  private readonly readOnly: boolean;
  private loading?: Promise<void>;

  /**
   * @param statsFile where stats persist (cloud → the persistent volume).
   * @param options.readOnly consume the shared scores but don't record/save this
   *        run's outcomes — the opt-out path for users who declined to contribute.
   */
  constructor(statsFile = DEFAULT_STATS_FILE, options: { readOnly?: boolean } = {}) {
    this.statsFile = path.resolve(statsFile);
    this.readOnly = options.readOnly ?? false;
  }

  /**
   * Reads the pool. Safe to call without awaiting: what is recorded before it
   * finishes is kept, on top of what it reads.
   */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try { this.base = await readPool(this.statsFile); } catch { /* unreadable now: scores start from the prior; save re-reads */ }
      this.refresh();
    })();
    return this.loading;
  }

  /**
   * Adds what this tracker recorded since its last save to the pool on disk.
   *
   * It never writes its own picture of the pool. The file is re-read under a
   * lock, this tracker's increments are added to it, and the sum is written
   * whole (temp + rename). Writing the in-memory snapshot instead lost everything
   * another writer had added since this tracker loaded, and wiped the pool to
   * this run's models when a save beat the non-blocking load, or followed a
   * load that failed.
   *
   * A pool that can't be read is left alone: the increments stay pending for
   * the next save.
   */
  save(): Promise<void> {
    if (this.readOnly) return Promise.resolve(); // opted out — never write this user's outcomes
    const prev = saveQueues.get(this.statsFile) ?? Promise.resolve();
    const run = prev.then(() => this.saveNow()).catch(() => { /* non-critical: increments stay pending */ });
    saveQueues.set(this.statsFile, run);
    void run.finally(() => { if (saveQueues.get(this.statsFile) === run) saveQueues.delete(this.statsFile); });
    return run;
  }

  private async saveNow(): Promise<void> {
    await this.load();
    if (this.pending.models.size === 0 && this.pending.features.size === 0) return;
    const sent = this.pending;
    this.pending = emptyPool();
    try {
      await fs.mkdir(path.dirname(this.statsFile), { recursive: true });
      const written = await withFileLock(this.statsFile, async () => {
        const next = merged(await readPool(this.statsFile, true), sent);
        const json = JSON.stringify({ models: Object.fromEntries(next.models), features: Object.fromEntries(next.features) }, null, 2);
        // A per-process temp name, renamed over the file: a reader never sees half a pool.
        const tmp = `${this.statsFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        try {
          await fs.writeFile(tmp, json, 'utf-8');
          await fs.rename(tmp, this.statsFile);
        } catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; }
        return next;
      });
      this.base = written;
    } catch (e) {
      // Not written: put the increments back, ahead of anything recorded meanwhile.
      this.pending = merged(sent, this.pending);
      throw e;
    } finally {
      this.refresh();
    }
  }

  /** stats = base + pending. */
  private refresh(): void {
    const view = merged(this.base, this.pending);
    this.stats = view.models;
    this.featureStats = view.features;
  }

  /** Adds one increment to what is pending and to what scores are read from. */
  private add(key: string, delta: ModelStat): void {
    this.pending.models.set(key, addStat(this.pending.models.get(key), delta));
    this.stats.set(key, addStat(this.stats.get(key), delta));
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
    explicit = false,
  ): void {
    if (this.readOnly) return; // opted out — read scores, don't contribute
    const w = Math.max(0, weight);
    const tokens = Math.max(0, contextTokens);
    this.add(`${modelId}:${taskType}`, {
      successCount: outcome === 'success' ? w : 0,
      failureCount: outcome === 'failure' ? w : 0,
      totalRetries: retries,
      totalCostUsd: costUsd,
      sampleCount: 1,
      totalContextTokens: tokens,
      failureContextTokens: outcome === 'failure' ? tokens : 0,
      ...(explicit ? { explicitCount: 1 } : {}),
    });
  }

  recordFeatureCost(featureTag: string, costUsd: number): void {
    if (this.readOnly) return;
    const delta = { totalCostUsd: costUsd, runCount: 1 };
    this.pending.features.set(featureTag, addFeature(this.pending.features.get(featureTag), delta));
    this.featureStats.set(featureTag, addFeature(this.featureStats.get(featureTag), delta));
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
    this.record(modelId, taskType, outcome, 0, costUsd, 0, ModelPerformanceTracker.EXPLICIT_RATING_WEIGHT, true);
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
