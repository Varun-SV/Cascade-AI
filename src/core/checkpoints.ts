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
import { insideNestedRepo } from './permissions/risk.js';

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
  /** Put back by /undo except for files changed by hand since; /undo --force finishes it. */
  partial?: boolean;
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
  /** Repositories nested in the project, which a checkpoint records only as a pointer: not touched. */
  nested?: string[];
}

const KEEP = 50;
/** Folders that are never worth recording, whatever the project's .gitignore says. */
const ALWAYS_LEFT_OUT = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.next/', '.turbo/', '.cache/', '.gradle/', 'target/debug/', 'target/release/', '*.pyc', '.DS_Store', 'Thumbs.db'];

export class Checkpoints {
  private readonly gitDir: string;
  private readonly indexFile: string;
  private ready?: Promise<boolean>;
  /** Removing expired checkpoints and reclaiming their space, done in the background. */
  private upkeep: Promise<unknown> = Promise.resolve();

  /**
   * @param root the project folder
   * @param dir a folder of Cascade's own for it, outside the project (STATE.checkpoints)
   * @param timeoutMs how long recording may take before the run goes ahead without a checkpoint
   * @param retention how many checkpoints are kept, how often (in expired checkpoints) their
   *   space is reclaimed, and how old an unreferenced object must be to go (git's --prune)
   */
  constructor(
    private readonly root: string,
    private readonly dir: string,
    private readonly timeoutMs = 60_000,
    private readonly retention: { keep?: number; reclaimEvery?: number; pruneOlderThan?: string } = {},
  ) {
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
    // Never while space is being reclaimed: a snapshot's objects are named by
    // no ref until it is done, and must not be taken for expired ones.
    await this.upkeep;
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
    await this.upkeep;
    const after = await this.snapshot('after a run').catch(() => null);
    if (!after) return cp;
    const changed = (await this.diff(cp.before, after)).length;
    await this.git(['update-ref', `refs/cascade/${cp.n}-after`, after]).catch(() => undefined);
    const done = { ...cp, after, changed };
    this.save(this.list().map((c) => (c.n === cp.n ? done : c)));
    return done;
  }

  /**
   * Whether a checkpoint records every one of these files (absolute paths):
   * none outside the project, none the project's .gitignore (or the
   * folders always left out) excludes. False when it can't tell.
   */
  async covers(paths: string[]): Promise<boolean> {
    if (!(await this.prepare())) return false;
    // Judged where a write would really land: a symlink in the project to a
    // file outside it is recorded as the link, and the file it points to is
    // not (Codex: `printf x > linked.txt` overwrote an outside file).
    const root = realPath(path.resolve(this.root));
    const real = paths.map((p) => realPath(path.resolve(this.root, p)));
    const rel = real.map((p) => path.relative(root, p));
    if (rel.some((r) => !r || r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r))) return false;
    // A repository nested in the project (a submodule, a clone) is recorded
    // only as a pointer to its commit: its files, and work not committed
    // there, are not in the checkpoint.
    if (real.some((p) => insideNestedRepo(p, root) || (isDir(p) && hasNestedRepo(p)))) return false;
    // The project's own .git is never recorded (git keeps it out of any
    // snapshot), so a write to its config or refs could not be put back.
    if (rel.some((r) => r.split(path.sep).includes('.git'))) return false;
    try {
      // Exit 0 names the ignored ones; exit 1 means none is.
      const ignored = await this.git(['check-ignore', '-z', '--stdin'], rel.join('\0'), [0, 1]);
      if (ignored.replace(/\0/g, '') !== '') return false;
      // A folder is covered only if nothing in it is left out: `cp a.txt
      // dest/` writes into it, and a file there the .gitignore names would be
      // overwritten with nothing to put it back.
      const folders = rel.filter((r, i) => { try { return fs.statSync(real[i]!).isDirectory(); } catch { return false; } });
      if (folders.length) {
        const inside = await this.git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', ...folders]);
        if (inside.replace(/\0/g, '') !== '') return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** The nested repositories' pointers (gitlinks) a snapshot holds: one listing of it, its paths only. */
  private async gitlinks(rev: string): Promise<string[]> {
    const out = await this.git(['ls-tree', '-r', '-z', '--full-tree', rev]).catch(() => '');
    return out.split('\0').filter((e) => e.startsWith('160000 ')).map((e) => e.slice(e.indexOf('\t') + 1));
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
    await this.upkeep;
    const all = this.list();
    const runs = all.filter((c) => !c.undone).slice(-Math.max(1, count)).reverse();
    if (!runs.length) return { runs: [], restored: [], removed: [], skipped: [] };
    const now = await this.snapshot('before /undo');
    // Each path the runs touched: what it was before the FIRST of them that
    // changed it, and what the last of them left it as. A file made by hand
    // between two runs and then edited by the later one goes back to the
    // hand-made version, not away with the earlier run's snapshot.
    const touched = new Map<string, { source: string; leftBy: string }>();
    for (const run of [...runs].reverse()) {
      for (const [, p] of await this.diff(run.before, run.after ?? now)) {
        touched.set(p, { source: touched.get(p)?.source ?? run.before, leftBy: run.after ?? now });
      }
    }
    const skipped: string[] = [];
    const bySource = new Map<string, string[]>();
    const kept: Array<[string, string]> = [];
    // A nested repository is recorded as a pointer, not its files: putting
    // "it" back would give an empty folder. Left as it is, and said so.
    const links = new Set<string>();
    for (const rev of [...runs.map((r) => r.before), now]) for (const l of await this.gitlinks(rev)) links.add(l);
    const nested = [...touched.keys()].filter((p) => links.has(p));
    for (const [p, { source, leftBy }] of touched) {
      if (nested.includes(p)) continue;
      if (!force && leftBy !== now && !(await this.same(leftBy, now, p))) { skipped.push(p); continue; }
      kept.push([p, source]);
    }
    // A path inside, or around, one left alone is left alone too: putting
    // back a/original.txt would turn the file `a` edited since into a folder.
    const related = (p: string, s: string) => p.startsWith(`${s}/`) || s.startsWith(`${p}/`);
    for (const [p, source] of kept) {
      if (skipped.some((s) => related(p, s))) { skipped.push(p); continue; }
      bySource.set(source, [...(bySource.get(source) ?? []), p]);
    }
    const restored: string[] = [];
    const removed: string[] = [];
    // A folder about to be replaced (by the file it was before, or removed as
    // made by the run) may hold files the checkpoint never recorded, made
    // since and left out by .gitignore: those would go with it. Left alone,
    // unless forced.
    if (!force) {
      for (const [source, paths] of [...bySource]) {
        const held: string[] = [];
        for (const p of paths) {
          if (!isDir(path.join(this.root, p))) continue;
          const inside = await this.git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', p]).catch(() => 'x');
          if (inside.replace(/\0/g, '') !== '') held.push(p);
        }
        if (!held.length) continue;
        const related = (p: string) => held.some((h) => p === h || p.startsWith(`${h}/`) || h.startsWith(`${p}/`));
        skipped.push(...paths.filter(related));
        bySource.set(source, paths.filter((p) => !related(p)));
      }
    }
    for (const [source, paths] of bySource) {
      if (!paths.length) continue;
      const status = new Map((await this.diff(source, now, paths)).map(([s, p]) => [p, s]));
      const back = paths.filter((p) => status.has(p) && status.get(p) !== 'A');
      if (back.length) await this.git(['restore', `--source=${source}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], back.join('\0'));
      restored.push(...back);
      for (const p of paths.filter((x) => status.get(x) === 'A')) { this.removeFile(p); removed.push(p); }
    }
    // With files left alone, the runs stay open: /undo --force can still
    // put those back, as the reply says it can.
    const done = new Set(runs.map((r) => r.n));
    this.save(all.map((c) => (!done.has(c.n) ? c : skipped.length ? { ...c, partial: true } : { ...c, undone: true, partial: false })));
    return { runs, restored, removed, skipped, ...(nested.length ? { nested } : {}) };
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
        // Files are kept byte for byte: the project's .gitattributes (text=auto,
        // eol, filters) would otherwise turn CRLF into LF on the way in, and
        // /undo would give back a different file. info/attributes wins over it.
        fs.writeFileSync(path.join(this.gitDir, 'info', 'attributes'), '* -text -eol -filter -ident -working-tree-encoding\n');
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

  /** Settles once expired checkpoints are removed and their space reclaimed. */
  idle(): Promise<void> {
    return this.upkeep.then(() => undefined);
  }

  private save(list: Checkpoint[]): void {
    const keep = this.retention.keep ?? KEEP;
    const kept = list.slice(-keep);
    const expired = list.slice(0, -keep);
    if (expired.length) {
      const every = this.retention.reclaimEvery ?? 10;
      this.upkeep = this.upkeep.then(async () => {
        for (const old of expired) {
          await this.git(['update-ref', '-d', `refs/cascade/${old.n}`]).catch(() => undefined);
          await this.git(['update-ref', '-d', `refs/cascade/${old.n}-after`]).catch(() => undefined);
        }
        // Every so often, the files only expired checkpoints held go too, or
        // the store would grow for as long as the project is worked on. Only
        // objects older than an hour: one a snapshot being taken right now has
        // just written, and no ref names yet, is kept.
        if (expired.some((old) => old.n % every === 0)) {
          await this.git(['gc', '--quiet', `--prune=${this.retention.pruneOlderThan ?? '1.hour.ago'}`]).catch(() => undefined);
        }
      }).catch(() => undefined);
    }
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.indexFile);
  }

  private git(args: string[], input?: string, okCodes: number[] = [0]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [
        '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false',
        '-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false', '-c', 'core.longpaths=true', '-c', 'gc.autoDetach=false',
        ...args,
      ], {
        cwd: this.root,
        windowsHide: true,
        // stdin only for a command given input: git that exits without
        // reading it made the write fail with EPIPE, an error nobody caught.
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
          // Not for check-ignore, which refuses it and reads plain paths anyway.
          ...(args[0] === 'check-ignore' ? {} : { GIT_LITERAL_PATHSPECS: '1' }),
        },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (c: Buffer) => out.push(c));
      child.stderr?.on('data', (c: Buffer) => err.push(c));
      const timer = setTimeout(() => { child.kill(); reject(new Error(`git ${args[0]} took longer than ${this.timeoutMs / 1000}s`)); }, this.timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (okCodes.includes(code ?? -1)) resolve(Buffer.concat(out).toString('utf8'));
        else reject(new Error(`git ${args[0]} failed: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`));
      });
      if (child.stdin) {
        child.stdin.on('error', () => { /* git exited first; its exit code says what happened */ });
        child.stdin.end(input);
      }
    });
  }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Whether a folder holds a repository of its own anywhere inside it (bounded: it stops at the first). */
function hasNestedRepo(dir: string): boolean {
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < 5000) {
    const d = stack.pop()!;
    seen += 1;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === '.git') return true;
      if (e.isDirectory() && e.name !== 'node_modules') stack.push(path.join(d, e.name));
    }
  }
  return false;
}

/**
 * Where a path really is: through every symlink on the way, its own last
 * one included. A path not made yet is resolved through the nearest folder
 * on the way that does exist.
 */
function realPath(p: string): string {
  try { return fs.realpathSync.native(p); } catch { /* not there yet */ }
  const parent = path.dirname(p);
  return parent === p ? p : path.join(realPath(parent), path.basename(p));
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
