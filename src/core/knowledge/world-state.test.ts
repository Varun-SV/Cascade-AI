// world-state v2 — queryable fact store + T1 consumption.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldStateDB, factMayLeave } from './world-state.js';
import { PrivacyPaths } from '../privacy/paths.js';
import { T1Administrator } from '../tiers/t1-administrator.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { CascadeConfig, GenerateResult } from '../../types.js';
import { projectStateDir } from '../../config/project-state.js';

let ws: string;
let db: WorldStateDB;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-worldstate-'));
  db = new WorldStateDB(ws);
});
afterEach(async () => {
  db.close();
  await fs.rm(ws, { recursive: true, force: true });
});

describe('WorldStateDB v2 — facts', () => {
  it('upserts and encrypts a fact, round-tripping the value', () => {
    db.upsertFact('Auth Module', 'uses', 'JWT', 't3-a');
    const facts = db.getAllFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ entity: 'auth module', relation: 'uses', value: 'JWT', sourceWorker: 't3-a' });
  });

  it('SUPERSEDES on (entity, relation) instead of appending', () => {
    db.upsertFact('auth module', 'uses', 'sessions', 't3-a');
    db.upsertFact('AUTH  module', 'Uses', 'JWT', 't3-b'); // same normalized key
    const facts = db.getAllFacts();
    expect(facts).toHaveLength(1);              // not two rows
    expect(facts[0]!.value).toBe('JWT');        // newer value wins
    expect(facts[0]!.sourceWorker).toBe('t3-b');
  });

  it('keeps distinct relations for the same entity as separate facts', () => {
    db.upsertFact('service Y', 'depends on', 'service Z', 't3-a');
    db.upsertFact('service Y', 'exposes', 'REST API', 't3-a');
    expect(db.getAllFacts()).toHaveLength(2);
  });

  it('ignores empty entity/relation/value', () => {
    db.upsertFact('', 'uses', 'x', 't3');
    db.upsertFact('e', '', 'x', 't3');
    db.upsertFact('e', 'r', '   ', 't3');
    expect(db.getAllFacts()).toHaveLength(0);
  });

  it('getFactsForEntities filters by normalized entity', () => {
    db.upsertFact('auth module', 'uses', 'JWT', 't3');
    db.upsertFact('billing', 'uses', 'Stripe', 't3');
    const got = db.getFactsForEntities(['Auth Module']);
    expect(got).toHaveLength(1);
    expect(got[0]!.value).toBe('JWT');
  });

  it('getFormattedKnowledge relevance-filters by prompt tokens, else returns all', () => {
    db.upsertFact('auth module', 'uses', 'JWT', 't3');
    db.upsertFact('billing', 'uses', 'Stripe', 't3');

    const relevant = db.getFormattedKnowledge('please refactor the auth module');
    expect(relevant).toContain('auth module uses JWT');
    expect(relevant).not.toContain('billing');

    // No token match → fall back to all facts (better than nothing).
    const all = db.getFormattedKnowledge('completely unrelated xyzzy prompt');
    expect(all).toContain('auth module');
    expect(all).toContain('billing');
  });

  it('getFormattedKnowledge returns "" when there are no facts (caller falls back to the log)', () => {
    expect(db.getFormattedKnowledge('anything')).toBe('');
  });

  it('the linear log still works alongside facts', () => {
    db.addEntry('t3-a', 'Completed: build auth');
    db.upsertFact('auth', 'uses', 'JWT', 't3-a');
    expect(db.getAllEntries()).toHaveLength(1);
    expect(db.getAllFacts()).toHaveLength(1);
  });

  it('deleteFact removes one (normalized) entity+relation pair and reports whether it existed', () => {
    db.upsertFact('auth module', 'uses', 'JWT', 't3-a');
    db.upsertFact('auth module', 'exposes', 'REST API', 't3-a');
    expect(db.deleteFact('AUTH  Module', 'Uses')).toBe(true);   // normalized match
    expect(db.deleteFact('auth module', 'uses')).toBe(false);   // already gone
    expect(db.getAllFacts()).toHaveLength(1);
    expect(db.getAllFacts()[0]!.relation).toBe('exposes');
  });

  it('clearFacts empties the graph and returns the count', () => {
    db.upsertFact('a', 'r1', 'v', 't3');
    db.upsertFact('b', 'r2', 'v', 't3');
    expect(db.clearFacts()).toBe(2);
    expect(db.getAllFacts()).toHaveLength(0);
    expect(db.clearFacts()).toBe(0);
  });
});

describe('WorldStateDB v3 — history-preserving writes + undo', () => {
  it('archives the prior value when a fact is overwritten', () => {
    db.upsertFact('user', 'prefers_theme', 'light', 't3-a');
    db.upsertFact('user', 'prefers_theme', 'dark', 't3-b');
    // Current read is unchanged — only the newest value is "current".
    expect(db.getAllFacts()).toHaveLength(1);
    expect(db.getFactsForEntities(['user'])[0]!.value).toBe('dark');
    // History has the superseded value.
    const hist = db.getFactHistory('user', 'prefers_theme');
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ value: 'light', change: 'update' });
  });

  it('does NOT archive when the same value is re-observed', () => {
    db.upsertFact('svc', 'runtime', 'node', 't3');
    db.upsertFact('svc', 'runtime', 'node', 't3'); // identical
    expect(db.getFactHistory('svc', 'runtime')).toHaveLength(0);
  });

  it('archives on delete and on clear', () => {
    db.upsertFact('a', 'r', 'one', 't3');
    expect(db.deleteFact('a', 'r')).toBe(true);
    expect(db.getFactHistory('a', 'r')).toMatchObject([{ value: 'one', change: 'delete' }]);

    db.upsertFact('b', 'r', 'two', 't3');
    db.clearFacts();
    expect(db.getFactHistory('b', 'r')).toMatchObject([{ value: 'two', change: 'clear' }]);
  });

  it('covers the importKnowledge newer-wins overwrite path', () => {
    db.upsertFact('doc', 'status', 'draft', 't3', '2026-01-01T00:00:00Z');
    db.importKnowledge({ facts: [{ entity: 'doc', relation: 'status', value: 'final', timestamp: '2026-06-01T00:00:00Z' }] });
    expect(db.getFactsForEntities(['doc'])[0]!.value).toBe('final');
    expect(db.getFactHistory('doc', 'status')).toMatchObject([{ value: 'draft' }]);
  });

  it('restoreFact brings back a prior value and is itself undoable', () => {
    db.upsertFact('user', 'city', 'Chennai', 't3');
    db.upsertFact('user', 'city', 'Bangalore', 't3'); // a bad extraction
    expect(db.restoreFact('user', 'city')).toBe(true);
    expect(db.getFactsForEntities(['user'])[0]!.value).toBe('Chennai');
    // The wrong value (Bangalore) is now itself in history, so the undo is undoable.
    expect(db.getFactHistory('user', 'city').some((h) => h.value === 'Bangalore')).toBe(true);
  });

  it('keeps history values encrypted at rest (no plaintext in the DB file)', () => {
    db.upsertFact('secret', 'token', 'HUNTER2', 't3');
    db.upsertFact('secret', 'token', 'ROTATED', 't3');
    db.close();
    // Read the raw SQLite bytes — the archived value must not appear in plaintext.
    const raw = readFileSync(path.join(projectStateDir(ws), 'world_state.db'));
    expect(raw.includes(Buffer.from('HUNTER2'))).toBe(false);
    // Re-open for afterEach's close() to succeed.
    db = new WorldStateDB(ws);
  });
});

describe('WorldStateDB export / import (v0.15.0)', () => {
  it('exportKnowledge returns decrypted facts + log; import re-encrypts into a fresh DB', async () => {
    db.upsertFact('auth module', 'uses', 'JWT', 't3-a');
    db.addEntry('t3-a', 'Completed: built auth');
    const bundle = db.exportKnowledge();
    expect(bundle.facts[0]!.value).toBe('JWT'); // plaintext in the bundle

    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-ws-imp-'));
    const db2 = new WorldStateDB(dir2); // its own fresh encryption key
    try {
      const counts = db2.importKnowledge(bundle);
      expect(counts).toEqual({ facts: 1, logEntries: 1 });
      expect(db2.getAllFacts()[0]).toMatchObject({ entity: 'auth module', value: 'JWT' });
      expect(db2.getAllEntries()[0]!.summary).toBe('Completed: built auth');
    } finally {
      db2.close();
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });

  it('imported facts obey newer-timestamp-wins against local facts', () => {
    db.upsertFact('auth', 'uses', 'sessions', 't3-local', '2026-07-02T00:00:00.000Z');
    // Older import → ignored; newer import → supersedes.
    let counts = db.importKnowledge({ facts: [{ entity: 'auth', relation: 'uses', value: 'OLD', timestamp: '2026-07-01T00:00:00.000Z' }] });
    expect(counts.facts).toBe(0);
    expect(db.getAllFacts()[0]!.value).toBe('sessions');
    counts = db.importKnowledge({ facts: [{ entity: 'auth', relation: 'uses', value: 'JWT', timestamp: '2026-07-03T00:00:00.000Z' }] });
    expect(counts.facts).toBe(1);
    expect(db.getAllFacts()[0]!.value).toBe('JWT');
  });

  it('re-importing the same log entries is a no-op (exact-duplicate skip)', () => {
    const entries = [{ workerId: 't3-a', summary: 'did X', timestamp: '2026-07-03T00:00:00.000Z' }];
    expect(db.importKnowledge({ worldLog: entries }).logEntries).toBe(1);
    expect(db.importKnowledge({ worldLog: entries }).logEntries).toBe(0);
    expect(db.getAllEntries()).toHaveLength(1);
  });
});

// ── T1 consumes facts during decomposition ──
function makeResult(content: string): GenerateResult {
  return { content, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } };
}
const PLAN_JSON = JSON.stringify({
  complexity: 'Moderate', reasoning: 'x',
  sections: [{ sectionId: 's1', sectionTitle: 'S', description: 'd', expectedOutput: 'o', constraints: [], dependsOn: [], t3Subtasks: [{ subtaskId: 't1', subtaskTitle: 'i', description: 'd', expectedOutput: 'o', constraints: [], dependsOn: [] }] }],
});
function makeToolRegistry(): ToolRegistry {
  return { getToolDefinitions: () => [], requiresApproval: () => false, isDangerous: () => false } as unknown as ToolRegistry;
}

describe('T1 decomposition consumes world-state v2 facts', () => {
  it('injects relevant PROJECT KNOWLEDGE facts into the decomposition prompt', async () => {
    db.upsertFact('auth module', 'uses', 'JWT', 't3');
    const generate = vi.fn(async () => makeResult(PLAN_JSON));
    const router = { generate, getModelForTier: () => undefined, getWorldStateDB: () => db } as unknown as CascadeRouter;
    const t1 = new T1Administrator(router, makeToolRegistry(), {} as unknown as CascadeConfig);

    await t1.previewPlan('refactor the auth module');

    const prompt = generate.mock.calls[0]![1]!.messages[0]!.content as string;
    expect(prompt).toContain('PROJECT KNOWLEDGE');
    expect(prompt).toContain('auth module uses JWT');
    expect(prompt).not.toContain('PROJECT WORLD STATE'); // used facts, not the log
  });

  it('falls back to the linear log when no facts exist yet', async () => {
    db.addEntry('t3', 'Completed: initial scaffolding');
    const generate = vi.fn(async () => makeResult(PLAN_JSON));
    const router = { generate, getModelForTier: () => undefined, getWorldStateDB: () => db } as unknown as CascadeRouter;
    const t1 = new T1Administrator(router, makeToolRegistry(), {} as unknown as CascadeConfig);

    await t1.previewPlan('add a feature');

    const prompt = generate.mock.calls[0]![1]!.messages[0]!.content as string;
    expect(prompt).toContain('PROJECT WORLD STATE');
    expect(prompt).toContain('initial scaffolding');
  });

  it('injects neither block when the world state is entirely empty', async () => {
    const generate = vi.fn(async () => makeResult(PLAN_JSON));
    const router = { generate, getModelForTier: () => undefined, getWorldStateDB: () => db } as unknown as CascadeRouter;
    const t1 = new T1Administrator(router, makeToolRegistry(), {} as unknown as CascadeConfig);

    await t1.previewPlan('do something');

    const prompt = generate.mock.calls[0]![1]!.messages[0]!.content as string;
    expect(prompt).not.toContain('PROJECT KNOWLEDGE');
    expect(prompt).not.toContain('PROJECT WORLD STATE');
  });
});

// Facts from before privacy.paths was set, or saved from work that has since
// become local-only, went into T1's plan all the same: nothing said where
// they came from.
describe('WorldStateDB — where a fact came from', () => {
  const rules = (...localOnly: string[]) => ({ hasPolicies: () => true, isLocalOnly: (p: string) => localOnly.includes(p) });

  it('records the files a fact came from — none, for a fact saved without', () => {
    db.upsertFact('auth', 'uses', 'JWT', 't3', undefined, ['src/auth.ts', 'src/auth.ts']);
    db.upsertFact('db', 'is', 'postgres', 't3');
    db.upsertFact('team', 'prefers', 'tabs', 'session-memory', undefined, []);
    expect(Object.fromEntries(db.getAllFacts().map((f) => [f.entity, f.sources]))).toEqual({
      auth: ['src/auth.ts'], db: null, team: [],
    });
  });

  it('with privacy.paths rules, sets aside a fact with no record and one whose file is now local-only', () => {
    const recorded = { entity: 'a', relation: 'r', value: 'v', sourceWorker: 't3', timestamp: 't', sources: ['src/a.ts'] };
    const older = { ...recorded, sources: null };
    const unrecordedField = { entity: 'a', relation: 'r', value: 'v', sourceWorker: 't3', timestamp: 't' };
    expect(factMayLeave(recorded, rules())).toBe(true);
    expect(factMayLeave({ ...recorded, sources: [] }, rules())).toBe(true);
    expect(factMayLeave(older, rules())).toBe(false);
    expect(factMayLeave(unrecordedField, rules())).toBe(false);
    expect(factMayLeave(recorded, rules('src/a.ts'))).toBe(false);
    // Without rules, all may: nothing was deleted, so loosening brings them back.
    expect(factMayLeave(older, undefined)).toBe(true);
    expect(factMayLeave(recorded, { hasPolicies: () => false, isLocalOnly: () => true })).toBe(true);
  });

  it('brings a restored value back with where it came from', () => {
    db.upsertFact('auth', 'uses', 'sessions', 't3', undefined, ['secret/old.md']);
    db.upsertFact('auth', 'uses', 'JWT', 't3', undefined, ['src/auth.ts']);
    expect(db.restoreFact('auth', 'uses')).toBe(true);
    expect(db.getAllFacts()[0]).toMatchObject({ value: 'sessions', sources: ['secret/old.md'] });
  });

  it('carries sources through an export and import, and imports a fact without them as unrecorded', async () => {
    db.upsertFact('auth', 'uses', 'JWT', 't3', undefined, ['src/auth.ts']);
    const bundle = JSON.parse(JSON.stringify(db.exportKnowledge()));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-worldstate-import-'));
    const into = new WorldStateDB(other);
    try {
      into.importKnowledge({ facts: [...bundle.facts, { entity: 'db', relation: 'is', value: 'postgres', timestamp: '2026-01-01' }] });
      expect(Object.fromEntries(into.getAllFacts().map((f) => [f.entity, f.sources]))).toEqual({ auth: ['src/auth.ts'], db: null });
    } finally {
      into.close();
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('keeps T1\'s plan to facts that may leave', async () => {
    db.upsertFact('auth module', 'uses', 'JWT', 't3', undefined, ['src/auth.ts']);
    db.upsertFact('auth module', 'stores', 'hashes in vault', 't3'); // saved before sources were
    db.upsertFact('auth module', 'rotates', 'keys weekly', 't3', undefined, ['secret/runbook.md']);
    const plan = async (privacy: PrivacyPaths | undefined) => {
      const generate = vi.fn(async () => makeResult(PLAN_JSON));
      const router = { generate, getModelForTier: () => undefined, getWorldStateDB: () => db, getPrivacyPaths: () => privacy } as unknown as CascadeRouter;
      await new T1Administrator(router, makeToolRegistry(), {} as unknown as CascadeConfig).previewPlan('refactor the auth module');
      return generate.mock.calls[0]![1]!.messages[0]!.content as string;
    };
    const withRules = await plan(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]));
    expect(withRules).toContain('auth module uses JWT');
    expect(withRules).not.toContain('hashes in vault');
    expect(withRules).not.toContain('keys weekly');
    const without = await plan(undefined);
    expect(without).toContain('hashes in vault');
    expect(without).toContain('keys weekly');
  });
});
