// The shared learning pool (model-perf.json) is only ever added to: a save adds
// what its tracker recorded to what is on disk, never replaces it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelPerformanceTracker, withFileLock } from './model-performance-tracker.js';

let dir: string;
let file: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-pool-')); file = path.join(dir, 'model-perf.json'); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

const stat = (success: number, samples = success) => ({
  successCount: success, failureCount: 0, totalRetries: 0, totalCostUsd: 0.01 * samples, sampleCount: samples,
  totalContextTokens: 0, failureContextTokens: 0,
});
const write = (pool: unknown) => fs.writeFile(file, JSON.stringify(pool));
const read = async () => JSON.parse(await fs.readFile(file, 'utf-8')) as { models: Record<string, ReturnType<typeof stat>>; features: Record<string, { runCount: number }> };

describe('model-perf pool: a save adds, never replaces', () => {
  it('keeps models from earlier weeks when a run saves before its load finished', async () => {
    await write({ models: { 'old-model:code': stat(40) }, features: {} });
    const t = new ModelPerformanceTracker(file);
    void t.load();               // as cascade.ts does: not awaited
    t.record('new-model', 'code', 'success');
    await t.save();
    const pool = await read();
    expect(pool.models['old-model:code']?.sampleCount).toBe(40);
    expect(pool.models['new-model:code']?.sampleCount).toBe(1);
  });

  it('keeps the pool when the load failed, and adds to it on the next save', async () => {
    await write({ models: { 'old-model:code': stat(40) }, features: {} });
    const real = fs.readFile;
    const spy = vi.spyOn(fs, 'readFile').mockImplementationOnce(async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
    const t = new ModelPerformanceTracker(file);
    await t.load();
    expect(spy).toHaveBeenCalled();
    expect(t.sampleCountFor('old-model', 'code')).toBe(0); // scores fell back to the prior
    spy.mockImplementation(real as typeof fs.readFile);
    t.record('new-model', 'code', 'success');
    await t.save();
    const pool = await read();
    expect(pool.models['old-model:code']?.sampleCount).toBe(40);
    expect(pool.models['new-model:code']?.sampleCount).toBe(1);
    expect(t.sampleCountFor('old-model', 'code')).toBe(40); // and the tracker now reads it
  });

  it('does not write over a pool it cannot read, and keeps its increments for later', async () => {
    await write({ models: { 'old-model:code': stat(40) }, features: {} });
    const t = new ModelPerformanceTracker(file);
    await t.load();
    t.record('new-model', 'code', 'success');
    const real = fs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
    await t.save();
    expect(Object.keys((await read()).models)).toEqual(['old-model:code']);
    vi.mocked(fs.readFile).mockImplementation(real as typeof fs.readFile);
    await t.save();
    expect((await read()).models['new-model:code']?.sampleCount).toBe(1);
  });

  it('sums what concurrent runs recorded, on the same model and on different ones', async () => {
    await write({ models: { 'shared:code': stat(10) }, features: { f: { totalCostUsd: 1, runCount: 1 } } });
    const runs = Array.from({ length: 6 }, () => new ModelPerformanceTracker(file));
    await Promise.all(runs.map((r) => r.load()));
    runs.forEach((r, i) => { r.record('shared', 'code', 'success'); r.record(`only-${i}`, 'code', 'success'); r.recordFeatureCost('f', 0.5); });
    await Promise.all(runs.map((r) => r.save()));
    const pool = await read();
    expect(pool.models['shared:code']?.sampleCount).toBe(16);
    for (let i = 0; i < runs.length; i++) expect(pool.models[`only-${i}:code`]?.sampleCount).toBe(1);
    expect(pool.features.f?.runCount).toBe(7);
  });

  it('does not count an increment twice when the same tracker saves again', async () => {
    const t = new ModelPerformanceTracker(file);
    await t.load();
    t.record('m', 'code', 'success');
    await t.save();
    await t.save();
    t.record('m', 'code', 'success');
    await t.save();
    expect((await read()).models['m:code']?.sampleCount).toBe(2);
    expect(t.sampleCountFor('m', 'code')).toBe(2);
  });

  it('keeps what another process added since this tracker loaded', async () => {
    const t = new ModelPerformanceTracker(file);
    await t.load();
    await write({ models: { 'elsewhere:code': stat(5) }, features: {} }); // the CLI, say, saved meanwhile
    t.recordExplicit('m', 'code', 'good');
    await t.save();
    const pool = await read();
    expect(pool.models['elsewhere:code']?.sampleCount).toBe(5);
    expect(pool.models['m:code']).toMatchObject({ sampleCount: 1, successCount: 3, explicitCount: 1 });
  });

  it('reads the old flat format, and writes the current one', async () => {
    await write({ 'old-model:code': stat(7) });
    const t = new ModelPerformanceTracker(file);
    void t.load();
    t.record('new-model', 'code', 'success');
    await t.save();
    const pool = await read();
    expect(pool.models['old-model:code']?.sampleCount).toBe(7);
    expect(pool.models['new-model:code']?.sampleCount).toBe(1);
  });

  it('sets a file that is not a pool aside instead of writing over it', async () => {
    await fs.writeFile(file, '{ not json');
    const t = new ModelPerformanceTracker(file);
    await t.load();
    t.record('m', 'code', 'success');
    await t.save();
    expect((await read()).models['m:code']?.sampleCount).toBe(1);
    const aside = (await fs.readdir(dir)).filter((f) => f.startsWith('model-perf.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, aside[0]!), 'utf-8')).toBe('{ not json');
  });

  it('waits for another writer’s lock, and takes over a stale one', async () => {
    await fs.writeFile(`${file}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${file}.lock`, old, old);
    const t = new ModelPerformanceTracker(file);
    t.record('m', 'code', 'success');
    await t.save();
    expect((await read()).models['m:code']?.sampleCount).toBe(1);
    await expect(fs.stat(`${file}.lock`)).rejects.toThrow();
  });

  it('a read-only tracker never writes', async () => {
    await write({ models: { 'old-model:code': stat(3) }, features: {} });
    const t = new ModelPerformanceTracker(file, { readOnly: true });
    await t.load();
    t.record('m', 'code', 'success');
    await t.save();
    expect(Object.keys((await read()).models)).toEqual(['old-model:code']);
    expect(t.sampleCountFor('old-model', 'code')).toBe(3);
  });
});

describe('model-perf pool lock', () => {
  const staleLock = async () => {
    await fs.writeFile(`${file}.lock`, 'dead-writer');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${file}.lock`, old, old);
  };
  /** A read, a pause, a write: two writers inside at once lose a count. */
  const increment = () => withFileLock(file, async () => {
    const n = Number(await fs.readFile(path.join(dir, 'n'), 'utf-8').catch(() => '0'));
    await new Promise((r) => setTimeout(r, 40));
    await fs.writeFile(path.join(dir, 'n'), String(n + 1));
  }, { waitMs: 20_000 });

  it('lets one writer in at a time, even when they all find the same stale lock', async () => {
    await staleLock();
    // Every contender stats the stale lock before any of them removes it.
    const realStat = fs.stat;
    let gate!: () => void;
    const allSeen = new Promise<void>((r) => { gate = r; });
    let seen = 0;
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const st = await realStat(...args);
      if (String(args[0]).endsWith('.lock') && seen < 12) {
        const order = ++seen;
        if (order === 12) gate();
        await allSeen;
        // Staggered: a later contender acts after an earlier one has taken the lock anew.
        await new Promise((r) => setTimeout(r, order * 5));
      }
      return st;
    });
    await Promise.all(Array.from({ length: 12 }, increment));
    expect(await fs.readFile(path.join(dir, 'n'), 'utf-8')).toBe('12');
    await expect(fs.stat(`${file}.lock`)).rejects.toThrow();
  });

  it('keeps to its deadline, and backs off, while another writer holds the takeover', async () => {
    await staleLock();
    await fs.writeFile(`${file}.lock.takeover`, 'a-writer-mid-takeover'); // fresh: not itself stale
    const open = vi.spyOn(fs, 'open');
    const started = Date.now();
    await expect(withFileLock(file, async () => {}, { waitMs: 200 })).rejects.toThrow(/locked/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(open.mock.calls.length).toBeLessThan(40); // a pause between tries, not a spin
  });

  it('does not remove a lock that is no longer its own', async () => {
    await withFileLock(file, async () => {
      await fs.writeFile(`${file}.lock`, 'someone-else'); // taken over meanwhile
    });
    expect(await fs.readFile(`${file}.lock`, 'utf-8')).toBe('someone-else');
  });
});
