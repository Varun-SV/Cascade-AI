// ─────────────────────────────────────────────
//  Cascade AI — Dead-model memory
// ─────────────────────────────────────────────
//
//  From a real /why panel: twelve identical
//  `T3 gemini:gemini-2.0-flash → gemini:gemini-2.5-flash (model not found)`
//  failovers in ONE run, because a T3 wave runs concurrently and every worker
//  independently discovered the same dead id before any of them could record it.

import { describe, expect, it } from 'vitest';
import {
  DEAD_MODEL_TTL_MS,
  DeadModelStore,
  deadModelKey,
  type DeadModelPersistence,
  type DeadModelRecord,
} from './dead-models.js';

/** In-memory persistence standing in for the JSON file / cloud table. */
function memoryPersistence(seed: DeadModelRecord[] = []) {
  let rows = [...seed];
  const p: DeadModelPersistence & { rows: () => DeadModelRecord[] } = {
    load: () => [...rows],
    save: (r) => { rows = [...r]; },
    rows: () => rows,
  };
  return p;
}

describe('DeadModelStore', () => {
  it('remembers a dead model and keeps it dead', () => {
    const s = new DeadModelStore();
    expect(s.isDead('gemini', 'gemini-2.0-flash')).toBe(false);
    s.record('gemini', 'gemini-2.0-flash', 'model not found');
    expect(s.isDead('gemini', 'gemini-2.0-flash')).toBe(true);
    expect(s.reasonFor('gemini', 'gemini-2.0-flash')).toBe('model not found');
  });

  it('scopes the verdict to the provider, not the bare id', () => {
    // The same model name can be live on one provider and absent on another —
    // an Azure deployment vs the OpenAI original, say.
    const s = new DeadModelStore();
    s.record('gemini', 'some-model', 'model not found');
    expect(s.isDead('gemini', 'some-model')).toBe(true);
    expect(s.isDead('openai', 'some-model')).toBe(false);
  });

  it('reports only the FIRST sighting as new, so a concurrent wave logs once', () => {
    // This is the twelve-failovers case: every worker in the wave records the
    // same death. The caller logs on `true`, so the user sees one line.
    const s = new DeadModelStore();
    expect(s.record('gemini', 'gemini-2.0-flash', 'model not found')).toBe(true);
    for (let i = 0; i < 11; i++) {
      expect(s.record('gemini', 'gemini-2.0-flash', 'model not found')).toBe(false);
    }
    expect(s.list()[0]!.hits).toBe(12);
  });

  it('survives a restart, which is the point', () => {
    const p = memoryPersistence();
    const first = new DeadModelStore(p);
    first.record('gemini', 'gemini-2.0-flash', 'model not found');

    // New process, same store.
    const second = new DeadModelStore(p);
    expect(second.isDead('gemini', 'gemini-2.0-flash')).toBe(true);
  });

  it('lets a model come back after the TTL rather than banning it forever', () => {
    // The load-bearing choice: previews get promoted, quotas get granted. A
    // permanent blocklist would silently shrink the routing pool with no way
    // for the user to see why their best model stopped being picked.
    let now = 1_000_000;
    const s = new DeadModelStore(undefined, { now: () => now });
    s.record('gemini', 'gemini-2.0-flash', 'model not found');
    expect(s.isDead('gemini', 'gemini-2.0-flash')).toBe(true);

    now += DEAD_MODEL_TTL_MS + 1;
    expect(s.isDead('gemini', 'gemini-2.0-flash')).toBe(false);
    // And it is dropped, not merely hidden.
    expect(s.list()).toEqual([]);
  });

  it('refreshes the clock on a repeat sighting', () => {
    // A model that keeps failing should stay dead, not expire on the schedule
    // set by the first sighting.
    let now = 1_000_000;
    const s = new DeadModelStore(undefined, { now: () => now });
    s.record('gemini', 'm', 'model not found');
    now += DEAD_MODEL_TTL_MS - 1;
    s.record('gemini', 'm', 'model not found');
    now += DEAD_MODEL_TTL_MS - 1;
    expect(s.isDead('gemini', 'm')).toBe(true);
  });

  it('drops an already-expired record on load instead of resurrecting it', () => {
    const stale: DeadModelRecord = {
      key: deadModelKey('gemini', 'old'), provider: 'gemini', modelId: 'old',
      reason: 'model not found', firstSeenAt: 0, lastSeenAt: 0, hits: 1,
    };
    const s = new DeadModelStore(memoryPersistence([stale]), { now: () => DEAD_MODEL_TTL_MS + 5 });
    expect(s.isDead('gemini', 'old')).toBe(false);
  });

  it('lets the user retry a model immediately once they have fixed it', () => {
    const s = new DeadModelStore();
    s.record('gemini', 'm', 'model not found');
    expect(s.forget('gemini', 'm')).toBe(true);
    expect(s.isDead('gemini', 'm')).toBe(false);
    expect(s.forget('gemini', 'm')).toBe(false);
  });

  it('never lets a broken store stop a run', () => {
    // A corrupt file is a reason to rediscover dead models, not to fail to start.
    const broken: DeadModelPersistence = {
      load: () => { throw new Error('corrupt'); },
      save: () => { throw new Error('read-only disk'); },
    };
    const s = new DeadModelStore(broken);
    expect(() => s.record('gemini', 'm', 'model not found')).not.toThrow();
    expect(s.isDead('gemini', 'm')).toBe(true);
  });
});
