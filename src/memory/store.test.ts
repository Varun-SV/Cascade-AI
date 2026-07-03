import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';

// better-sqlite3 requires a native binary compiled for the current platform.
// When the binary is missing or built for a different OS (e.g. Windows binary
// running in a Linux sandbox) the tests are skipped rather than failing.
const nativeRequire = createRequire(import.meta.url);
const hasSqlite = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const Database = nativeRequire('better-sqlite3');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const db = new Database(':memory:');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    db.close();
    return true;
  } catch {
    return false;
  }
})();

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('MemoryStore runtime persistence', () => {
  it.skipIf(!hasSqlite)('stores runtime sessions, nodes, and logs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-store-'));
    tempDirs.push(dir);

    const store = new MemoryStore(path.join(dir, 'memory.db'));
    store.upsertRuntimeSession({
      sessionId: 'session-1',
      title: 'Test Run',
      workspacePath: '/tmp/project',
      status: 'ACTIVE',
      startedAt: new Date('2026-04-03T06:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-04-03T06:01:00.000Z').toISOString(),
      latestPrompt: 'proceed',
    });
    store.upsertRuntimeNode({
      tierId: 'T2_demo',
      sessionId: 'session-1',
      parentId: 'T1',
      role: 'T2',
      label: 'Manager',
      status: 'ACTIVE',
      currentAction: 'Coordinating workers',
      progressPct: 40,
      updatedAt: new Date('2026-04-03T06:01:10.000Z').toISOString(),
    });
    store.addRuntimeNodeLog({
      id: 'log-1',
      sessionId: 'session-1',
      tierId: 'T2_demo',
      role: 'T2',
      label: 'Manager',
      status: 'ACTIVE',
      currentAction: 'Coordinating workers',
      progressPct: 40,
      timestamp: new Date('2026-04-03T06:01:20.000Z').toISOString(),
    });

    expect(store.listRuntimeSessions(10)).toHaveLength(1);
    expect(store.listRuntimeNodes('session-1', 10)[0]?.label).toBe('Manager');
    expect(store.listRuntimeNodeLogs('session-1', 'T2_demo', 10)[0]?.currentAction).toBe('Coordinating workers');

    store.close();
  });

  it.skipIf(!hasSqlite)('handles file snapshots and session branching', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rollback-'));
    tempDirs.push(dir);
    const store = new MemoryStore(path.join(dir, 'memory.db'));

    const sessionId = 'session-orig';
    store.createSession({
      id: sessionId,
      title: 'Original Session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      identityId: 'default',
      workspacePath: dir,
      messages: [],
      metadata: { totalTokens: 0, totalCostUsd: 0, modelsUsed: [], toolsUsed: [], taskCount: 0 },
    });

    // Test snapshots
    store.addFileSnapshot(sessionId, 'file1.txt', 'v1 content');
    store.addFileSnapshot(sessionId, 'file1.txt', 'v2 content (ignored for rollback)');
    store.addFileSnapshot(sessionId, 'file2.txt', 'v1 content of file2');

    const snapshots = store.getLatestFileSnapshots(sessionId);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.find(s => s.filePath === 'file1.txt')?.content).toBe('v1 content');
    expect(snapshots.find(s => s.filePath === 'file2.txt')?.content).toBe('v1 content of file2');

    // Test branching
    const branchId = 'session-branch';
    store.branchSession(sessionId, branchId);
    
    const branched = store.getSession(branchId);
    expect(branched).not.toBeNull();
    expect(branched?.title).toContain('Branch');
    
    const branchSnaps = store.getLatestFileSnapshots(branchId);
    expect(branchSnaps).toHaveLength(2);
    expect(branchSnaps.find(s => s.filePath === 'file1.txt')?.content).toBe('v1 content');

    store.close();
  });
});

describe('MemoryStore export / import (v0.15.0)', () => {
  it.skipIf(!hasSqlite)('round-trips sessions with fresh ids and never overwrites', async () => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-exp-'));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-imp-'));
    tempDirs.push(dirA, dirB);

    const src = new MemoryStore(path.join(dirA, 'memory.db'));
    const now = new Date().toISOString();
    src.createSession({
      id: 'orig-1', title: 'My chat', createdAt: now, updatedAt: now,
      identityId: 'default', workspacePath: '/w', messages: [],
      metadata: { totalTokens: 5, totalCostUsd: 0.01, modelsUsed: [], toolsUsed: [], taskCount: 1 },
    });
    // Direct insert (addMessage is queued/async) so the export sees it now.
    src.importSessions([]); // no-op, just proves empty input is safe
    const bundleSessions = src.exportSessions(['orig-1']);
    bundleSessions[0]!.messages = [
      { id: 'm1', sessionId: 'orig-1', role: 'user', content: 'hello', timestamp: now },
      { id: 'm2', sessionId: 'orig-1', role: 'assistant', content: 'hi!', timestamp: now },
    ];

    const dst = new MemoryStore(path.join(dirB, 'memory.db'));
    const imported = dst.importSessions(bundleSessions);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.id).not.toBe('orig-1');           // fresh id — never overwrites
    expect(imported[0]!.title).toContain('(imported)');

    const got = dst.getSession(imported[0]!.id);
    expect(got?.messages).toHaveLength(2);
    expect(got?.messages[0]?.content).toBe('hello');

    // Re-importing duplicates under ANOTHER fresh id (still no overwrite).
    const again = dst.importSessions(bundleSessions);
    expect(again[0]!.id).not.toBe(imported[0]!.id);

    src.close();
    dst.close();
  });

  it.skipIf(!hasSqlite)('imports identities deduped by name, never as default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-ident-'));
    tempDirs.push(dir);
    const store = new MemoryStore(path.join(dir, 'memory.db'));
    const now = new Date().toISOString();
    store.createIdentity({ id: 'i1', name: 'Reviewer', createdAt: now, isDefault: true });

    const n = store.importIdentities([
      { id: 'x', name: 'Reviewer', createdAt: now, isDefault: true },   // dup name → skipped
      { id: 'y', name: 'Architect', createdAt: now, isDefault: true },  // new → imported, not default
    ]);
    expect(n).toBe(1);
    const all = store.listIdentities();
    expect(all.filter((i) => i.name === 'Reviewer')).toHaveLength(1);
    const architect = all.find((i) => i.name === 'Architect');
    expect(architect).toBeTruthy();
    expect(architect!.isDefault).toBe(false);
    store.close();
  });

  it.skipIf(!hasSqlite)('persists and reads back a probed capability verdict', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-caps-'));
    tempDirs.push(dir);
    const store = new MemoryStore(path.join(dir, 'memory.db'));

    expect(store.getModelProfile('my-custom.gguf', 'openai-compatible')).toBeUndefined();
    store.saveModelCapability('my-custom.gguf', 'openai-compatible', { supportsToolUse: false });
    expect(store.getModelProfile('my-custom.gguf', 'openai-compatible')?.supportsToolUse).toBe(false);

    // Merges with an existing profile rather than clobbering it.
    store.saveModelProfile('my-custom.gguf', 'openai-compatible', ['code']);
    const merged = store.getModelProfile('my-custom.gguf', 'openai-compatible');
    expect(merged?.supportsToolUse).toBe(false);
    expect(merged?.specializations).toEqual(['code']);
    store.close();
  });
});
