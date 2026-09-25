// ─────────────────────────────────────────────
//  Cascade AI — The process jail for shell, run_code and git
// ─────────────────────────────────────────────
//
//  These three run real programs, which can open any file the user can and
//  read any process's environment the user can: the file tools' protected
//  paths meant nothing to `cat .cascade/config.json` once it was approved,
//  and approval can come from a tier above rather than a person.
//
//  Each launch is wrapped in the OS's own confinement:
//
//    Linux  — bubblewrap. The filesystem is the host's, but Cascade's own
//             folder, the built-in secrets and — unless the caller is
//             local-only itself — local-only paths are mounted over, and so
//             is the repository's git store when its history holds any of
//             them. The command gets its own process namespace, so no other
//             process's /proc — Cascade's environment among them — is there
//             to read, and no capabilities. A local-only caller also gets its
//             own network namespace and a seccomp filter against Unix
//             sockets: the namespace leaves loopback only, and the filter
//             keeps it from reaching a host daemon (Docker, say) through a
//             socket file.
//    macOS  — sandbox-exec, with a generated profile that denies the same
//             paths, and all outbound connections for a local-only caller.
//
//  Every launch, jailed or not, gets an environment with the provider keys
//  taken out. Where there is no jailer (Windows, or a Linux without a
//  working bubblewrap), `auto` runs commands with that environment alone —
//  and refuses them to a local-only caller, whose network it cannot cut.
//  Naming a jailer outright refuses commands when that jailer is missing;
//  `off` is today's behaviour, and nothing is scrubbed.
//
//  A workspace's own `.cascadeignore` is not applied here: it commonly lists
//  `node_modules/` and `dist/`, which builds and tests have to read.

import { execFile } from 'node:child_process';
import { fileIdentity } from '../../utils/link-aliases.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProcessJailMode = 'auto' | 'bwrap' | 'sandbox-exec' | 'off';
export type JailKind = 'bwrap' | 'sandbox-exec';

/** Environment variables that carry a model or search provider's key, or Cascade's own secret. */
export const SECRET_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_API_KEY',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'TOGETHER_API_KEY',
  'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'EXA_API_KEY',
  'CASCADE_DASHBOARD_SECRET',
];

/** Directories never walked for paths to hide: git's own store, and installed packages. */
const UNWALKED_DIRS = new Set(['.git', 'node_modules']);

/**
 * Cascade's folder is hidden whole, so a file Cascade writes there while a
 * command runs — a database journal, say — is hidden too. These are the
 * parts commands use, and stay: run_code's scripts, and browser screenshots.
 */
const CASCADE_DIR_KEPT = ['tmp', 'screenshots'];

/**
 * A name no pattern is likely to name: when a directory's hypothetical child
 * by this name would be hidden, every child would be — `secret/**` — and the
 * directory is hidden whole, files created in it later included.
 */
const PROBE = '.cascade-jail-probe';

export interface JailPolicy {
  mode: ProcessJailMode;
  workspaceRoot: string;
  /** Workspace-relative POSIX path (a directory ends in `/`) no command may see. */
  isProtected: (rel: string) => boolean;
  /** Workspace-relative POSIX path under a local-only privacy policy. */
  isLocalOnly?: (rel: string) => boolean;
  /**
   * The gitignore-style patterns behind the two above, for finding them in
   * the repository's history: the built-ins, and the local-only ones unless
   * the caller is local-only itself.
   */
  hiddenPatterns: (offline: boolean) => string[];
  /** Directories outside the workspace to hide whole — Cascade's global one. */
  hiddenDirs: string[];
  /** Files to hide wherever they are: protected by place, not name (a configured database). */
  hiddenFiles?: () => string[];
  /** Values no command's environment may carry, under whatever name. */
  secretValues: () => string[];
  /**
   * Mark files a local-only caller's command changed (workspace-relative,
   * POSIX) as local-only: they may carry what it read.
   */
  taint?: (rels: string[]) => void;
  log: (msg: string) => void;
  /** Which jailer this machine has; injectable for tests. */
  detect?: () => Promise<JailKind | null>;
}

export interface Launch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The jailer the launch is wrapped in, or null when it runs as it is. */
  jail: JailKind | null;
  /**
   * To call once the command has ended, whatever its outcome: for a
   * local-only caller, marks what it changed in the workspace local-only.
   */
  done?: () => Promise<void>;
}

/** Where a local-only caller's command may write: nowhere but these. */
export interface WriteLayout {
  /** The workspace, writable. */
  writable: string[];
  /**
   * Inside it, read-only all the same: the repository's git store, and
   * files with other names (hard links). Mounted before the hidden paths,
   * so a mask over one of them stays on.
   */
  readOnly: string[];
  /** Private, empty and discarded: /tmp, and the home cache. */
  scratch: string[];
}

export type Prepared = { ok: true; launch: Launch } | { ok: false; reason: string };

/** A path to hide: a directory is mounted over whole, except the subpaths it keeps. */
export interface Hidden {
  path: string;
  dir: boolean;
  keep?: string[];
}

export interface PrepareOptions {
  cwd: string;
  /** The caller is local-only: nothing it knows may leave the machine. */
  offline: boolean;
  /**
   * Leave the git store in view even when its history holds hidden paths —
   * for the git tool, which leaves them out of what it shows instead.
   */
  keepGit?: boolean;
}

export class ProcessJail {
  private warned = false;
  private gitChecks = new Map<string, { key: string; dirs: string[] }>();

  constructor(private readonly policy: JailPolicy) {}

  /**
   * How to launch `file args` from `cwd`: wrapped in the jail, or as it is
   * with a scrubbed environment, or not at all.
   */
  async prepare(file: string, args: string[], opts: PrepareOptions): Promise<Prepared> {
    const { mode } = this.policy;
    if (mode === 'off') {
      return { ok: true, launch: { file, args, env: { ...process.env }, cwd: opts.cwd, jail: null } };
    }
    const env = scrubEnv(process.env, this.policy.secretValues());
    const available = await (this.policy.detect ?? detectJail)();
    const kind = mode === 'auto' ? available : (available === mode ? mode : null);

    if (!kind) {
      if (mode !== 'auto') {
        return { ok: false, reason: `tools.processJail is "${mode}", which is not available on this machine, so the command was not run.` };
      }
      if (opts.offline) {
        return { ok: false, reason: 'A local-only subtask (privacy.paths) cannot run commands here: there is no process jail to keep them off the network.' };
      }
      if (!this.warned) {
        this.warned = true;
        this.policy.log('[jail] No process jail is available (bubblewrap on Linux, sandbox-exec on macOS): commands run with provider keys removed from their environment, but can read any file once approved.');
      }
      return { ok: true, launch: { file, args, env, cwd: opts.cwd, jail: null } };
    }

    // Its temporary files go to a folder in Cascade's scratch, which has to
    // exist before the paths to hide are collected, or it is hidden too.
    if (opts.offline && kind === 'sandbox-exec') {
      fs.mkdirSync(path.join(this.policy.workspaceRoot, '.cascade', 'tmp'), { recursive: true });
    }
    const hidden = await collectHidden(this.policy, opts.offline);
    if (!opts.keepGit) {
      for (const dir of await this.gitDirsToHide(opts.offline)) hidden.push({ path: dir, dir: true });
    }

    if (!opts.offline) {
      if (kind === 'sandbox-exec') {
        return { ok: true, launch: { file: 'sandbox-exec', args: ['-p', seatbeltProfile(hidden, false), file, ...args], env, cwd: opts.cwd, jail: kind } };
      }
      return { ok: true, launch: { file: 'bwrap', args: bwrapArgs(hidden, false, opts.cwd, file, args), env, cwd: opts.cwd, jail: kind } };
    }

    // A local-only caller's command writes only into the workspace, where
    // what it changed is found when it ends and marked local-only (`done`) —
    // anywhere else, a later command of a cloud worker could read it. Its
    // git store is read-only: a commit message or a staged blob is a write
    // no file shows. The command runs alone meanwhile (tools/workspace-gate.ts).
    let root: string;
    try { root = fs.realpathSync(this.policy.workspaceRoot); } catch { root = path.resolve(this.policy.workspaceRoot); }
    const inside = (p: string) => { const rel = path.relative(root, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };
    const gitDirs = (await gitDirsOf(root)).filter(inside);
    const startedAt = Date.now();
    const before = await stampFiles(root, gitDirs);
    // A file with other names shares what is written to it with all of
    // them, and one outside the workspace can be neither marked nor hidden:
    // such files are read-only to the command (installed packages, where
    // pnpm links them from its store, a folder at a time).
    const pins = linkPins(before, root);
    if (pins.length > MAX_LINK_PINS) {
      return { ok: false, reason: `A local-only subtask (privacy.paths) cannot run commands in this workspace: ${pins.length} places in it hold files with other names (hard links), more than can be kept read-only.` };
    }
    const layout: WriteLayout = {
      writable: [root],
      readOnly: [...gitDirs, ...pins],
      scratch: ['/tmp', path.join(os.homedir(), '.cache')].filter((d) => !inside(d) && fs.existsSync(d)),
    };
    let scratchTmp: string | undefined;
    const done = async (): Promise<void> => {
      if (scratchTmp) fs.rmSync(scratchTmp, { recursive: true, force: true });
      const after = await stampFiles(root, gitDirs);
      const changed = changedFiles(before, after, startedAt);
      if (changed.length) this.policy.taint?.(changed);
      // On Linux the workspace is a mount of its own, so a link to a file
      // outside it cannot be made. sandbox-exec has no such boundary: say so
      // when the command made one, since that other name is out of reach.
      const linked = changed.filter((rel) => (after.get(rel)?.nlink ?? 1) > 1 && (before.get(rel)?.nlink ?? 1) < 2);
      if (kind === 'sandbox-exec' && linked.length) {
        this.policy.log(`[jail] A local-only command made hard links in the workspace (${linked.join(', ')}); their other names, if outside it, were not marked local-only.`);
      }
    };

    if (kind === 'sandbox-exec') {
      // No private /tmp here: the command's temporary files go to a folder in
      // the workspace instead, removed when it ends.
      scratchTmp = fs.mkdtempSync(path.join(root, '.cascade', 'tmp', 'local-only-'));
      return {
        ok: true,
        launch: { file: 'sandbox-exec', args: ['-p', seatbeltProfile(hidden, true, layout), file, ...args], env: { ...env, TMPDIR: scratchTmp }, cwd: opts.cwd, jail: kind, done },
      };
    }
    // bubblewrap reads a seccomp filter from a file descriptor; the shell
    // opens the filter's file as fd 9 and execs bubblewrap with it.
    const filter = unixSocketFilterFile();
    if (!filter) {
      return { ok: false, reason: `A local-only subtask (privacy.paths) cannot run commands on ${process.arch}: the filter that keeps them off host sockets is built for x64 and arm64 only.` };
    }
    const jailArgs = bwrapArgs(hidden, true, opts.cwd, file, args, layout);
    return {
      ok: true,
      launch: { file: '/bin/sh', args: ['-c', 'exec bwrap --seccomp 9 "$@" 9<"$0"', filter, ...jailArgs], env, cwd: opts.cwd, jail: kind, done },
    };
  }

  /**
   * Pathspecs that leave the hidden paths out of what git shows, for the git
   * tool — which keeps the git store in view — to append. None when the jail
   * is off.
   */
  gitExclusions(offline: boolean): string[] {
    if (this.policy.mode === 'off') return [];
    return toPathspecs(this.policy.hiddenPatterns(offline)).map((spec) => spec.replace(':(glob)', ':(exclude,glob)'));
  }

  /**
   * Whether the repository's git store is hidden from this caller's
   * commands: its index or history holds a path they may not see.
   */
  async gitStoreHidden(offline: boolean): Promise<boolean> {
    if (this.policy.mode === 'off') return false;
    return (await this.gitDirsToHide(offline)).length > 0;
  }

  /**
   * Why `git push <args>` from `cwd` would send a hidden path's blob off the
   * machine, or null when it would not. The git tool keeps the object store
   * in view, and a push packs whatever the pushed commits hold.
   *
   * A push to a configured remote is refused when any commit that remote
   * does not have yet, among those the push would send, touches a hidden
   * path: the history of each refspec's source, or of every local ref when
   * the push names none or pushes refs wholesale. The remote's tracking refs are what "has" means, so a
   * remote never fetched from has nothing. A push to anything else (a URL, a
   * path, `--repo`) is refused whenever the history holds a hidden path at
   * all: what it already has is not known. When git cannot tell, it is
   * refused.
   */
  async pushRefusal(cwd: string, args: string[], offline: boolean): Promise<string | null> {
    if (this.policy.mode === 'off') return null;
    const unverified = 'git push was refused: could not check that it sends no protected or local-only (privacy.paths) file.';
    const rootSpecs = toPathspecs(this.policy.hiddenPatterns(offline));
    if (rootSpecs.length === 0) return null;
    // The hidden paths are relative to the workspace root, so the check runs
    // there when `cwd` is the same repository. Another repository — nested in
    // the workspace, or outside it — gets every pattern at any depth, which
    // finds more than is hidden rather than less.
    const root = this.policy.workspaceRoot;
    const common = (dir: string) => git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const [here, there] = path.resolve(cwd) === path.resolve(root)
      ? ['same', 'same']
      : await Promise.all([common(cwd), common(root)]);
    if (here === null) return unverified;
    const sameRepo = here === there;
    const where = sameRepo ? root : cwd;
    const specs = sameRepo
      ? rootSpecs
      : rootSpecs.map((spec) => `:(top,glob)**/${spec.slice(':(glob)'.length).replace(/^\*\*\//, '')}`);

    let target: string | undefined;
    let deleting = false;
    let bulk = false;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
      if (arg === '--repo') { target = args[++i]; continue; }
      if (arg.startsWith('--repo=')) { target = arg.slice('--repo='.length); continue; }
      if (arg === '-d' || arg === '--delete') { deleting = true; continue; }
      if (PUSH_BULK_OPTIONS.has(arg)) { bulk = true; continue; }
      if (PUSH_OPTIONS_WITH_VALUE.has(arg)) { i++; continue; }
      if (arg.startsWith('-')) continue;
      positional.push(arg);
    }
    if (target === undefined) target = positional.shift();
    // Deleting sends no objects. A refspec sends its source's history; with
    // none, or a flag that pushes refs wholesale, what goes depends on
    // configuration, so every local ref is checked.
    const sources = deleting ? [] : positional
      .map((spec) => spec.replace(/^\+/, '').split(':')[0] ?? '')
      .filter((src) => src !== '');
    if (sources.some((src) => src.startsWith('-'))) return unverified;
    // `:` (or `+:`) is git's matching refspec: every branch the remote also has.
    const matching = positional.some((spec) => spec.replace(/^\+/, '') === ':');
    const every = bulk || matching || (!deleting && positional.length === 0);

    const remotes = await git(where, ['remote']);
    if (remotes === null) return unverified;
    if (target === undefined) target = await defaultPushRemote(where);
    if (!every && sources.length === 0) return null;
    const configured = remotes.split('\n').map((r) => r.trim()).filter(Boolean).includes(target);
    const found = await git(where, [
      'log', '-n', '1', '--format=%h %s', ...(every ? ['--all'] : []),
      ...(configured ? ['--not', `--remotes=${target}`, '--not'] : []),
      '--end-of-options', ...sources, '--', ...specs,
    ]);
    if (found === null) return unverified;
    if (!found) return null;
    return configured
      ? `git push was refused: a commit "${target}" does not have yet (${found}) touches a protected or local-only (privacy.paths) file, and pushing would send it.`
      : `git push was refused: what it would send holds a protected or local-only (privacy.paths) file (${found}), and "${target}" is not a configured remote, so what it already has is not known.`;
  }

  /**
   * The repository's git directories, when its index or any commit on any
   * ref holds a path hidden from this caller — the blob is as readable as
   * the file (`git show HEAD:secret/plan.md`). Found with git itself, and
   * remembered until the index, HEAD's reflog, the packed refs or the last
   * fetch change. When git cannot tell, they are hidden.
   */
  private async gitDirsToHide(offline: boolean): Promise<string[]> {
    const root = this.policy.workspaceRoot;
    const specs = toPathspecs(this.policy.hiddenPatterns(offline));
    if (specs.length === 0) return [];
    const located = await git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
    if (located === null) return [];
    const [gitDir = '', common = ''] = located.split('\n').map((line) => line.trim());
    if (!gitDir) return [];
    const dirs = [...new Set([gitDir, path.resolve(root, common || gitDir)])];

    const key = [offline, ...['index', 'HEAD', 'logs/HEAD', 'packed-refs', 'FETCH_HEAD']
      .map((f) => { try { return fs.statSync(path.join(gitDir, f)).mtimeMs; } catch { return 0; } })].join('|');
    const cached = this.gitChecks.get(`${gitDir}|${offline}`);
    if (cached?.key === key) return cached.dirs;

    const tracked = await git(root, ['ls-files', '-z', '--', ...specs]);
    const history = tracked ? '' : await git(root, ['log', '--all', '-n', '1', '--format=%H', '--', ...specs]);
    const holds = tracked === null || history === null || Boolean(tracked) || Boolean(history);
    const result = holds ? dirs : [];
    this.gitChecks.set(`${gitDir}|${offline}`, { key, dirs: result });
    return result;
  }
}

/** `env` without provider keys: the known names, and any variable holding a configured secret. */
export function scrubEnv(env: NodeJS.ProcessEnv, secretValues: string[]): NodeJS.ProcessEnv {
  const secrets = new Set(secretValues.filter((v) => v && v.length >= 8));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAMES.includes(name.toUpperCase())) continue;
    if (value !== undefined && secrets.has(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Every path a command from this workspace may not see: Cascade's folder
 * (bar the parts commands use), the protected paths, the local-only ones
 * unless the caller is local-only itself, and the hidden directories
 * outside. A directory whose every child would be hidden is hidden whole,
 * and not walked. The walk awaits each directory, so the event loop keeps
 * running in a large workspace.
 */
export async function collectHidden(policy: JailPolicy, offline: boolean): Promise<Hidden[]> {
  const out: Hidden[] = [];
  let root: string;
  try { root = fs.realpathSync(policy.workspaceRoot); } catch { root = path.resolve(policy.workspaceRoot); }
  const hide = (rel: string): boolean => policy.isProtected(rel) || (!offline && !!policy.isLocalOnly?.(rel));

  const walk = async (dir: string, relDir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (rel === '.cascade') {
          const keep = CASCADE_DIR_KEPT.map((k) => path.join(abs, k)).filter((k) => fs.existsSync(k));
          out.push({ path: abs, dir: true, keep });
          // The kept parts are mounted back whole; what in them is hidden
          // is masked again after (a local-only subtask's file in tmp).
          for (const k of keep) await walk(k, `${rel}/${path.basename(k)}`);
          continue;
        }
        if (hide(`${rel}/`) || hide(`${rel}/${PROBE}`)) { out.push({ path: abs, dir: true }); continue; }
        if (UNWALKED_DIRS.has(entry.name)) continue;
        await walk(abs, rel);
      } else if (hide(rel)) {
        // A symlink is hidden under its own name; what it points to inside
        // the workspace is judged, and hidden, where it lies.
        out.push({ path: abs, dir: false });
      }
    }
  };
  await walk(root, '');

  for (const dir of policy.hiddenDirs) {
    try { if (fs.statSync(dir).isDirectory()) out.push({ path: fs.realpathSync(dir), dir: true }); } catch { /* not there */ }
  }
  for (const file of policy.hiddenFiles?.() ?? []) {
    try { if (fs.lstatSync(file).isFile()) out.push({ path: file, dir: false }); } catch { /* not there */ }
  }
  out.push(...await linkAliasesOf(out, root));
  return out;
}

/**
 * The workspace's other names — hard links — for the hidden files, which a
 * mask by name leaves in view. Only a file with more than one name has any,
 * so the workspace is searched only when a hidden one does.
 */
async function linkAliasesOf(hidden: Hidden[], root: string): Promise<Hidden[]> {
  const ids = new Set<string>();
  const note = async (abs: string) => {
    try {
      const st = await fs.promises.lstat(abs);
      if (st.isFile() && st.nlink > 1) ids.add(fileIdentity(st));
    } catch { /* gone meanwhile */ }
  };
  const everything = async (dir: string, keep: Set<string>): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (keep.has(abs)) continue;
      if (e.isDirectory()) await everything(abs, keep);
      else if (e.isFile()) await note(abs);
    }
  };
  for (const h of hidden) {
    if (h.dir) await everything(h.path, new Set(h.keep ?? []));
    else await note(h.path);
  }
  if (ids.size === 0) return [];

  const masked = new Set(hidden.map((h) => h.path));
  const aliases: Hidden[] = [];
  const search = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (masked.has(abs)) continue;
      if (e.isDirectory()) {
        if (e.name !== '.git') await search(abs);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = await fs.promises.lstat(abs);
        if (st.nlink > 1 && ids.has(fileIdentity(st))) aliases.push({ path: abs, dir: false });
      } catch { /* gone meanwhile */ }
    }
  };
  await search(root);
  // A hidden directory's kept parts are in view, so searched too.
  for (const h of hidden) for (const k of h.keep ?? []) await search(k);
  return aliases;
}

/**
 * gitignore-style patterns as git pathspecs, relative to the workspace: one
 * with no slash but a trailing one matches at any depth, like `.env`; one
 * with a slash is anchored, like `.cascade/config.json`. Each also covers
 * everything under a directory of that name. Negations are dropped: finding
 * more than is hidden only hides the git store more often.
 */
export function toPathspecs(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const raw of patterns) {
    let p = raw.trim();
    if (!p || p.startsWith('#') || p.startsWith('!')) continue;
    p = p.replace(/\/+$/, '');
    const anchored = p.startsWith('/') || p.includes('/');
    p = p.replace(/^\/+/, '');
    if (!p) continue;
    const base = anchored ? p : `**/${p}`;
    out.add(`:(glob)${base}`);
    if (!base.endsWith('**')) out.add(`:(glob)${base}/**`);
  }
  return [...out];
}

/**
 * bubblewrap's arguments: the host as it is, the hidden paths mounted over,
 * the command's own processes. `--cap-drop ALL` matters when Cascade runs as
 * root, in a container say: bubblewrap then keeps every capability, and a
 * command could simply unmount what hides a file.
 */
export function bwrapArgs(hidden: Hidden[], offline: boolean, cwd: string, file: string, args: string[], layout?: WriteLayout): string[] {
  const out = ['--die-with-parent', '--new-session', '--unshare-pid', '--cap-drop', 'ALL'];
  if (layout) {
    // The host read-only, the scratch folders private; then the workspace
    // writable again — after them, as it may lie under /tmp.
    out.push('--ro-bind', '/', '/');
    for (const dir of layout.scratch) out.push('--tmpfs', dir);
    for (const dir of layout.writable) out.push('--bind', dir, dir);
    for (const p of layout.readOnly) out.push('--ro-bind', p, p);
    // A working directory the scratch folders would have hidden.
    const underScratch = layout.scratch.some((dir) => cwd === dir || cwd.startsWith(`${dir}${path.sep}`));
    if (underScratch && !layout.writable.some((dir) => cwd === dir || cwd.startsWith(`${dir}${path.sep}`))) {
      out.push('--ro-bind', cwd, cwd);
    }
  } else {
    out.push('--bind', '/', '/');
  }
  out.push('--dev', '/dev', '--proc', '/proc');
  if (offline) out.push('--unshare-net');
  for (const h of hidden) {
    if (!h.dir) { out.push('--ro-bind', '/dev/null', h.path); continue; }
    out.push('--tmpfs', h.path);
    for (const k of h.keep ?? []) out.push('--bind', k, k);
  }
  out.push('--chdir', cwd, '--', file, ...args);
  return out;
}

/** A sandbox-exec profile: everything allowed but the hidden paths, and the network for a local-only caller. */
export function seatbeltProfile(hidden: Hidden[], offline: boolean, layout?: WriteLayout): string {
  const quote = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = ['(version 1)', '(allow default)'];
  if (layout) {
    // Writes nowhere but the workspace and the devices every program uses;
    // not to its git store. A later rule wins.
    lines.push('(deny file-write* (subpath "/"))');
    const writable = [...layout.writable.map((d) => `(subpath ${quote(d)})`), ...SEATBELT_WRITABLE_DEVICES];
    lines.push(`(allow file-write* ${writable.join(' ')})`);
    if (layout.readOnly.length) lines.push(`(deny file-write* ${layout.readOnly.map((d) => `(subpath ${quote(d)})`).join(' ')})`);
  }
  if (hidden.length) {
    const filters = hidden.map((h) => (h.dir ? `(subpath ${quote(h.path)})` : `(literal ${quote(h.path)})`));
    lines.push(`(deny file-read* file-write* ${filters.join(' ')})`);
    // A later rule wins: the kept parts of a hidden directory are allowed again.
    const kept = hidden.flatMap((h) => h.keep ?? []);
    if (kept.length) {
      lines.push(`(allow file-read* file-write* ${kept.map((k) => `(subpath ${quote(k)})`).join(' ')})`);
      // …and what is hidden inside them denied once more, after.
      const within = hidden.filter((h) => kept.some((k) => h.path.startsWith(`${k}/`)));
      if (within.length) {
        lines.push(`(deny file-read* file-write* ${within.map((h) => (h.dir ? `(subpath ${quote(h.path)})` : `(literal ${quote(h.path)})`)).join(' ')})`);
      }
    }
  }
  if (offline) lines.push('(deny network-outbound)');
  return lines.join('\n');
}

// ── The seccomp filter for local-only commands ────────────────────────────
//
//  A network namespace leaves a command loopback only, but a Unix socket file
//  on the host — /var/run/docker.sock — reaches a daemon outside it, which
//  can do the networked work for it. The filter refuses socket(AF_UNIX): a
//  command can no longer connect to one. socketpair(), which runtimes use to
//  talk to their own children, is a separate call and stays. io_uring can
//  make sockets without the socket() call, so it is refused as not there;
//  so is every call from another ABI (x32, or 32-bit code), whose socket
//  call this filter cannot see.

const SECCOMP_ARCH: Record<string, { audit: number; socket: number; ioUringSetup: number }> = {
  x64: { audit: 0xc000003e, socket: 41, ioUringSetup: 425 },
  arm64: { audit: 0xc00000b7, socket: 198, ioUringSetup: 425 },
};

/** The filter as a compiled cBPF program, as bubblewrap's --seccomp reads it; null on another architecture. */
export function unixSocketFilter(arch: string = process.arch): Buffer | null {
  const a = SECCOMP_ARCH[arch];
  if (!a) return null;
  const LD_ABS = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06;
  const ALLOW = 0x7fff0000;
  const errno = (e: number) => 0x00050000 | e;
  const EACCES = 13, ENOSYS = 38, AF_UNIX = 1;
  const program: Array<[number, number, number, number]> = [
    [LD_ABS, 0, 0, 4],                // 0  A = arch
    [JEQ, 1, 0, a.audit],             // 1  this ABI → 3
    [RET, 0, 0, errno(EACCES)],       // 2  another ABI
    [LD_ABS, 0, 0, 0],                // 3  A = syscall number
    [JGE, 0, 1, 0x40000000],          // 4  x32 → 5, else 6
    [RET, 0, 0, errno(EACCES)],       // 5
    [JEQ, 0, 1, a.ioUringSetup],      // 6  io_uring_setup → 7, else 8
    [RET, 0, 0, errno(ENOSYS)],       // 7
    [JEQ, 0, 3, a.socket],            // 8  socket → 9, else 12
    [LD_ABS, 0, 0, 16],               // 9  A = its domain
    [JEQ, 0, 1, AF_UNIX],             // 10 AF_UNIX → 11, else 12
    [RET, 0, 0, errno(EACCES)],       // 11
    [RET, 0, 0, ALLOW],               // 12
  ];
  const buf = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], i) => {
    buf.writeUInt16LE(code, i * 8);
    buf.writeUInt8(jt, i * 8 + 2);
    buf.writeUInt8(jf, i * 8 + 3);
    buf.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return buf;
}

let filterFile: string | null | undefined;

/** The filter written once to a file of this process's own, for the shell to open. */
function unixSocketFilterFile(): string | null {
  if (filterFile !== undefined) return filterFile;
  const program = unixSocketFilter();
  if (!program) return (filterFile = null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jail-'));
  const file = path.join(dir, 'unix-sockets.bpf');
  fs.writeFileSync(file, program, { mode: 0o600 });
  return (filterFile = file);
}

let detected: Promise<JailKind | null> | undefined;

/**
 * The jailer this machine can actually run, found once. Each is tried the way
 * it will be used — bubblewrap can be installed and still unusable, where
 * unprivileged user namespaces are switched off — and sandbox-exec is given
 * a profile of the shape a launch uses, so a profile it rejects is found now
 * rather than on every command.
 */
export function detectJail(): Promise<JailKind | null> {
  detected ??= (async () => {
    if (process.platform === 'linux') {
      const ok = await runs('bwrap', bwrapArgs([], true, '/', 'true', []));
      return ok ? 'bwrap' : null;
    }
    if (process.platform === 'darwin') {
      const probe = seatbeltProfile([
        { path: '/nonexistent/cascade-probe', dir: false },
        { path: '/nonexistent/cascade-dir', dir: true, keep: ['/nonexistent/cascade-dir/tmp'] },
      ], true);
      const ok = await runs('sandbox-exec', ['-p', probe, '/usr/bin/true']);
      return ok ? 'sandbox-exec' : null;
    }
    return null;
  })();
  return detected;
}

function runs(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000, windowsHide: true }, (err) => resolve(!err));
  });
}

/** More places with hard-linked files than a command's mounts should hold. */
const MAX_LINK_PINS = 1000;

/**
 * Where the workspace's files with other names are, to mount read-only:
 * each file, or the whole `node_modules` folder it is installed in.
 */
function linkPins(stamps: Map<string, Stamp>, root: string): string[] {
  const out = new Set<string>();
  for (const [rel, stamp] of stamps) {
    if (stamp.nlink < 2) continue;
    const parts = rel.split('/');
    const packages = parts.indexOf('node_modules');
    out.add(path.join(root, ...(packages >= 0 ? parts.slice(0, packages + 1) : parts)));
  }
  return [...out];
}

/** The devices a program writes to wherever it runs. */
const SEATBELT_WRITABLE_DEVICES = [
  '(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/tty")', '(literal "/dev/dtracehelper")', '(subpath "/dev/fd")',
];

/** A file's identity and last change, to tell whether a command changed it. */
interface Stamp { ctime: number; mtime: number; size: number; ino: number; nlink: number }

/**
 * Every file in the workspace, stamped — bar Cascade's folder (other than
 * the parts commands use) and the directories given, which the command
 * cannot write. Symlinks are stamped as themselves, never followed.
 */
async function stampFiles(root: string, skip: string[]): Promise<Map<string, Stamp>> {
  const out = new Map<string, Stamp>();
  const skipped = new Set(skip);
  const walk = async (dir: string, relDir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipped.has(abs)) continue;
        if (rel === '.cascade') {
          for (const kept of CASCADE_DIR_KEPT) await walk(path.join(abs, kept), `${rel}/${kept}`);
          continue;
        }
        await walk(abs, rel);
        continue;
      }
      try {
        const st = await fs.promises.lstat(abs);
        out.set(rel, { ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size, ino: st.ino, nlink: st.nlink });
      } catch { /* gone meanwhile */ }
    }
  };
  await walk(root, '');
  return out;
}

/**
 * The files that are new or changed. A filesystem that keeps whole seconds
 * cannot tell a change made in the second the command started from one made
 * just before it, so such a file counts as changed.
 */
function changedFiles(before: Map<string, Stamp>, after: Map<string, Stamp>, startedAt: number): string[] {
  const second = Math.floor(startedAt / 1000) * 1000;
  const out: string[] = [];
  for (const [rel, now] of after) {
    const was = before.get(rel);
    const differs = !was || now.ctime !== was.ctime || now.mtime !== was.mtime || now.size !== was.size || now.ino !== was.ino;
    if (differs || (now.ctime % 1000 === 0 && now.ctime >= second)) out.push(rel);
  }
  return out;
}

/** The repository's git directories — its own and, for a linked worktree, the common one. */
async function gitDirsOf(root: string): Promise<string[]> {
  const located = await git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  if (located === null) return [];
  const [gitDir = '', common = ''] = located.split('\n').map((line) => line.trim());
  if (!gitDir) return [];
  return [...new Set([gitDir, path.resolve(root, common || gitDir)])];
}

/** `git push` options that push refs wholesale rather than the ones named. */
const PUSH_BULK_OPTIONS = new Set(['--all', '--branches', '--mirror', '--tags']);

/** `git push` options that take their value as the next argument. */
const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec']);

/** The remote a bare `git push` goes to: the branch's push remote, the default one, its upstream's, or origin. */
async function defaultPushRemote(cwd: string): Promise<string> {
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const read = (key: string) => git(cwd, ['config', '--get', key]);
  return (branch ? await read(`branch.${branch}.pushRemote`) : null)
    || await read('remote.pushDefault')
    || (branch ? await read(`branch.${branch}.remote`) : null)
    || 'origin';
}

/** git's output in `cwd`, or null when it failed — not a repository, or git missing. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}
