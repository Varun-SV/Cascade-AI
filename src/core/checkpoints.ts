// ─────────────────────────────────────────────
//  Cascade AI — Checkpoints: undo a run
// ─────────────────────────────────────────────
//
//  Before each run, and again after it, the project's files are recorded in
//  a git repository of Cascade's own, kept in the project's state folder,
//  outside the project. The project's own git, if it has one, is never
//  touched: no commit, no stash, no change to its index. `/undo` puts back
//  just the files the last run (or the last n) changed, as they were before
//  it, and removes the files it made. A file the person changed by hand after
//  the run is left alone and named, unless they ask for it anyway.
//
//  What the project's .gitignore leaves out (node_modules, build output…) is
//  not recorded, and so not put back either. A run whose checkpoint could not
//  be taken (no git, a folder too big to record in time) is not undoable, and
//  auto mode then asks about its changes as it did before.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Checkpoint {
  /** 1, 2, 3… in the order runs started. */
  n: number;
  /** What the run was asked, cut short. */
  label: string;
  /** When the run started (ISO). */
  at: string;
  /** The project as it was before the run. */
  before: string;
  /** …and after it, once it has ended. */
  after?: string;
  /** How many files the run changed, made or deleted, once it has ended. */
  changed?: number;
  /** Put back by /undo. */
  undone?: boolean;
}

export interface UndoResult {
  /** The runs undone, newest first. */
  runs: Checkpoint[];
  /** Files put back as they were. */
  restored: string[];
  /** Files the runs made, now removed. */
  removed: string[];
  /** Files changed since the run by someone else, left as they are. */
  skipped: string[];
}

const KEEP = 50;
/** Folders that are never worth recording, whatever the project's .gitignore says. */
const ALWAYS_LEFT_OUT = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.next/', '.turbo/', '.cache/', '.gradle/', 'target/debug/', 'target/release/', '*.pyc', '.DS_Store', 'Thumbs.db'];

export class Checkpoints {
  private readonly gitDir: string;
  private readonly indexFile: string;
  private ready?: Promise<boolean>;

  /**
   * @param root the project folder
   * @param dir a folder of Cascade's own for it, outside the project (STATE.checkpoints)
   * @param timeoutMs how long recording may take before the run goes ahead without a checkpoint
   */
  constructor(private readonly root: string, private readonly dir: string, private readonly timeoutMs = 60_000) {
    this.gitDir = path.join(dir, 'repo.git');
    this.indexFile = path.join(dir, 'checkpoints.json');
  }

  /** Every checkpoint, oldest first. */
  list(): Checkpoint[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as Checkpoint[]) : [];
    } catch { return []; }
  }

  /** Record the project before a run. Null when it can't be: the run is then not undoable. */
  async begin(label: string): Promise<Checkpoint | null> {
    if (!(await this.prepare())) return null;
    const before = await this.snapshot('before a run').catch(() => null);
    if (!before) return null;
    const all = this.list();
    const cp: Checkpoint = { n: (all.at(-1)?.n ?? 0) + 1, label: oneLine(label, 80), at: new Date().toISOString(), before };
    await this.git(['update-ref', `refs/cascade/${cp.n}`, before]);
    this.save([...all, cp]);
    return cp;
  }

  /** Record the project after the run that `begin` returned `cp` for. */
  async end(cp: Checkpoint): Promise<Checkpoint> {
    const after = await this.snapshot('after a run').catch(() => null);
    if (!after) return cp;
    const changed = (await this.diff(cp.before, after)).length;
    await this.git(['update-ref', `refs/cascade/${cp.n}-after`, after]).catch(() => undefined);
    const done = { ...cp, after, changed };
    this.save(this.list().map((c) => (c.n === cp.n ? done : c)));
    return done;
  }

  /** The files a run changed, made or deleted: [status, path], status A (made), D (deleted) or M. */
  async changedBy(cp: Checkpoint): Promise<Array<[string, string]>> {
    const after = cp.after ?? (await this.snapshot('now'));
    return this.diff(cp.before, after);
  }

  /**
   * Put back what the last `count` runs not yet undone changed. A file
   * changed again since by someone else is left as it is (`skipped`), unless
   * `force`. Taken back as a whole: the state before it is recorded first.
   */
  async undo(count = 1, force = false): Promise<UndoResult> {
    if (!(await this.prepare())) throw new Error('Checkpoints need git, and git could not be run here.');
    const all = this.list();
    const runs = all.filter((c) => !c.undone).slice(-Math.max(1, count)).reverse();
    if (!runs.length) return { runs: [], restored: [], removed: [], skipped: [] };
    const now = await this.snapshot('before /undo');
    const oldest = runs.at(-1)!;
    // Each path the runs touched, and the state the last run touching it left it in.
    const touched = new Map<string, string>();
    for (const run of [...runs].reverse()) {
      for (const [, p] of await this.diff(run.before, run.after ?? now)) touched.set(p, run.after ?? now);
    }
    const skipped: string[] = [];
    const paths: string[] = [];
    for (const [p, leftBy] of touched) {
      if (!force && leftBy !== now && !(await this.same(leftBy, now, p))) skipped.push(p);
      else paths.push(p);
    }
    const restored: string[] = [];
    const removed: string[] = [];
    if (paths.length) {
      const status = new Map((await this.diff(oldest.before, now, paths)).map(([s, p]) => [p, s]));
      for (const p of paths) {
        const s = status.get(p);
        if (!s) continue; // already as it was
        if (s === 'A') removed.push(p);
        else restored.push(p);
      }
      if (restored.length) {
        await this.git(['restore', `--source=${oldest.before}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], restored.join('\0'));
      }
      for (const p of removed) this.removeFile(p);
    }
    const undone = new Set(runs.map((r) => r.n));
    this.save(all.map((c) => (undone.has(c.n) ? { ...c, undone: true } : c)));
    return { runs, restored, removed, skipped };
  }

  // ── git ─────────────────────────────────────

  private prepare(): Promise<boolean> {
    this.ready ??= (async () => {
      const home = path.resolve(os.homedir());
      const root = path.resolve(this.root);
      // The home folder or a drive's root would take too long to record and
      // is rarely what a run works in: no checkpoints there.
      if (root === home || root === path.parse(root).root) return false;
      try {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
          await this.git(['init', '--quiet']);
        }
        fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
        fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'), `${ALWAYS_LEFT_OUT.join('\n')}\n`);
        fs.writeFileSync(path.join(this.dir, 'gitconfig'), '');
        return true;
      } catch { return false; }
    })();
    return this.ready;
  }

  /** A commit of the project as it is now. */
  private async snapshot(message: string): Promise<string> {
    await this.git(['add', '--all', '--ignore-errors', '.']);
    const tree = (await this.git(['write-tree'])).trim();
    return (await this.git(['commit-tree', tree, '-m', message])).trim();
  }

  /** [status, path] for each file that differs between two snapshots, renames as a delete and a make. */
  private async diff(from: string, to: string, paths?: string[]): Promise<Array<[string, string]>> {
    // diff takes no pathspec file: the paths go on the command line, a few
    // hundred at a time (Windows caps a command line at 32k characters).
    const batches = paths ? chunk(paths, 200) : [undefined];
    const rows: Array<[string, string]> = [];
    for (const batch of batches) {
      if (batch && !batch.length) continue;
      const out = await this.git(['diff', '--name-status', '--no-renames', '-z', from, to, ...(batch ? ['--', ...batch] : [])]);
      const parts = out.split('\0').filter(Boolean);
      for (let i = 0; i + 1 < parts.length; i += 2) rows.push([parts[i]![0]!, parts[i + 1]!]);
    }
    return rows;
  }

  private async same(a: string, b: string, p: string): Promise<boolean> {
    return (await this.diff(a, b, [p])).length === 0;
  }

  private removeFile(rel: string): void {
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) return;
    try { fs.rmSync(abs, { force: true }); } catch { return; }
    // Folders the run made that are now empty go too.
    let dir = path.dirname(abs);
    while (dir.startsWith(path.resolve(this.root) + path.sep)) {
      try { fs.rmdirSync(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }

  private save(list: Checkpoint[]): void {
    const kept = list.slice(-KEEP);
    for (const old of list.slice(0, -KEEP)) {
      void this.git(['update-ref', '-d', `refs/cascade/${old.n}`]).catch(() => undefined);
      void this.git(['update-ref', '-d', `refs/cascade/${old.n}-after`]).catch(() => undefined);
    }
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.indexFile);
  }

  private git(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [
        '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false',
        '-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false', '-c', 'core.longpaths=true', '-c', 'gc.autoDetach=false',
        ...args,
      ], {
        cwd: this.root,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_DIR: this.gitDir,
          GIT_WORK_TREE: this.root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: path.join(this.dir, 'gitconfig'),
          GIT_AUTHOR_NAME: 'Cascade', GIT_AUTHOR_EMAIL: 'checkpoints@cascade.local',
          GIT_COMMITTER_NAME: 'Cascade', GIT_COMMITTER_EMAIL: 'checkpoints@cascade.local',
          GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
          // A path is a path, never a pattern: a file named `*.ts` is that file.
          GIT_LITERAL_PATHSPECS: '1',
        },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      const timer = setTimeout(() => { child.kill(); reject(new Error(`git ${args[0]} took longer than ${this.timeoutMs / 1000}s`)); }, this.timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
        else reject(new Error(`git ${args[0]} failed: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`));
      });
      child.stdin.end(input ?? '');
    });
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
