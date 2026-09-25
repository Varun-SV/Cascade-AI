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
//             paths. A local-only caller runs no commands there: with no
//             mount boundary a command can hard-link a file from outside the
//             workspace in and write what it read into it, and with no
//             process namespace a child it leaves behind can write after it
//             ends — either way, somewhere Cascade cannot mark local-only.
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
import { fileIdentity, PROBE } from '../../utils/link-aliases.js';
import { stripTrailingSlashes } from '../../utils/net.js';
import { isWithin } from '../../utils/real-path.js';
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
  /**
   * In them, the parts of this project's state folder commands use: its
   * scratch folder, where run_code's scripts are — read-only to a local-only
   * caller, whose writes there nothing would mark — and, for a local-only
   * caller only, its private folder, where its outputs go.
   */
  stateDirs?: () => { tmp: string; private: string };
  /** Files to hide wherever they are: protected by place, not name (a configured database). */
  hiddenFiles?: () => string[];
  /**
   * Credentials outside the workspace — `homeSecrets()`: ssh and signing
   * keys, cloud and registry logins — hidden from every command but the git
   * tool's, which pushes and pulls with them.
   */
  hiddenSecrets?: () => string[];
  /** Files commands may read but not change: what decides what is protected (`.cascadeignore`). */
  readOnlyFiles?: () => string[];
  /** Values no command's environment may carry, under whatever name. */
  secretValues: () => string[];
  /**
   * Mark files a local-only caller's command changed (workspace-relative,
   * POSIX) as local-only: they may carry what it read.
   */
  taint?: (rels: string[]) => void;
  /** Write marks `taint` could hold only in memory — its save failed — to the record; throws if it still cannot. */
  saveMarks?: () => void;
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
  done?: () => Promise<string | void>;
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
  /** Inside a hidden directory, what is mounted back as it is. */
  keep?: string[];
  /** …and what is mounted back read-only. */
  keepReadOnly?: string[];
}

export interface PrepareOptions {
  cwd: string;
  /** The caller is local-only: nothing it knows may leave the machine. */
  offline: boolean;
  /**
   * Leave the git store in view even when its history holds hidden paths —
   * for the git tool, which leaves them out of what it shows instead — and
   * the credentials git pushes and pulls with (`hiddenSecrets`).
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

    if (opts.offline && kind === 'sandbox-exec') {
      return { ok: false, reason: 'A local-only subtask (privacy.paths) cannot run commands on macOS: sandbox-exec cannot stop a command from hard-linking a file outside the workspace in and writing to it, nor end a child it leaves running, so what it writes could not all be marked local-only.' };
    }
    const hidden = await collectHidden(this.policy, opts.offline);
    if (!opts.keepGit) {
      for (const dir of await this.gitDirsToHide(opts.offline)) hidden.push({ path: dir, dir: true });
      hidden.push(...secretsToHide(this.policy.hiddenSecrets?.() ?? []));
    }
    // Read-only besides: what decides what is protected, and — to every
    // command but the git tool's — git's own configuration, where a command
    // could name a program for the git tool to run with the credentials it
    // keeps (`gitConfigFiles`).
    const gitConfig = opts.keepGit ? [] : await gitConfigFiles(this.policy.workspaceRoot);
    const policyFiles = this.policy.readOnlyFiles?.() ?? [];
    // Through a symlink — what it leads to — and under every other name the
    // file has in the workspace (hard links), where a write would reach it.
    const frozen = [...new Set([...policyFiles, ...gitConfig].flatMap((f) => {
      try { return fs.statSync(f).isFile() ? [fs.realpathSync(f)] : []; } catch { return []; }
    }))];
    frozen.push(...(await linkAliasesOf(frozen.map((f) => ({ path: f, dir: false })), this.policy.workspaceRoot)).map((h) => h.path).filter((f) => !frozen.includes(f)));
    // A mount keeps a file's contents, not its name: a command can still
    // remove a symlinked policy file and put another in its place. So each
    // is looked at again when the command ends, and put back if changed.
    const restorePolicy = guardFiles(policyFiles);

    if (!opts.offline) {
      const done = async (): Promise<string | void> => restorePolicy();
      if (kind === 'sandbox-exec') {
        return { ok: true, launch: { file: 'sandbox-exec', args: ['-p', seatbeltProfile(hidden, frozen), file, ...args], env, cwd: opts.cwd, jail: kind, done } };
      }
      return { ok: true, launch: { file: 'bwrap', args: bwrapArgs(hidden, false, opts.cwd, file, args, undefined, frozen), env, cwd: opts.cwd, jail: kind, done } };
    }

    // A local-only caller's command writes only into the workspace, where
    // what it changed is found when it ends and marked local-only (`done`) —
    // anywhere else, a later command of a cloud worker could read it. Its
    // git store is read-only: a commit message or a staged blob is a write
    // no file shows. The command runs alone meanwhile (tools/workspace-gate.ts).
    let root: string;
    try { root = fs.realpathSync(this.policy.workspaceRoot); } catch { root = path.resolve(this.policy.workspaceRoot); }
    const inside = (p: string) => isWithin(p, root);
    const gitDirs = (await gitDirsOf(root)).filter(inside);
    const startedAt = Date.now();
    const dirsBefore = new Set<string>();
    const folders = new Map<string, FolderStamp>();
    const before = await stampFiles(root, gitDirs, dirsBefore, folders);
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
    const own = this.policy.stateDirs?.().private;
    const done = async (): Promise<string | void> => {
      const policyNote = restorePolicy();
      const dirsAfter = new Set<string>();
      const after = await stampFiles(root, gitDirs, dirsAfter);
      // A policy file it changed has just been put back as it was.
      const policyRels = new Set(policyFiles.map((f) => path.relative(root, f).split(path.sep).join('/')));
      const changed = changedFiles(before, after, startedAt).filter((rel) => !policyRels.has(rel));
      // What it made — files, and the outermost folders — may carry what it
      // read in its names as well as its contents: it goes to the private
      // folder, where its names show to no one else, unless it lies in a
      // folder a local-only pattern covers whole, whose names are hidden with
      // it. Without a private folder, it is marked where it is, a folder
      // whole. What it changed is marked local-only.
      const made = madeDirs(dirsBefore, dirsAfter);
      const inMade = (rel: string) => made.some((dir) => rel.startsWith(`${dir}/`));
      const createdFiles = changed.filter((rel) => !before.has(rel) && !inMade(rel));
      const created = [...made, ...createdFiles];
      const coveredWhole = (rel: string, isDir: boolean) => {
        const parts = rel.split('/');
        for (let i = isDir ? parts.length : parts.length - 1; i > 0; i--) {
          if (this.policy.isLocalOnly?.(`${parts.slice(0, i).join('/')}/${PROBE}`)) return true;
        }
        return false;
      };
      const toMove = own ? created.filter((rel) => !coveredWhole(rel, made.includes(rel))) : [];
      const moved = toMove.filter((rel) => moveInto(path.join(root, rel), path.join(own!, rel)));
      // What it deleted is marked too: which files it chose to delete could
      // say what it read, and a path marked local-only shows to the rest as
      // that, not as missing. A folder gone whole is marked as one.
      const goneDirs = madeDirs(dirsAfter, dirsBefore);
      const inGone = (rel: string) => goneDirs.some((dir) => rel.startsWith(`${dir}/`));
      const deleted = [...goneDirs, ...[...before.keys()].filter((rel) => !after.has(rel) && !inGone(rel))];
      const marked = [...changed.filter((rel) => before.has(rel) || !inMade(rel)), ...made, ...deleted].filter((rel) => !moved.includes(rel));
      // A folder it did not make carries nothing of its own choosing out:
      // its mode and times are put back as they were (extended attributes
      // it could not set at all).
      restoreFolders(root, folders);
      const notes: string[] = [];
      if (moved.length) {
        notes.push(`A local-only subtask (privacy.paths) keeps what it makes in its private folder, outside the project: this command's new files were moved there (${listed(moved)}).`);
      }
      if (marked.length) {
        // Everything marked that is still in the project may be set aside:
        // what it changed, and what it made that could not be moved — bar
        // what a local-only pattern covers whole, local-only by its own rule.
        const inProject = marked.filter((rel) => fs.existsSync(path.join(root, rel)) && !coveredWhole(rel, made.includes(rel)));
        const setAside = await recordMarks(this.policy, marked, inProject, root, own);
        if (setAside) notes.push(setAside);
      }
      if (policyNote) notes.push(policyNote);
      if (notes.length) return notes.join('\n');
    };

    // bubblewrap reads a seccomp filter from a file descriptor; the shell
    // opens the filter's file as fd 9 and execs bubblewrap with it.
    const filter = unixSocketFilterFile();
    if (!filter) {
      return { ok: false, reason: `A local-only subtask (privacy.paths) cannot run commands on ${process.arch}: the filter that keeps them off host sockets is built for x64 and arm64 only.` };
    }
    const jailArgs = bwrapArgs(hidden, true, opts.cwd, file, args, layout, frozen);
    return {
      ok: true,
      launch: {
        file: '/bin/sh', args: ['-c', 'exec bwrap --seccomp 9 "$@" 9<"$0"', filter, ...jailArgs],
        // Where to write outputs directly, for a command that knows to.
        env: own ? { ...env, CASCADE_PRIVATE_DIR: own } : env,
        cwd: opts.cwd, jail: kind, done,
      },
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

    if (target === undefined) target = await defaultPushRemote(where);
    if (!every && sources.length === 0) return null;
    // What the destination has, asked of the destination itself: tracking
    // refs say what a remote of that name had when last fetched — from
    // another server, if it has since been pointed elsewhere. Of what it
    // advertises, only commits this repository has count (--ignore-missing).
    if (target.startsWith('-')) return unverified;
    const advertised = await git(where, ['ls-remote', '--end-of-options', target]);
    if (advertised === null) return unverified;
    const has = [...new Set(advertised.split('\n').map((line) => line.split('\t')[0]?.trim() ?? '').filter((sha) => /^[0-9a-f]{40,64}$/.test(sha)))];
    const found = await git(where, [
      'log', '-n', '1', '--format=%h %s', '--ignore-missing', ...(every ? ['--all'] : []),
      ...(has.length ? ['--not', ...has, '--not'] : []),
      '--end-of-options', ...sources, '--', ...specs,
    ]);
    if (found === null) return unverified;
    if (!found) return null;
    return `git push was refused: a commit "${target}" does not have yet (${found}) touches a protected or local-only (privacy.paths) file, and pushing would send it.`;
  }

  /**
   * The repository's git directories, when its index or any commit on any
   * ref holds a path hidden from this caller — the blob is as readable as
   * the file (`git show HEAD:secret/plan.md`) — or when git keeps anything
   * no ref reaches: a deleted branch's commits, an amended or rebased one,
   * a file staged and then unstaged. Those stay in the store until it is
   * pruned, and what they hold cannot be told from their names — a blob
   * alone has none — so any at all hides it. Found with git itself, and
   * remembered until the index, the refs, a reflog, the packs or the last
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

    const key = [offline, specs.join('\0'), storeStamp(dirs)].join('|');
    const cached = this.gitChecks.get(`${gitDir}|${offline}`);
    if (cached?.key === key) return cached.dirs;

    const tracked = await git(root, ['ls-files', '-z', '--', ...specs]);
    const history = tracked ? '' : await git(root, ['log', '--all', '-n', '1', '--format=%H', '--', ...specs]);
    // Reflogs are not counted as reaching anything: an amended commit is
    // reachable from one alone, and a command can read it there too.
    const leftovers = tracked || history ? '' : await git(root, ['fsck', '--unreachable', '--no-reflogs', '--connectivity-only', '--no-progress']);
    const holds = tracked === null || history === null || leftovers === null
      || Boolean(tracked) || Boolean(history) || /^unreachable /m.test(leftovers);
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
      } else if (entry.isSymbolicLink()) {
        // A command follows a symlink, so what it leads to is hidden with
        // it: a directory whole when the link's name covers every child —
        // readdir calls the link a link, not a directory — and a file under
        // its own path too, which is the one sandbox-exec sees.
        let target: { real: string; dir: boolean } | undefined;
        try {
          target = { real: await fs.promises.realpath(abs), dir: (await fs.promises.stat(abs)).isDirectory() };
        } catch { /* dangling: only the name is there */ }
        if (target?.dir) {
          if (hide(`${rel}/`) || hide(`${rel}/${PROBE}`)) out.push({ path: target.real, dir: true });
        } else if (hide(rel)) {
          out.push({ path: abs, dir: false });
          if (target) out.push({ path: target.real, dir: false });
        }
      } else if (hide(rel)) {
        out.push({ path: abs, dir: false });
      }
    }
  };
  await walk(root, '');

  const state = policy.stateDirs?.();
  const real = (p: string): string | undefined => { try { return fs.realpathSync(p); } catch { return undefined; } };
  for (const dir of policy.hiddenDirs) {
    const at = real(dir);
    if (!at || !fs.statSync(at).isDirectory()) continue;
    const within = (p: string | undefined): p is string => !!p && p.startsWith(`${at}${path.sep}`);
    const tmp = real(state?.tmp ?? '');
    const own = offline ? real(state?.private ?? '') : undefined;
    const keep = [...(!offline && within(tmp) ? [tmp] : []), ...(within(own) ? [own] : [])];
    const keepReadOnly = offline && within(tmp) ? [tmp] : [];
    out.push({ path: at, dir: true, ...(keep.length ? { keep } : {}), ...(keepReadOnly.length ? { keepReadOnly } : {}) });
  }
  for (const file of policy.hiddenFiles?.() ?? []) {
    try {
      // One not there yet — a database's journal, which another process
      // makes when it next writes — is made, empty, so that the mask is in
      // place when it fills: a mount needs something there to cover.
      if (!fs.existsSync(file) && fs.existsSync(path.dirname(file))) fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
      if (fs.lstatSync(file).isFile()) out.push({ path: file, dir: false });
    } catch { /* not there, nor to be made */ }
  }
  out.push(...await linkAliasesOf(out, root));
  return out;
}

/**
 * Where credentials are kept outside a project, under the home folder (and
 * `$XDG_CONFIG_HOME`): ssh and signing keys, cloud, cluster and container
 * logins, git and package-registry credentials, password stores. A command
 * reading one hands it to the model that asked for it.
 */
export function homeSecrets(home = os.homedir(), configHome = process.env['XDG_CONFIG_HOME']): string[] {
  const config = [path.join(home, '.config'), ...(configHome && path.resolve(configHome) !== path.join(home, '.config') ? [path.resolve(configHome)] : [])];
  return [
    ...[
      '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.oci', '.password-store', '.docker/config.json',
      '.netrc', '.git-credentials', '.npmrc', '.yarnrc.yml', '.pypirc', '.gem/credentials',
      '.cargo/credentials', '.cargo/credentials.toml', '.terraform.d/credentials.tfrc.json',
      '.vault-token', '.pgpass', '.my.cnf', '.s3cfg', '.boto', '.databrickscfg', '.env',
      '.local/share/keyrings', '.m2/settings-security.xml',
    ].map((rel) => path.join(home, rel)),
    ...config.flatMap((dir) => ['gcloud', 'gh', 'hub', 'git/credentials', 'doctl', 'op', 'containers/auth.json'].map((rel) => path.join(dir, rel))),
  ];
}

/**
 * Git's configuration files: the repository's (its own git directory's and
 * the common one's, a worktree's too), the user's global ones and the
 * system's. What they name — a credential helper, a filter, an ssh command —
 * the git tool runs with the credentials it keeps in view.
 */
export async function gitConfigFiles(root: string, home = os.homedir(), configHome = process.env['XDG_CONFIG_HOME']): Promise<string[]> {
  const repo = (await gitDirsOf(root)).flatMap((dir) => [path.join(dir, 'config'), path.join(dir, 'config.worktree')]);
  return [...repo, ...globalGitConfigFiles(home, configHome), '/etc/gitconfig'];
}

/** The user's global git configuration files, in the order git reads them. */
export function globalGitConfigFiles(home = os.homedir(), configHome = process.env['XDG_CONFIG_HOME']): string[] {
  return [path.join(configHome ? path.resolve(configHome) : path.join(home, '.config'), 'git', 'config'), path.join(home, '.gitconfig')];
}

/** Those of `paths` that are there, as masks: a folder whole, and what a symlink among them leads to. */
function secretsToHide(paths: string[]): Hidden[] {
  const out: Hidden[] = [];
  for (const p of paths) {
    try {
      const real = fs.realpathSync(p);
      out.push({ path: real, dir: fs.statSync(real).isDirectory() });
    } catch { /* not there */ }
  }
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
    p = stripTrailingSlashes(p);
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
 * command could simply unmount what hides a file. `readOnly` files are
 * mounted over themselves read-only, which also keeps them from being
 * removed, renamed or linked.
 */
export function bwrapArgs(hidden: Hidden[], offline: boolean, cwd: string, file: string, args: string[], layout?: WriteLayout, readOnly: string[] = []): string[] {
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
  for (const p of readOnly) out.push('--ro-bind', p, p);
  out.push('--dev', '/dev', '--proc', '/proc');
  if (offline) out.push('--unshare-net');
  for (const h of hidden) {
    if (!h.dir) { out.push('--ro-bind', '/dev/null', h.path); continue; }
    out.push('--tmpfs', h.path);
    for (const k of h.keep ?? []) out.push('--bind', k, k);
    for (const k of h.keepReadOnly ?? []) out.push('--ro-bind', k, k);
  }
  out.push('--chdir', cwd, '--', file, ...args);
  return out;
}

/**
 * A sandbox-exec profile: everything allowed but the hidden paths, and
 * writes to the `readOnly` files. Only a caller that is not local-only
 * gets one (see the top of this file).
 */
export function seatbeltProfile(hidden: Hidden[], readOnly: string[] = []): string {
  const quote = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = ['(version 1)', '(allow default)'];
  if (readOnly.length) lines.push(`(deny file-write* ${readOnly.map((f) => `(literal ${quote(f)})`).join(' ')})`);
  if (hidden.length) {
    const filters = hidden.map((h) => (h.dir ? `(subpath ${quote(h.path)})` : `(literal ${quote(h.path)})`));
    lines.push(`(deny file-read* file-write* ${filters.join(' ')})`);
    // A later rule wins: the kept parts of a hidden directory are allowed again.
    const keptReadOnly = hidden.flatMap((h) => h.keepReadOnly ?? []);
    if (keptReadOnly.length) lines.push(`(allow file-read* ${keptReadOnly.map((k) => `(subpath ${quote(k)})`).join(' ')})`);
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

//  Extended attributes are refused too, as not supported: set on a folder
//  the command did not otherwise change, one would carry what it read past
//  the stamps that find its writes. What else a folder carries — its mode
//  and times — is put back when the command ends.

const SECCOMP_ARCH: Record<string, { audit: number; socket: number; ioUringSetup: number; xattrWrites: number[] }> = {
  // setxattr, lsetxattr, fsetxattr, removexattr, lremovexattr, fremovexattr, setxattrat, removexattrat
  x64: { audit: 0xc000003e, socket: 41, ioUringSetup: 425, xattrWrites: [188, 189, 190, 197, 198, 199, 463, 466] },
  arm64: { audit: 0xc00000b7, socket: 198, ioUringSetup: 425, xattrWrites: [5, 6, 7, 14, 15, 16, 463, 466] },
};

/** The filter as a compiled cBPF program, as bubblewrap's --seccomp reads it; null on another architecture. */
export function unixSocketFilter(arch: string = process.arch): Buffer | null {
  const a = SECCOMP_ARCH[arch];
  if (!a) return null;
  const LD_ABS = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06;
  const ALLOW = 0x7fff0000;
  const errno = (e: number) => 0x00050000 | e;
  const EACCES = 13, ENOSYS = 38, ENOTSUP = 95, AF_UNIX = 1;
  const program: Array<[number, number, number, number]> = [
    // Jumps are relative: jt/jf skip that many instructions.
    [LD_ABS, 0, 0, 4],                // A = arch
    [JEQ, 1, 0, a.audit],             // this ABI → skip the refusal
    [RET, 0, 0, errno(EACCES)],       //   another ABI
    [LD_ABS, 0, 0, 0],                // A = syscall number
    [JGE, 0, 1, 0x40000000],          // x32 → refuse, else on
    [RET, 0, 0, errno(EACCES)],
    // each extended-attribute write → not supported, else the next check
    ...a.xattrWrites.flatMap((nr): Array<[number, number, number, number]> => [[JEQ, 0, 1, nr], [RET, 0, 0, errno(ENOTSUP)]]),
    [JEQ, 0, 1, a.ioUringSetup],      // io_uring_setup → not there, else on
    [RET, 0, 0, errno(ENOSYS)],
    [JEQ, 0, 3, a.socket],            // socket → check its domain, else allow
    [LD_ABS, 0, 0, 16],               //   A = its domain
    [JEQ, 0, 1, AF_UNIX],             //   AF_UNIX → refuse, else allow
    [RET, 0, 0, errno(EACCES)],
    [RET, 0, 0, ALLOW],
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
      ], ['/nonexistent/cascade-read-only']);
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

/** A file's identity and last change, to tell whether a command changed it. */
interface Stamp { ctime: number; mtime: number; size: number; ino: number; nlink: number }

/**
 * Every file in the workspace, stamped — bar Cascade's folder (other than
 * the parts commands use) and the directories given, which the command
 * cannot write. Symlinks are stamped as themselves, never followed. The
 * directories walked go in `dirs`.
 */
/** A folder's mode and times, as they were before a command ran. */
interface FolderStamp { mode: number; atime: number; mtime: number }

async function stampFiles(root: string, skip: string[], dirs?: Set<string>, folders?: Map<string, FolderStamp>): Promise<Map<string, Stamp>> {
  const out = new Map<string, Stamp>();
  const skipped = new Set(skip);
  const folder = async (abs: string, rel: string): Promise<void> => {
    if (!folders) return;
    try {
      const st = await fs.promises.lstat(abs);
      folders.set(rel, { mode: st.mode & 0o7777, atime: st.atimeMs, mtime: st.mtimeMs });
    } catch { /* gone meanwhile */ }
  };
  await folder(root, '');
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
        dirs?.add(rel);
        await folder(abs, rel);
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
 * Note what each file is now — its contents and mode, or where it leads if
 * a symlink — and return a check that puts back any that has changed since,
 * saying which. One not there now is left to whoever makes it.
 */
function guardFiles(files: string[]): () => string | void {
  const was = new Map<string, { link: string } | { data: Buffer; mode: number }>();
  for (const file of files) {
    try {
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) was.set(file, { link: fs.readlinkSync(file) });
      else if (st.isFile()) was.set(file, { data: fs.readFileSync(file), mode: st.mode & 0o7777 });
    } catch { /* not there */ }
  }
  return () => {
    const restored: string[] = [];
    for (const [file, then] of was) {
      try {
        const st = fs.lstatSync(file, { throwIfNoEntry: false });
        const same = 'link' in then
          ? !!st?.isSymbolicLink() && fs.readlinkSync(file) === then.link
          : !!st?.isFile() && (st.mode & 0o7777) === then.mode && fs.readFileSync(file).equals(then.data);
        if (same) continue;
        fs.rmSync(file, { force: true, recursive: true });
        if ('link' in then) fs.symlinkSync(then.link, file);
        else fs.writeFileSync(file, then.data, { mode: then.mode });
        restored.push(path.basename(file));
      } catch { /* left as it is */ }
    }
    if (restored.length) return `${restored.join(', ')} decide${restored.length === 1 ? 's' : ''} what Cascade protects, and agents may not change ${restored.length === 1 ? 'it' : 'them'}: this command's change was undone.`;
  };
}

/** Put each folder's mode and times back as `folders` has them, where they differ. */
function restoreFolders(root: string, folders: Map<string, FolderStamp>): void {
  for (const [rel, was] of folders) {
    const abs = rel ? path.join(root, rel) : root;
    try {
      const now = fs.lstatSync(abs);
      if (!now.isDirectory()) continue;
      if ((now.mode & 0o7777) !== was.mode) fs.chmodSync(abs, was.mode);
      if (now.atimeMs !== was.atime || now.mtimeMs !== was.mtime) fs.utimesSync(abs, was.atime / 1000, was.mtime / 1000);
    } catch { /* gone, or not ours to change */ }
  }
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

/** How long a command's marks are tried again when they cannot be saved; `CASCADE_MARK_RETRY_MS` in tests. */
const MARK_RETRY_MS = 30_000;

/**
 * Record a local-only command's marks while the workspace is still held —
 * the caller holds the gate, in this process and across processes, until
 * this returns. A save that fails — another process holding the record's
 * lock, a full disk — is tried again for a while. If it still fails, what
 * it left in the project (`remaining`: what it changed, and what it made
 * that could not be moved) would look public to any other process, so it
 * is set aside in its private folder, where no cloud worker can read it;
 * the note says where. Throws, naming the files, when even that fails.
 */
async function recordMarks(
  policy: JailPolicy, marked: string[], remaining: string[], root: string, own: string | undefined,
): Promise<string | void> {
  const deadline = Date.now() + (Number(process.env['CASCADE_MARK_RETRY_MS']) || MARK_RETRY_MS);
  let failure: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      // After a failed save the marks are held in memory: the next attempts
      // save those.
      if (attempt === 0 || !policy.saveMarks) policy.taint?.(marked);
      else policy.saveMarks();
      return;
    } catch (err) {
      failure = err;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
    }
  }
  const why = failure instanceof Error ? failure.message : String(failure);
  const stuck = own ? remaining.filter((rel) => !moveInto(path.join(root, rel), path.join(own, rel))) : remaining;
  if (stuck.length) {
    throw new Error(`Could not record what a local-only command wrote as local-only (${why}), nor set it aside: ${stuck.join(', ')}. Keep other Cascade runs out of this project until privacy-derived.json can be written.`);
  }
  if (remaining.length === 0) return;
  policy.log(`[privacy] Could not record a local-only command's changes (${why}); set aside: ${remaining.join(', ')}`);
  return `Cascade could not record what this local-only command wrote (${why}), so it was moved to its private folder, outside the project, where no cloud worker can read it: ${listed(remaining)}.`;
}

/** Up to ten `@private/` paths, and how many more. */
function listed(rels: string[]): string {
  return `${rels.slice(0, 10).map((rel) => `@private/${rel}`).join(', ')}${rels.length > 10 ? `, and ${rels.length - 10} more` : ''}`;
}

/**
 * Move a file or folder to `to`. A folder already there is merged into —
 * what an earlier command left in it stays, as it does when a file tool
 * writes beside it — and anything else there is replaced, across filesystems
 * by copying. False when something could not be moved: it stays where it is,
 * and is marked there instead.
 */
function moveInto(from: string, to: string): boolean {
  try {
    if (fs.lstatSync(from).isDirectory() && isRealDir(to)) {
      let all = true;
      for (const name of fs.readdirSync(from)) {
        if (!moveInto(path.join(from, name), path.join(to, name))) all = false;
      }
      if (all) fs.rmdirSync(from);
      return all;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { recursive: true, force: true });
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

/** A directory itself — not a symlink to one, which is replaced rather than written through. */
function isRealDir(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

/** The directories that are new, outermost only: each covers those it holds. */
function madeDirs(before: Set<string>, after: Set<string>): string[] {
  const made = (dir: string) => after.has(dir) && !before.has(dir);
  return [...after].filter((dir) => made(dir) && !made(dir.slice(0, Math.max(0, dir.lastIndexOf('/')))));
}

/** The repository's git directories — its own and, for a linked worktree, the common one. */
/**
 * When the store last changed in a way that could change what it holds: the
 * index, HEAD, each ref and reflog folder (a deleted ref changes its folder),
 * the packed refs, each object folder and the last fetch — of the worktree's
 * own git directory and the common one.
 */
function storeStamp(dirs: string[]): string {
  const stamps: number[] = [];
  const at = (p: string) => { try { stamps.push(fs.statSync(p).mtimeMs); } catch { stamps.push(0); } };
  const folders = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    at(dir);
    for (const e of entries) if (e.isDirectory()) folders(path.join(dir, e.name));
  };
  for (const dir of dirs) {
    for (const f of ['index', 'HEAD', 'logs/HEAD', 'packed-refs', 'FETCH_HEAD']) at(path.join(dir, f));
    folders(path.join(dir, 'refs'));
    folders(path.join(dir, 'logs'));
    folders(path.join(dir, 'objects'));
  }
  return stamps.join(',');
}

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
