// ─────────────────────────────────────────────
//  Cascade AI — Who may use the workspace at once
// ─────────────────────────────────────────────
//
//  What a local-only subtask writes is marked local-only (privacy/paths.ts).
//  A file tool's write is marked before it happens; a command's writes can
//  only be found once it has ended. Until then, a file it wrote looks like
//  any other — so while it runs, no other tool call may run: a read would
//  see what it wrote, and a write would be marked local-only along with it.
//
//  It also keeps tool calls and commands apart. A file tool checks a path —
//  inside the workspace, not protected — and then opens it; a command
//  running meanwhile could swap it for a symlink to a secret in between. So
//  commands run alongside each other, and tool calls alongside each other,
//  but a tool call waits while a command runs, and a command waits for the
//  tool calls in progress. A local-only subtask's command, and its file
//  writes, take it alone. First come, first served: a caller waiting holds
//  back those behind it that it cannot run with, so it is not starved.
//
//  One gate per workspace in a process, however many registries use it; and
//  one across processes too — two runs in one workspace are as likely in two
//  windows as in one, and either may be the one with local-only work. That part is kept
//  in marker files in the project's state folder (`gate/`), out of reach of
//  commands and file tools: each caller leaves one, named for its group and
//  its process, while it runs, and the caller going alone holds the lock
//  file. Looking for the other side's and leaving one's own are done under a
//  short mutex, so of any two that cannot run together one sees the other.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { onProjectReleased, statePath, STATE } from '../config/project-state.js';
import { ownerState, ownerToken, withLock } from '../utils/file-lock.js';

/** How often a held marker is touched, and how long one untouched counts as left by a process that ended. */
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
/** How often a waiting caller looks again. */
const POLL_MS = 25;


const gates = new Map<string, WorkspaceGate>();

// A host's workspace whose last run ended: its gate goes, unless something
// is still in it — the next caller makes a new one, with the state folder
// named for it then.
onProjectReleased((root) => {
  if (gates.get(root)?.idle()) gates.delete(root);
});

/** This process's name in marker files: a process ID alone repeats across PID namespaces sharing a volume. */
const INSTANCE = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
/**
 * What this process's markers hold: who left them (file-lock.ts), so another
 * process removes one only once its owner is gone, or — where that cannot be
 * known — once it has gone untouched for STALE_MS.
 */
const OWNER = ownerToken(process.pid);

/**
 * Who a caller runs with: `tools` — tool calls, with each other; `commands` —
 * commands, one at a time; `git` — the git tool's calls, with each other;
 * `alone` — with nobody. The git tool runs apart from commands: one could
 * swap a git config file for another that names a program for it to run,
 * which the jail puts back when that command ends (process-jail.ts). And a
 * command runs apart from other commands: the jail takes what it puts back
 * when one starts, which a command already running could have swapped.
 */
export type GateMode = 'tools' | 'commands' | 'git' | 'alone';

const fits = (mode: GateMode, other: GateMode): boolean => mode !== 'alone' && mode !== 'commands' && mode === other;

type GroupMode = Exclude<GateMode, 'alone'>;

export class WorkspaceGate {
  private running: Record<GateMode, number> = { tools: 0, commands: 0, git: 0, alone: 0 };
  private queue: Array<{ mode: GateMode; grant: () => void }> = [];
  private readonly markers?: Markers;

  /** This process's gate for a workspace. */
  static for(workspaceRoot: string): WorkspaceGate {
    let root: string;
    try { root = fs.realpathSync(workspaceRoot); } catch { root = path.resolve(workspaceRoot); }
    let gate = gates.get(root);
    if (!gate) gates.set(root, gate = new WorkspaceGate(root));
    return gate;
  }

  /** @param workspaceRoot where the markers for other processes go; without it, this process only. */
  constructor(workspaceRoot?: string) {
    if (workspaceRoot) this.markers = new Markers(statePath(workspaceRoot, STATE.gate));
  }

  /**
   * Wait for a turn; the function returned ends it. `acrossProcesses` takes
   * it against other processes using the workspace as well. `signal` gives
   * up the wait — the caller's run was cancelled — leaving nothing behind.
   */
  async enter(mode: GateMode, acrossProcesses = false, signal?: AbortSignal): Promise<() => void> {
    const leave = await new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) { reject(cancelled(signal)); return; }
      const entry = {
        mode,
        grant: () => {
          signal?.removeEventListener('abort', giveUp);
          resolve(this.leaver(mode));
        },
      };
      const giveUp = () => {
        const at = this.queue.indexOf(entry);
        if (at === -1) return;
        this.queue.splice(at, 1);
        this.pump();
        reject(cancelled(signal!));
      };
      signal?.addEventListener('abort', giveUp, { once: true });
      this.queue.push(entry);
      this.pump();
    });
    if (!acrossProcesses || !this.markers) return leave;
    let release: () => void;
    try {
      release = await (mode === 'alone' ? this.markers.alone(signal) : this.markers.group(mode, signal));
    } catch (err) {
      leave();
      throw err;
    }
    let left = false;
    return () => {
      if (left) return;
      left = true;
      release();
      leave();
    };
  }

  /**
   * Keep every other process out of the workspace until the function
   * returned is called: this one holds marks a local-only command made that
   * the privacy record does not have yet, so another process, reading the
   * record, would take those files for public. Should this process end
   * first, the marker stays, and other processes refuse to go on — naming
   * the files — rather than take it as gone.
   */
  holdPending(paths: string[]): () => void {
    return this.markers?.pending(paths) ?? (() => {});
  }

  /** Whether no one is in the gate or waiting for it. */
  idle(): boolean {
    return this.queue.length === 0 && Object.values(this.running).every((n) => n === 0);
  }

  private leaver(mode: GateMode): () => void {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.running[mode] -= 1;
      this.pump();
    };
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      const blocked = (Object.keys(this.running) as GateMode[]).some((mode) => this.running[mode] > 0 && !fits(next.mode, mode));
      if (blocked) return;
      this.queue.shift();
      this.running[next.mode] += 1;
      next.grant();
    }
  }
}

/**
 * The gate's part between processes. Within one, the gate above has already
 * ordered its callers, so a process's own markers are not waited on.
 */
class Markers {
  private readonly lock: string;
  private readonly mutex: string;
  private readonly held = new Set<string>();
  private seq = 0;

  constructor(private readonly dir: string) {
    this.lock = path.join(dir, 'alone');
    this.mutex = path.join(dir, 'mutex');
  }

  /** A marker for a `tools`, `commands` or `git` caller, once no other process has one it cannot run with, nor the lock. */
  async group(mode: GroupMode, signal?: AbortSignal): Promise<() => void> {
    fs.mkdirSync(this.dir, { recursive: true });
    for (;;) {
      if (signal?.aborted) throw cancelled(signal);
      const mine = withLock(this.mutex, 'take the workspace gate', () => {
        if (this.othersAlone() || this.othersPending() || this.others().some((other) => !fits(mode, other))) return null;
        const file = path.join(this.dir, `${mode}-${INSTANCE}-${++this.seq}`);
        fs.writeFileSync(file, OWNER);
        return file;
      });
      if (mine) {
        this.hold(mine);
        return () => this.drop(mine);
      }
      await sleep(POLL_MS);
    }
  }

  /** A marker that keeps every other process out — see WorkspaceGate.holdPending — with the paths it is for beside it. */
  pending(paths: string[]): () => void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `pending-${INSTANCE}-${++this.seq}`);
    fs.writeFileSync(`${file}.paths`, JSON.stringify(paths));
    fs.writeFileSync(file, OWNER);
    this.hold(file);
    return () => {
      this.drop(file);
      fs.rmSync(`${file}.paths`, { force: true });
    };
  }

  /**
   * Whether another process holds a pending marker: it is waited for while
   * it runs. One whose process ended is never taken as gone — the marks it
   * held were never recorded — and refuses every turn, naming its files.
   */
  private othersPending(): boolean {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(`Could not read the workspace gate in ${this.dir} (${(err as Error).message}), so whether another Cascade process is using the workspace cannot be told.`);
    }
    let waiting = false;
    for (const name of names) {
      const match = /^pending-(.+)-\d+$/.exec(name);
      if (!match || match[1] === INSTANCE) continue;
      const file = path.join(this.dir, name);
      if (!left(file)) { waiting = true; continue; }
      let paths: string[] = [];
      try { paths = JSON.parse(fs.readFileSync(`${file}.paths`, 'utf8')) as string[]; } catch { /* unreadable */ }
      throw new Error(`A Cascade process ended before it could record that ${paths.length ? paths.join(', ') : 'some files'} ${paths.length === 1 ? 'is' : 'are'} local-only (privacy.paths), so nothing runs in this workspace until they are: add them to the project's privacy-derived.json, then remove ${file}.`);
    }
    return waiting;
  }

  /** The lock — which keeps new callers of other processes out — and then every other process's callers gone. */
  async alone(signal?: AbortSignal): Promise<() => void> {
    fs.mkdirSync(this.dir, { recursive: true });
    for (;;) {
      if (signal?.aborted) throw cancelled(signal);
      const took = withLock(this.mutex, 'take the workspace gate', () => {
        if (this.othersAlone() || this.othersPending()) return false;
        fs.writeFileSync(this.lock, OWNER);
        return true;
      });
      if (took) break;
      await sleep(POLL_MS);
    }
    this.hold(this.lock);
    try {
      await until(() => this.others().length === 0 && !this.othersPending(), signal);
    } catch (err) {
      this.drop(this.lock);
      throw err;
    }
    return () => this.drop(this.lock);
  }

  /** Whether another process holds the lock. */
  private othersAlone(): boolean {
    let holder: string;
    try {
      holder = fs.readFileSync(this.lock, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      // There, but not readable: whose it is cannot be known, so it is
      // held — until it goes stale, as any lock whose owner cannot be.
      holder = '';
    }
    if (holder === OWNER) return false;
    if (left(this.lock)) { fs.rmSync(this.lock, { force: true }); return false; }
    return true;
  }

  /** The groups other processes have callers running in. */
  private others(): GroupMode[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Not listable is not empty: another process may hold a turn here.
      throw new Error(`Could not read the workspace gate in ${this.dir} (${(err as Error).message}), so whether another Cascade process is using the workspace cannot be told.`);
    }
    const found: GroupMode[] = [];
    for (const name of names) {
      const match = /^(tools|commands|git)-(.+)-\d+$/.exec(name);
      if (!match || match[2] === INSTANCE) continue;
      const file = path.join(this.dir, name);
      if (left(file)) { fs.rmSync(file, { force: true }); continue; }
      if (fs.existsSync(file)) found.push(match[1] as GroupMode);
    }
    return found;
  }

  private hold(file: string): void {
    this.held.add(file);
    heartbeat.hold(file);
  }

  private drop(file: string): void {
    this.held.delete(file);
    heartbeat.drop(file);
    // The lock has one name for every process: it is removed only while it
    // is still this one's. Taken over as stale — a holder stalled past
    // STALE_MS — it is another's now, and removing it would let a third in.
    if (file === this.lock) {
      let holder = '';
      try { holder = fs.readFileSync(file, 'utf8'); } catch { /* gone */ }
      if (holder !== OWNER) return;
    }
    fs.rmSync(file, { force: true });
  }
}

/**
 * Touches this process's held markers every HEARTBEAT_MS, from a thread of
 * its own: a holder whose event loop is busy in synchronous work for longer
 * than STALE_MS — walking a large git store, say — is alive all the same,
 * and a timer on its own loop would let its markers go stale and be taken
 * from it. One per process, started with the first marker held, and never
 * keeping the process alive.
 *
 * A thread that ends while markers are held is started again at once — up
 * to RESTARTS_PER_MINUTE, then again as each minute's window clears, so one
 * that cannot start is not retried in a loop nor given up on — and a timer
 * on this loop touches them too. Another process on this host and in this
 * PID namespace asks whether the holder is running (`left`); only one that
 * cannot ask goes by the heartbeat alone. Exported for tests.
 */
class Heartbeat {
  private readonly files = new Set<string>();
  private worker?: Worker;
  private backup?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private starts: number[] = [];

  hold(file: string): void {
    this.files.add(file);
    this.send();
  }

  drop(file: string): void {
    this.files.delete(file);
    this.send();
  }

  private send(): void {
    if (this.files.size === 0) {
      if (this.backup) clearInterval(this.backup);
      if (this.retry) clearTimeout(this.retry);
      this.backup = undefined;
      this.retry = undefined;
    } else {
      this.backup ??= setInterval(() => touch([...this.files]), HEARTBEAT_MS);
      this.backup.unref?.();
      this.start();
    }
    this.worker?.postMessage([...this.files]);
  }

  private start(): void {
    if (this.worker) return;
    const now = Date.now();
    this.starts = this.starts.filter((at) => now - at < 60_000);
    if (this.starts.length >= RESTARTS_PER_MINUTE) {
      // Tried again once the oldest start leaves the window, not given up on.
      this.retry ??= setTimeout(() => {
        this.retry = undefined;
        if (this.files.size > 0) this.send();
      }, 60_000 - (now - this.starts[0]!) + 1);
      this.retry.unref?.();
      return;
    }
    this.starts.push(now);
    let worker: Worker;
    try {
      worker = new Worker(HEARTBEAT_SOURCE, { eval: true, workerData: HEARTBEAT_MS });
    } catch {
      return;
    }
    worker.unref();
    const ended = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      if (this.files.size > 0) this.send();
    };
    worker.on('error', ended);
    worker.on('exit', ended);
    this.worker = worker;
  }

  /** The thread now running, if any. For tests. */
  thread(): Worker | undefined {
    return this.worker;
  }
}

export const heartbeat = new Heartbeat();

/** How often in a minute the heartbeat thread is started again before only the backup timer is left. */
const RESTARTS_PER_MINUTE = 5;

function touch(files: string[]): void {
  const now = new Date();
  for (const file of files) {
    try { fs.utimesSync(file, now, now); } catch { /* removed meanwhile */ }
  }
}

const HEARTBEAT_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
let files = [];
parentPort.on('message', (list) => { files = list; });
setInterval(() => {
  const now = new Date();
  for (const file of files) {
    try { fs.utimesSync(file, now, now); } catch { /* removed meanwhile */ }
  }
}, workerData);
`;

/**
 * Whether a marker was left by a process that ended: at once when its owner
 * is known to be gone, never while it is known to be running — however long
 * its heartbeat has been held up — and otherwise once it has gone untouched
 * for longer than a holder ever leaves it. Exported for tests.
 */
export function left(file: string): boolean {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return false;
  let owner = '';
  try { owner = fs.readFileSync(file, 'utf8'); } catch { /* removed meanwhile */ }
  const state = ownerState(owner);
  if (state !== 'unknown') return state === 'dead';
  return Date.now() - st.mtimeMs > STALE_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(done: () => boolean, signal?: AbortSignal): Promise<void> {
  while (!done()) {
    if (signal?.aborted) throw cancelled(signal);
    await sleep(POLL_MS);
  }
}

/** Why a wait for the gate was given up: the caller's run was cancelled. */
function cancelled(signal: AbortSignal): Error {
  const err = new Error('The call was cancelled while it waited for its turn in the workspace.', { cause: signal.reason });
  err.name = 'AbortError';
  return err;
}
