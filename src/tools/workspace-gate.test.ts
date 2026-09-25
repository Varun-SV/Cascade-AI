import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceGate } from './workspace-gate.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('WorkspaceGate', () => {
  it('lets shared callers in together, and one alone only once they have left', async () => {
    const gate = new WorkspaceGate();
    const events: string[] = [];
    const a = await gate.enter(false);
    const b = await gate.enter(false);
    const alone = gate.enter(true).then((leave) => { events.push('alone'); return leave; });
    await tick();
    expect(events).toEqual([]);
    a(); await tick();
    expect(events).toEqual([]);
    b(); await tick();
    expect(events).toEqual(['alone']);
  });

  it('holds back shared callers that come after one waiting to go alone, so it is not starved', async () => {
    const gate = new WorkspaceGate();
    const events: string[] = [];
    const first = await gate.enter(false);
    const alone = gate.enter(true).then((leave) => { events.push('alone'); return leave; });
    const later = gate.enter(false).then((leave) => { events.push('later'); return leave; });
    await tick();
    expect(events).toEqual([]);
    first(); await tick();
    expect(events).toEqual(['alone']);
    (await alone)(); await tick();
    expect(events).toEqual(['alone', 'later']);
    (await later)();
  });

  it('ignores a second leave', async () => {
    const gate = new WorkspaceGate();
    const leave = await gate.enter(false);
    leave(); leave();
    const alone = await gate.enter(true);
    let shared = false;
    void gate.enter(false).then(() => { shared = true; });
    await tick();
    expect(shared).toBe(false);
    alone(); await tick();
    expect(shared).toBe(true);
  });

  // Each registry had a gate of its own, so a second run in the same
  // workspace — another window, another conversation — was not held back.
  it('is one gate per workspace in a process, whatever name the workspace goes by', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-')));
    const link = `${dir}-link`;
    await fs.symlink(dir, link);
    try {
      expect(WorkspaceGate.for(dir)).toBe(WorkspaceGate.for(link));
      expect(WorkspaceGate.for(dir)).not.toBe(WorkspaceGate.for(os.tmpdir()));
    } finally {
      await fs.rm(link, { force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Another process — the CLI beside the desktop app — is seen through the
  // markers it leaves in .cascade/gate/.
  it('waits for another process going alone, and holds back one that wants to, while running shared', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-')));
    const markers = path.join(dir, '.cascade', 'gate');
    await fs.mkdir(markers, { recursive: true });
    const other = String(process.ppid);
    try {
      const gate = new WorkspaceGate(dir);
      // Another process is alone: a shared caller waits for it to finish.
      await fs.writeFile(path.join(markers, 'alone'), other);
      let entered = false;
      const shared = gate.enter(false, true).then((leave) => { entered = true; return leave; });
      await new Promise((r) => setTimeout(r, 100));
      expect(entered).toBe(false);
      await fs.rm(path.join(markers, 'alone'));
      (await shared)();
      expect(entered).toBe(true);
      // Another process has a shared caller running: going alone waits for it.
      await fs.writeFile(path.join(markers, `shared-${other}-1`), '');
      let alone = false;
      const lone = gate.enter(true, true).then((leave) => { alone = true; return leave; });
      await new Promise((r) => setTimeout(r, 100));
      expect(alone).toBe(false);
      expect(await fs.readFile(path.join(markers, 'alone'), 'utf8'), 'holding the lock while it waits').toBe(String(process.pid));
      await fs.rm(path.join(markers, `shared-${other}-1`));
      const leave = await lone;
      leave();
      await expect(fs.stat(path.join(markers, 'alone'))).rejects.toThrow();
      // Markers left by a process that ended are not waited on.
      await fs.writeFile(path.join(markers, 'alone'), other);
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(markers, 'alone'), old, old);
      (await gate.enter(false, true))();
      expect((await fs.readdir(markers)).filter((n) => n.startsWith('shared-'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
