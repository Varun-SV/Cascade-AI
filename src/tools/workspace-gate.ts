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
import { withLock } from '../utils/file-lock.js';

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
 * Who a caller runs with: `tools` — tool calls, with each other; `commands` —
 * commands, with each other; `alone` — with nobody.
 */
export type GateMode = 'tools' | 'commands' | 'alone';

const fits = (mode: GateMode, other: GateMode): boolean => mode !== 'alone' && mode === other;

export class WorkspaceGate {
  private running: Record<GateMode, number> = { tools: 0, commands: 0, alone: 0 };
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
   * it against other processes using the workspace as well.
   */
  async enter(mode: GateMode, acrossProcesses = false): Promise<() => void> {
    const leave = await new Promise<() => void>((resolve) => {
      this.queue.push({ mode, grant: () => resolve(this.leaver(mode)) });
      this.pump();
    });
    if (!acrossProcesses || !this.markers) return leave;
    let release: () => void;
    try {
      release = await (mode === 'alone' ? this.markers.alone() : this.markers.group(mode));
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

  /** A marker for a `tools` or `commands` caller, once no other process has one it cannot run with, nor the lock. */
  async group(mode: 'tools' | 'commands'): Promise<() => void> {
    fs.mkdirSync(this.dir, { recursive: true });
    for (;;) {
      const mine = withLock(this.mutex, 'take the workspace gate', () => {
        if (this.othersAlone() || this.others().some((other) => !fits(mode, other))) return null;
        const file = path.join(this.dir, `${mode}-${INSTANCE}-${++this.seq}`);
        fs.writeFileSync(file, '');
        return file;
      });
      if (mine) {
        this.hold(mine);
        return () => this.drop(mine);
      }
      await sleep(POLL_MS);
    }
  }

  /** The lock — which keeps new callers of other processes out — and then every other process's callers gone. */
  async alone(): Promise<() => void> {
    fs.mkdirSync(this.dir, { recursive: true });
    for (;;) {
      const took = withLock(this.mutex, 'take the workspace gate', () => {
        if (this.othersAlone()) return false;
        fs.writeFileSync(this.lock, INSTANCE);
        return true;
      });
      if (took) break;
      await sleep(POLL_MS);
    }
    this.hold(this.lock);
    try {
      await until(() => this.others().length === 0);
    } catch (err) {
      this.drop(this.lock);
      throw err;
    }
    return () => this.drop(this.lock);
  }

  /** Whether another process holds the lock. */
  private othersAlone(): boolean {
    let holder: string;
    try { holder = fs.readFileSync(this.lock, 'utf8'); } catch { return false; }
    if (holder === INSTANCE) return false;
    if (stale(this.lock)) { fs.rmSync(this.lock, { force: true }); return false; }
    return true;
  }

  /** The groups other processes have callers running in. */
  private others(): Array<'tools' | 'commands'> {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const found: Array<'tools' | 'commands'> = [];
    for (const name of names) {
      const match = /^(tools|commands)-(.+)-\d+$/.exec(name);
      if (!match || match[2] === INSTANCE) continue;
      const file = path.join(this.dir, name);
      if (stale(file)) { fs.rmSync(file, { force: true }); continue; }
      if (fs.existsSync(file)) found.push(match[1] as 'tools' | 'commands');
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
 * to RESTARTS_PER_MINUTE, so one that cannot start is not retried in a
 * loop — and a timer on this loop touches them too, so markers go stale only
 * if the thread is gone and the loop is busy past STALE_MS both. Exported
 * for tests.
 */
class Heartbeat {
  private readonly files = new Set<string>();
  private worker?: Worker;
  private backup?: ReturnType<typeof setInterval>;
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
      this.backup = undefined;
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
    if (this.starts.length >= RESTARTS_PER_MINUTE) return;
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

/** A marker not touched for longer than a holder ever leaves it: its process ended. */
function stale(file: string): boolean {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return !!st && Date.now() - st.mtimeMs > STALE_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await sleep(POLL_MS);
}
