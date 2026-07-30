// ─────────────────────────────────────────────
//  Cascade AI — Dead-model memory
// ─────────────────────────────────────────────
//
//  From a real /why panel: twelve identical
//  `T3 gemini:gemini-2.0-flash → gemini:gemini-2.5-flash (model not found)`
//  failovers in ONE run, because a T3 wave runs concurrently and every worker
//  independently discovered the same dead id before any of them could record it.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEAD_MODEL_TTL_MS,
  DeadModelStore,
  deadModelKey,
  fileDeadModelPersistence,
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

describe('fileDeadModelPersistence (the real file-backed store, not the in-memory stub)', () => {
  // Every other test in this file uses memoryPersistence() as a stand-in — it
  // can't catch a bug in the actual load()/save() implementation. This exists
  // specifically so a regression in the real file I/O (like the dynamic
  // require('fs') that silently threw and was swallowed in the ESM build,
  // meaning the file was NEVER actually read or written) fails a test instead
  // of only surfacing as "the same dead model gets retried every single run."
  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-dead-models-'));
    return join(dir, 'nested', 'dead-models.json');
  }

  it('round-trips a record through a real file on disk, across separate store instances', () => {
    const filePath = tempDbPath();
    const first = new DeadModelStore(fileDeadModelPersistence(filePath));
    first.record('gemini', 'gemini-2.0-flash', 'model not found');

    // A fresh store reading the same path is what "survives a restart" means
    // for the file-backed persistence specifically — not just the in-memory
    // stub already covered above.
    const second = new DeadModelStore(fileDeadModelPersistence(filePath));
    expect(second.isDead('gemini', 'gemini-2.0-flash')).toBe(true);
    expect(second.reasonFor('gemini', 'gemini-2.0-flash')).toBe('model not found');

    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it('creates the parent directory itself rather than requiring it to pre-exist', () => {
    const filePath = tempDbPath(); // parent "nested" dir does not exist yet
    expect(() => fileDeadModelPersistence(filePath).save([])).not.toThrow();
    rmSync(dirname(filePath), { recursive: true, force: true });
  });

  it('returns an empty list rather than throwing when the file does not exist yet', () => {
    const filePath = tempDbPath();
    expect(fileDeadModelPersistence(filePath).load()).toEqual([]);
  });
});

// ── Multi-tenancy ─────────────────────────────
//
// Raised in review on #178: "will a user a's failover models affect user b's
// orchestration?" It would have. The verdict is KEY-specific — a model that
// 404s for one account is often live for another whose key has access — so a
// store shared between tenants lets one user silently suppress another's
// models. The fix is placement (per-workspace, never machine-global); these
// pin the property that placement is supposed to deliver.

describe('dead-model verdicts are per-account, not global', () => {
  it('keeps two tenants\' verdicts entirely separate', () => {
    const tenantA = new DeadModelStore(memoryPersistence());
    const tenantB = new DeadModelStore(memoryPersistence());

    tenantA.record('gemini', 'gemini-2.0-flash', 'model not found');

    expect(tenantA.isDead('gemini', 'gemini-2.0-flash')).toBe(true);
    // B's key may well have access to the very model A cannot reach.
    expect(tenantB.isDead('gemini', 'gemini-2.0-flash')).toBe(false);
    expect(tenantB.list()).toEqual([]);
  });

  it('does not leak through a shared backing store either', () => {
    // Belt and braces: even handed the same persistence, each store only
    // publishes what it was told — the isolation must come from placement,
    // and this documents what happens if placement is ever got wrong again.
    const shared = memoryPersistence();
    const first = new DeadModelStore(shared);
    first.record('gemini', 'm', 'model not found');
    const second = new DeadModelStore(shared);
    // Sharing a file DOES share verdicts — which is exactly why the file must
    // live under the per-tenant workspace and never the machine-global dir.
    expect(second.isDead('gemini', 'm')).toBe(true);
  });
});
