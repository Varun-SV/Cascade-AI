import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceGate } from './workspace-gate.js';
import { statePath, useProjectStateDir } from '../config/project-state.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('WorkspaceGate', () => {
  // Kept for every workspace a host ever ran in, after the runs ended.
  it('is forgotten with a host\'s workspace when no one is in it', async () => {
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-held-')));
    const own = `${ws}-state`;
    try {
      const first = useProjectStateDir(ws, own);
      const busy = WorkspaceGate.for(ws);
      const leave = await busy.enter('tools');
      first();
      expect(WorkspaceGate.for(ws), 'still in use').toBe(busy);
      leave();
      useProjectStateDir(ws, own)();
      expect(WorkspaceGate.for(ws)).not.toBe(busy);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
      await fs.rm(own, { recursive: true, force: true });
    }
  });

  it('lets shared callers in together, and one alone only once they have left', async () => {
    const gate = new WorkspaceGate();
    const events: string[] = [];
    const a = await gate.enter('tools');
    const b = await gate.enter('tools');
    const alone = gate.enter('alone').then((leave) => { events.push('alone'); return leave; });
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
    const first = await gate.enter('tools');
    const alone = gate.enter('alone').then((leave) => { events.push('alone'); return leave; });
    const later = gate.enter('tools').then((leave) => { events.push('later'); return leave; });
    await tick();
    expect(events).toEqual([]);
    first(); await tick();
    expect(events).toEqual(['alone']);
    (await alone)(); await tick();
    expect(events).toEqual(['alone', 'later']);
    (await later)();
  });

  // A file tool checks a path and then opens it: a command running meanwhile
  // could swap it for a symlink to a secret in between.
  it('keeps tool calls and commands apart, each running with its own kind', async () => {
    const gate = new WorkspaceGate();
    const events: string[] = [];
    const tool1 = await gate.enter('tools');
    const tool2 = await gate.enter('tools');
    const command = gate.enter('commands').then((leave) => { events.push('command'); return leave; });
    await tick();
    expect(events).toEqual([]);
    tool1(); tool2(); await tick();
    expect(events).toEqual(['command']);
    const second = await gate.enter('commands');
    const tool = gate.enter('tools').then((leave) => { events.push('tool'); return leave; });
    await tick();
    expect(events).toEqual(['command']);
    (await command)(); second(); await tick();
    expect(events).toEqual(['command', 'tool']);
    (await tool)();
  });

  it('ignores a second leave', async () => {
    const gate = new WorkspaceGate();
    const leave = await gate.enter('tools');
    leave(); leave();
    const alone = await gate.enter('alone');
    let shared = false;
    void gate.enter('tools').then(() => { shared = true; });
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
  // markers it leaves in the project's state folder (gate/).
  it('waits for another process going alone, and holds back one that wants to, while running shared', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-')));
    const markers = statePath(dir, 'gate');
    await fs.mkdir(markers, { recursive: true });
    const other = `${process.ppid}.0123456789ab`;
    try {
      const gate = new WorkspaceGate(dir);
      // Another process is alone: a shared caller waits for it to finish.
      await fs.writeFile(path.join(markers, 'alone'), other);
      let entered = false;
      const shared = gate.enter('tools', true).then((leave) => { entered = true; return leave; });
      await new Promise((r) => setTimeout(r, 100));
      expect(entered).toBe(false);
      await fs.rm(path.join(markers, 'alone'));
      (await shared)();
      expect(entered).toBe(true);
      // Another process has a shared caller running: going alone waits for it.
      await fs.writeFile(path.join(markers, `tools-${other}-1`), '');
      let alone = false;
      const lone = gate.enter('alone', true).then((leave) => { alone = true; return leave; });
      await new Promise((r) => setTimeout(r, 100));
      expect(alone).toBe(false);
      expect(await fs.readFile(path.join(markers, 'alone'), 'utf8'), 'holding the lock while it waits').toMatch(new RegExp(`^${process.pid}\\.`));
      await fs.rm(path.join(markers, `tools-${other}-1`));
      const leave = await lone;
      leave();
      await expect(fs.stat(path.join(markers, 'alone'))).rejects.toThrow();
      // A command in another process keeps tool calls out, and the other way
      // round — the other process known by an id of its own, not its PID,
      // which a process in another PID namespace can share.
      const twin = `${process.pid}.fedcba987654`;
      await fs.writeFile(path.join(markers, `commands-${twin}-1`), '');
      let tooled = false;
      const tool = gate.enter('tools', true).then((leave) => { tooled = true; return leave; });
      await new Promise((r) => setTimeout(r, 100));
      expect(tooled).toBe(false);
      await fs.rm(path.join(markers, `commands-${twin}-1`));
      (await tool)();
      expect(tooled).toBe(true);
      // Markers left by a process that ended are not waited on.
      await fs.writeFile(path.join(markers, 'alone'), other);
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(markers, 'alone'), old, old);
      (await gate.enter('tools', true))();
      expect((await fs.readdir(markers)).filter((n) => /^(tools|commands)-/.test(n))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
