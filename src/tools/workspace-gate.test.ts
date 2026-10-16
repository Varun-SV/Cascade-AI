import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceGate, heartbeat, left } from './workspace-gate.js';
import { ownerToken } from '../utils/file-lock.js';
import { statePath, STATE, useProjectStateDir } from '../config/project-state.js';

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

  // The heartbeat ran on the holder's own event loop: synchronous work longer
  // than a marker lives let it go stale, and another process took it.
  it('keeps its markers fresh while its event loop is busy', async () => {
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-busy-')));
    const own = `${ws}-state`;
    const release = useProjectStateDir(ws, own);
    try {
      const leave = await new WorkspaceGate(ws).enter('tools', true);
      const dir = statePath(ws, 'gate');
      const marker = path.join(dir, (await fs.readdir(dir)).find((name) => name.startsWith('tools-'))!);
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(marker, old, old);
      // Blocked past one heartbeat, as a long synchronous walk would.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_500);
      expect(Date.now() - (await fs.stat(marker)).mtimeMs).toBeLessThan(5_000);
      leave();
    } finally {
      release();
      await fs.rm(ws, { recursive: true, force: true });
      await fs.rm(own, { recursive: true, force: true });
    }
  }, 20_000);

  // A heartbeat thread that ended was started again only by the next hold:
  // a caller already holding the gate alone let its marker go stale.
  it('starts the heartbeat again when it ends while the gate is held alone', async () => {
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-restart-')));
    const own = `${ws}-state`;
    const release = useProjectStateDir(ws, own);
    try {
      const leave = await new WorkspaceGate(ws).enter('alone', true);
      const lock = path.join(statePath(ws, 'gate'), 'alone');
      const first = heartbeat.thread()!;
      await first.terminate();
      await tick();
      const second = heartbeat.thread();
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lock, old, old);
      // Only the new thread can touch it while this loop is blocked.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_500);
      expect(Date.now() - (await fs.stat(lock)).mtimeMs).toBeLessThan(5_000);
      leave();
    } finally {
      release();
      await fs.rm(ws, { recursive: true, force: true });
      await fs.rm(own, { recursive: true, force: true });
    }
  }, 20_000);

  // Held up past STALE_MS — no heartbeat thread left, its loop blocked — a
  // holder's marker was taken from it by age alone.
  it.skipIf(!fsSync.existsSync('/proc/self/stat'))('takes no marker from a holder it can see running, however old', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-owner-'));
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => holder.once('spawn', r));
      const marker = path.join(dir, 'alone');
      await fs.writeFile(marker, ownerToken(holder.pid!));
      const old = new Date(Date.now() - 120_000);
      await fs.utimes(marker, old, old);
      expect(left(marker)).toBe(false);
      holder.kill('SIGKILL');
      await new Promise((r) => holder.once('exit', r));
      expect(left(marker)).toBe(true);
      // One whose owner cannot be asked after goes by its heartbeat.
      await fs.writeFile(marker, 'written by an older Cascade');
      expect(left(marker)).toBe(false);
      await fs.utimes(marker, old, old);
      expect(left(marker)).toBe(true);
    } finally {
      holder.kill('SIGKILL');
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // After five starts in a minute the thread was given up on for good.
  it('starts the heartbeat again once the minute\'s restarts have cleared', async () => {
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-retry-')));
    const own = `${ws}-state`;
    const release = useProjectStateDir(ws, own);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const leave = await new WorkspaceGate(ws).enter('alone', true);
      for (let i = 0; i < 10 && heartbeat.thread(); i++) {
        const thread = heartbeat.thread()!;
        await thread.terminate();
        await new Promise((r) => setImmediate(r));
      }
      expect(heartbeat.thread(), 'restarts used up').toBeUndefined();
      vi.advanceTimersByTime(61_000);
      expect(heartbeat.thread()).toBeDefined();
      leave();
    } finally {
      vi.useRealTimers();
      release();
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
    const tool = gate.enter('tools').then((leave) => { events.push('tool'); return leave; });
    await tick();
    expect(events).toEqual(['command']);
    (await command)(); await tick();
    expect(events).toEqual(['command', 'tool']);
    (await tool)();
  });

  // The jail takes what it puts back when a command ends as it finds it
  // when the command starts: a second command started while a first had
  // swapped .cascadeignore took the swapped one, and wrote it back after.
  it.each(['commands', 'git'] as const)('runs %s one at a time, in this process and across processes', async (mode) => {
    const gate = new WorkspaceGate();
    const events: string[] = [];
    const first = await gate.enter(mode);
    const second = gate.enter(mode).then((leave) => { events.push('second'); return leave; });
    await tick();
    expect(events).toEqual([]);
    first(); await tick();
    expect(events).toEqual(['second']);
    (await second)();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-commands-'));
    try {
      const markers = statePath(dir, STATE.gate);
      await fs.mkdir(markers, { recursive: true });
      const other = `${process.pid}.0123456789ab`;
      await fs.writeFile(path.join(markers, `${mode}-${other}-1`), '');
      let ran = false;
      const mine = new WorkspaceGate(dir).enter(mode, true).then((leave) => { ran = true; return leave; });
      await new Promise((r) => setTimeout(r, 100));
      expect(ran).toBe(false);
      await fs.rm(path.join(markers, `${mode}-${other}-1`));
      (await mine)();
      expect(ran).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // A command could swap a git config file for one naming a program, which
  // the jail puts back only when the command ends.
  it('keeps the git tool apart from commands', async () => {
    const gate = new WorkspaceGate();
    const events: string[] = [];
    const command = await gate.enter('commands');
    const git = gate.enter('git').then((leave) => { events.push('git'); return leave; });
    await tick();
    expect(events).toEqual([]);
    command(); await tick();
    expect(events).toEqual(['git']);
    const later = gate.enter('commands').then((leave) => { events.push('command'); return leave; });
    await tick();
    expect(events).toEqual(['git']);
    (await git)(); await tick();
    expect(events).toEqual(['git', 'command']);
    (await later)();
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
      expect(JSON.parse(await fs.readFile(path.join(markers, 'alone'), 'utf8')).pid, 'holding the lock while it waits').toBe(process.pid);
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
  // Any failure to read the markers read as none there: with a folder that
  // can be written but not listed, or a lock that is there but unreadable,
  // two processes went in together.
  it('refuses a turn when the markers cannot be listed, and waits on a lock it cannot read', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-unreadable-')));
    const markers = statePath(dir, 'gate');
    await fs.mkdir(markers, { recursive: true });
    const realReaddir = fsSync.readdirSync;
    const realRead = fsSync.readFileSync;
    const denied = (p: unknown) => Object.assign(new Error(`EACCES: permission denied, open '${String(p)}'`), { code: 'EACCES' });
    try {
      const gate = new WorkspaceGate(dir);
      const listing = vi.spyOn(fsSync, 'readdirSync').mockImplementation(((p: fsSync.PathLike, o?: unknown) => {
        if (String(p) === markers) throw denied(p);
        return (realReaddir as (p: fsSync.PathLike, o?: unknown) => unknown)(p, o);
      }) as typeof realReaddir);
      await expect(gate.enter('alone', true)).rejects.toThrow(/Could not read the workspace gate/);
      listing.mockRestore();
      // Another process's lock, there but unreadable: held, until it goes stale.
      const lock = path.join(markers, 'alone');
      await fs.writeFile(lock, `${process.ppid}.0123456789ab`);
      const reading = vi.spyOn(fsSync, 'readFileSync').mockImplementation(((p: fsSync.PathOrFileDescriptor, o?: unknown) => {
        if (String(p) === lock) throw denied(p);
        return (realRead as (p: fsSync.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
      }) as typeof realRead);
      let entered = false;
      const shared = gate.enter('tools', true).then((leave) => { entered = true; return leave; });
      await new Promise((r) => setTimeout(r, 150));
      expect(entered).toBe(false);
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lock, old, old);
      (await shared)();
      expect(entered).toBe(true);
      reading.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // A holder stalled past STALE_MS has its lock taken over; on waking, it
  // removed the new owner's lock, and let a third process in.
  it('leaves the lock alone at the end when another process has taken it over', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-takeover-')));
    try {
      const gate = new WorkspaceGate(dir);
      const leave = await gate.enter('alone', true);
      const lock = path.join(statePath(dir, 'gate'), 'alone');
      const other = `${process.ppid}.0123456789ab`;
      await fs.writeFile(lock, other);
      leave();
      expect(await fs.readFile(lock, 'utf8')).toBe(other);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Marks a process could not save kept only it right; another, reading
  // the record, took the files for public.
  it('keeps out of a workspace while another process holds unsaved marks, and refuses once it ended with them', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gate-pending-')));
    const markers = statePath(dir, 'gate');
    await fs.mkdir(markers, { recursive: true });
    try {
      const gate = new WorkspaceGate(dir);
      const marker = path.join(markers, 'pending-other.0123456789ab-1');
      await fs.writeFile(`${marker}.paths`, JSON.stringify(['secret/notes.md']));
      await fs.writeFile(marker, ownerToken(process.pid));
      let entered = false;
      const waiting = gate.enter('tools', true).then((leave) => { entered = true; leave(); }, (err: Error) => err);
      await new Promise((r) => setTimeout(r, 150));
      expect(entered).toBe(false);
      // Its process gone: refused, naming the file, never taken as gone.
      await fs.writeFile(marker, `${process.ppid}.0123456789ab`);
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(marker, old, old);
      expect(String(await waiting)).toMatch(/could record that secret\/notes\.md is local-only/);
      expect(fsSync.existsSync(marker)).toBe(true);
      // This process's own marker keeps others out, not itself.
      await fs.rm(marker);
      await fs.rm(`${marker}.paths`);
      const release = gate.holdPending(['mine.txt']);
      (await gate.enter('tools', true))();
      release();
      expect((await fs.readdir(markers)).filter((n) => n.startsWith('pending-'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
