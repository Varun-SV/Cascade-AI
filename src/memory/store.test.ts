import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('MemoryStore runtime persistence', () => {
  it('stores runtime sessions, nodes, and logs', async () => {
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

  it('handles file snapshots and session branching', async () => {
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
