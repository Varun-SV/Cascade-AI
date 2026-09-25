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
//  Tool calls take the gate shared; that command, and a local-only file
//  write, take it alone. First come, first served: a caller waiting to go
//  alone holds back the shared callers behind it, so it is not starved.
//
//  One gate per workspace in a process, however many registries use it; and,
//  where local-only work can happen, one across processes too — two runs in
//  one workspace are as likely in two windows as in one. That part is kept
//  in marker files in the project's state folder (`gate/`), out of reach of
//  commands and file tools: each shared caller leaves one while it runs, and the
//  caller going alone holds the lock file. Each side writes its own before
//  looking for the other's, so one of any two sees the other and waits.

import fs from 'node:fs';
import path from 'node:path';
import { statePath, STATE } from '../config/project-state.js';

/** How often a held marker is touched, and how long one untouched counts as left by a process that ended. */
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
/** How often a waiting caller looks again. */
const POLL_MS = 25;


const gates = new Map<string, WorkspaceGate>();

export class WorkspaceGate {
  private shared = 0;
  private alone = false;
  private queue: Array<{ alone: boolean; grant: () => void }> = [];
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
  async enter(alone: boolean, acrossProcesses = false): Promise<() => void> {
    const leave = await new Promise<() => void>((resolve) => {
      this.queue.push({ alone, grant: () => resolve(this.leaver(alone)) });
      this.pump();
    });
    if (!acrossProcesses || !this.markers) return leave;
    let release: () => void;
    try {
      release = await (alone ? this.markers.alone() : this.markers.shared());
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

  private leaver(alone: boolean): () => void {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (alone) this.alone = false;
      else this.shared -= 1;
      this.pump();
    };
  }

  private pump(): void {
    while (this.queue.length > 0 && !this.alone) {
      const next = this.queue[0]!;
      if (next.alone && this.shared > 0) return;
      this.queue.shift();
      if (next.alone) this.alone = true;
      else this.shared += 1;
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
  private readonly held = new Set<string>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private seq = 0;

  constructor(private readonly dir: string) {
    this.lock = path.join(dir, 'alone');
  }

  async shared(): Promise<() => void> {
    fs.mkdirSync(this.dir, { recursive: true });
    for (;;) {
      const mine = path.join(this.dir, `shared-${process.pid}-${++this.seq}`);
      fs.writeFileSync(mine, '');
      this.hold(mine);
      if (!this.othersAlone()) return () => this.drop(mine);
      this.drop(mine);
      await until(() => !this.othersAlone());
    }
  }

  async alone(): Promise<() => void> {
    fs.mkdirSync(this.dir, { recursive: true });
    for (;;) {
      try {
        fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (stale(this.lock)) { fs.rmSync(this.lock, { force: true }); continue; }
        await sleep(POLL_MS);
      }
    }
    this.hold(this.lock);
    try {
      await until(() => !this.othersShared());
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
    if (holder === String(process.pid)) return false;
    if (stale(this.lock)) { fs.rmSync(this.lock, { force: true }); return false; }
    return true;
  }

  /** Whether another process has a shared caller running. */
  private othersShared(): boolean {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return false; }
    const own = `shared-${process.pid}-`;
    return names.some((name) => {
      if (!name.startsWith('shared-') || name.startsWith(own)) return false;
      const file = path.join(this.dir, name);
      if (stale(file)) { fs.rmSync(file, { force: true }); return false; }
      return fs.existsSync(file);
    });
  }

  private hold(file: string): void {
    this.held.add(file);
    this.heartbeat ??= setInterval(() => {
      const now = new Date();
      for (const held of this.held) {
        try { fs.utimesSync(held, now, now); } catch { /* removed meanwhile */ }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private drop(file: string): void {
    this.held.delete(file);
    fs.rmSync(file, { force: true });
    if (this.held.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}

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
