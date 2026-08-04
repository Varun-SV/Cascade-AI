import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ResumeStore, RESUME_SCHEMA_VERSION, summarizeCompleted, type CompletedNode,
} from './resume-store.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-resume-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const node = (id: string, title = id): CompletedNode => ({
  id, title, status: 'COMPLETED', output: `output of ${id}`,
});

const checkpoint = (taskId: string, completed: CompletedNode[] = [node('a')]) => ({
  taskId, prompt: `prompt for ${taskId}`, reason: 'budget' as const,
  partialOutput: 'partial', completed,
});

describe('ResumeStore', () => {
  it('round-trips a checkpoint so finished work survives the process', async () => {
    const store = new ResumeStore({ dir });
    await store.save(checkpoint('run-1'));

    const latest = await store.latest();
    expect(latest?.taskId).toBe('run-1');
    expect(latest?.version).toBe(RESUME_SCHEMA_VERSION);
    expect(latest?.completed).toHaveLength(1);
    expect(latest?.completed[0]?.output).toBe('output of a');
  });

  it('consumes a checkpoint so the same work is never restored twice', async () => {
    const store = new ResumeStore({ dir });
    await store.save(checkpoint('run-1'));

    expect((await store.consume())?.taskId).toBe('run-1');
    expect(await store.latest()).toBeNull();
  });

  it('keeps only the newest N checkpoints', async () => {
    let clock = 1_000_000;
    const store = new ResumeStore({ dir, maxCheckpoints: 3, now: () => clock });

    for (let i = 1; i <= 5; i++) {
      clock += 1000;
      await store.save(checkpoint(`run-${i}`));
    }

    const all = await store.list();
    expect(all.map((c) => c.taskId)).toEqual(['run-5', 'run-4', 'run-3']);
  });

  it('does not offer a checkpoint past its expiry', async () => {
    let clock = 1_000_000_000;
    const store = new ResumeStore({ dir, maxAgeMs: 1000, now: () => clock });
    await store.save(checkpoint('old'));

    expect(await store.latest()).not.toBeNull();
    clock += 5000; // now well past maxAgeMs
    expect(await store.latest()).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('skips a corrupt checkpoint instead of failing the whole listing', async () => {
    // The store's own trigger list includes "crash", so damaged files are an
    // expected condition. One bad file must not hide the good ones.
    const store = new ResumeStore({ dir });
    await store.save(checkpoint('good'));
    await fs.writeFile(path.join(dir, `${Date.now()}-corrupt.json`), '{ not json', 'utf-8');

    const all = await store.list();
    expect(all.map((c) => c.taskId)).toEqual(['good']);
  });

  it('ignores a checkpoint written by an unknown schema version', async () => {
    const store = new ResumeStore({ dir });
    await fs.writeFile(
      path.join(dir, `${Date.now()}-future.json`),
      JSON.stringify({ version: RESUME_SCHEMA_VERSION + 1, taskId: 'future', prompt: '', createdAt: '', partialOutput: '', completed: [] }),
      'utf-8',
    );
    expect(await store.list()).toEqual([]);
  });

  it('returns nothing when the directory does not exist', async () => {
    const store = new ResumeStore({ dir: path.join(dir, 'nope') });
    expect(await store.latest()).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('does not throw when saving is impossible', async () => {
    // A save failure must never escalate a recoverable stop into a crash — the
    // store would then be making outcomes worse than having no store at all.
    // A regular file standing where the directory should be fails fast (ENOTDIR).
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, 'not a directory', 'utf-8');

    const store = new ResumeStore({ dir: path.join(blocker, 'checkpoints') });
    await expect(store.save(checkpoint('run-1'))).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it('sanitizes task ids that would be unsafe as filenames', async () => {
    const store = new ResumeStore({ dir });
    await store.save(checkpoint('../../etc/passwd'));

    const entries = await fs.readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('/');
    expect(entries[0]).not.toContain('..');
    // Still retrievable under its original id.
    expect((await store.latest())?.taskId).toBe('../../etc/passwd');
  });
});

describe('summarizeCompleted', () => {
  it('is empty for no completed work', () => {
    expect(summarizeCompleted([])).toBe('');
  });

  it('names each finished node and tells the planner not to redo it', () => {
    const summary = summarizeCompleted([node('a', 'Research'), node('b', 'Draft')]);
    expect(summary).toContain('do NOT redo');
    expect(summary).toContain('Research');
    expect(summary).toContain('Draft');
  });

  it('truncates long outputs — restoring context must not re-spend the budget', () => {
    const big: CompletedNode = { id: 'a', title: 'Big', status: 'COMPLETED', output: 'x'.repeat(5000) };
    const summary = summarizeCompleted([big], 100);
    expect(summary.length).toBeLessThan(400);
    expect(summary).toContain('…');
  });
});
