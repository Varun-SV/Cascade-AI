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
import { createHash } from 'node:crypto';
import ignoreFactory from 'ignore';
import { fileIdentity, PROBE } from '../../utils/link-aliases.js';
import { stripTrailingSlashes } from '../../utils/net.js';
import { reachesUnder, gitignoreRules } from '../../utils/ignore-patterns.js';
export { reachesUnder, gitignoreRules } from '../../utils/ignore-patterns.js';
import { isWithin } from '../../utils/real-path.js';
import { onTrustedPath, trustedDirs } from '../../utils/trusted-exec.js';
import { statePath } from '../../config/project-state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Directories not walked for paths to hide: git's own store, and installed packages unless a rule names a path in them. */
const UNWALKED_DIRS = new Set(['.git', 'node_modules']);

/**
 * Entries read through symlinked folders before commands are refused rather
 * than run with a rule unchecked. Only folders outside the workspace, and
 * ones a rule reaches into by the link's own name (`reachesUnder`), are
 * read this way.
 */
const LINKED_WALK_LIMIT = 50_000;

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
  /**
   * Keep other processes out of the workspace until marks this process
   * could not save are saved (WorkspaceGate.holdPending), trying again in
   * the background.
   */
  holdPending?: (rels: string[]) => void;
  log: (msg: string) => void;
  /** Which jailer this machine has; injectable for tests. */
  detect?: () => Promise<JailKind | null>;
  /** Where a program Cascade starts itself is (`onTrustedPath`); injectable for tests. */
  program?: (name: string) => string | undefined;
}

export interface Launch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The jailer the launch is wrapped in, or null when it runs as it is. */
  jail: JailKind | null;
  /**
   * No jail was available, and the caller runs only what it checks itself
   * (`confinesItself`): the launch runs as it is, and the caller keeps it
   * from starting anything else (the git tool: git-hermetic.ts).
   */
  unconfined?: true;
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
  /** A daemon's socket, or the folder it is in: connecting to it is refused too, where that is a separate rule (sandbox-exec). */
  socket?: boolean;
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
  /**
   * The caller runs only operations it checks itself — the git tool — so
   * where no jail is available it still runs, with the provider keys taken
   * out of its environment, and it keeps the program from starting others
   * (`Launch.unconfined`). Any other command is refused there: nothing but
   * the jail keeps it from reading a protected file and handing it to a
   * cloud model.
   */
  confinesItself?: boolean;
}

/** Why a command was refused for want of a jail, and what the user can do about it. */
function noJailReason(): string {
  const why = process.platform === 'win32'
    ? 'Windows has no supported process jail'
    : process.platform === 'darwin'
      ? 'sandbox-exec is not working on this Mac'
      : 'bubblewrap is missing here or cannot create user namespaces';
  const fix = process.platform === 'linux'
    ? 'Install bubblewrap, or set tools.processJail to "off" to run commands without a jail.'
    : 'Set tools.processJail to "off" to run commands without a jail.';
  return `${why}, so the command was not run: without one it could read protected files (.env, local-only paths, ~/.cascade-ai, credentials in your home folder) and hand them to a cloud model. ${fix}`;
}

export class ProcessJail {
  private warned = false;
  /** Guarded files a command changed that could not be put back (guardFiles), kept on disk too, for later runs. */
  private unrestored = new Map<string, Guarded>();
  private gitChecks = new Map<string, { key: string; dirs: string[] }>();

  /**
   * The repository configuration files the git tool runs as they are: by
   * path, what each held when trusted (`fingerprintOf`).
   */
  private gitTrust?: Map<string, string>;

  constructor(private readonly policy: JailPolicy) {}

  private gitTrustRecord(): string {
    return statePath(this.policy.workspaceRoot, 'git-config-trust.json');
  }

  /**
   * The repositories' configuration files trusted, read from the record
   * once. With no record yet — before the first command — those of the
   * workspace's repository and the ones nested in it now are: no command
   * has run to write them, and while one runs it cannot change them (they
   * are frozen). A repository a command makes later, or a configuration
   * changed since other than by the git tool (a folder renamed over it), is
   * not on it.
   */
  private async trustGitConfigs(nested: string[]): Promise<Map<string, string>> {
    if (this.gitTrust) return this.gitTrust;
    const record = this.gitTrustRecord();
    let trust: Map<string, string>;
    try {
      trust = new Map(Object.entries(JSON.parse(fs.readFileSync(record, 'utf8')) as Record<string, string>));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // One that can't be read trusts nothing, and is left for the user.
        this.gitTrust = new Map();
        return this.gitTrust;
      }
      trust = new Map();
      for (const repo of [this.policy.workspaceRoot, ...nested]) {
        for (const file of repoConfigFiles(await repoGitDirs(repo) ?? [])) {
          const id = fingerprintOf(file);
          if (id) trust.set(file, id);
        }
      }
      this.saveGitTrust(trust);
    }
    this.gitTrust = trust;
    return trust;
  }

  private saveGitTrust(trust: Map<string, string>): void {
    try {
      fs.writeFileSync(this.gitTrustRecord(), JSON.stringify(Object.fromEntries(trust)), { mode: 0o600 });
    } catch { /* kept in this process */ }
  }

  /**
   * The configuration files `cwd`'s repository reads as its own, split into
   * those trusted (`trustGitConfigs`) and not; all of them untrusted when
   * git cannot say where they are.
   */
  async gitConfigTrust(cwd: string): Promise<{ trusted: string[]; untrusted: string[] }> {
    if (this.policy.mode === 'off') return { trusted: [], untrusted: [] };
    const trust = await this.trustGitConfigs([]);
    const dirs = await repoGitDirs(cwd);
    // Not a repository, or one git cannot read: its configuration is checked.
    if (dirs === null) return { trusted: [], untrusted: [cwd] };
    const files = repoConfigFiles(dirs).filter((f) => fs.existsSync(f));
    const trusted = files.filter((f) => trust.get(f) === fingerprintOf(f));
    return { trusted, untrusted: files.filter((f) => !trusted.includes(f)) };
  }

  /**
   * Trust `files` as they are now: the git tool's own call, run with no
   * command beside it, rewrote them (`git push -u` does, by renaming a new
   * file into place).
   */
  retrustGitConfigs(files: string[]): void {
    if (!this.gitTrust || files.length === 0) return;
    for (const file of files) {
      const id = fingerprintOf(file);
      if (id) this.gitTrust.set(file, id);
      else this.gitTrust.delete(file);
    }
    this.saveGitTrust(this.gitTrust);
  }

  /** Where the files that could not be put back are recorded, for later runs and other processes. */
  private unrestoredRecord(): string {
    return statePath(this.policy.workspaceRoot, 'jail-unrestored.json');
  }

  private keepUnrestored(failed: Map<string, Guarded>): void {
    for (const [file, then] of failed) if (!this.unrestored.has(file)) this.unrestored.set(file, then);
    this.saveUnrestored();
  }

  /** Try again to put back what could not be: why commands stay refused, or undefined once all is back. */
  private retryUnrestored(): string | undefined {
    try {
      const recorded = JSON.parse(fs.readFileSync(this.unrestoredRecord(), 'utf8')) as Record<string, { link?: string; data?: string; mode?: number; absent?: boolean }>;
      for (const [file, then] of Object.entries(recorded)) {
        if (this.unrestored.has(file)) continue;
        if (typeof then.link === 'string') this.unrestored.set(file, { link: then.link });
        else if (typeof then.data === 'string' && typeof then.mode === 'number') this.unrestored.set(file, { data: Buffer.from(then.data, 'base64'), mode: then.mode });
        else if (then.absent) this.unrestored.set(file, { absent: true });
      }
    } catch { /* none recorded */ }
    if (!this.unrestored.size) return undefined;
    this.unrestored = putBack(this.unrestored).failed;
    this.saveUnrestored();
    return this.unrestored.size ? unrestoredReason(this.unrestored) : undefined;
  }

  private saveUnrestored(): void {
    try {
      const record = this.unrestoredRecord();
      if (!this.unrestored.size) { fs.rmSync(record, { force: true }); return; }
      const out: Record<string, unknown> = {};
      for (const [file, then] of this.unrestored) {
        out[file] = 'data' in then ? { data: then.data.toString('base64'), mode: then.mode } : then;
      }
      fs.writeFileSync(record, JSON.stringify(out), { mode: 0o600 });
    } catch { /* kept in this process */ }
  }

  /**
   * How to launch `file args` from `cwd`: wrapped in the jail, or as it is
   * with a scrubbed environment, or not at all.
   */
  async prepare(file: string, args: string[], opts: PrepareOptions): Promise<Prepared> {
    const { mode } = this.policy;
    if (mode === 'off') {
      return { ok: true, launch: { file, args, env: { ...process.env }, cwd: opts.cwd, jail: null } };
    }
    // A file an earlier command changed, and that could not be put back,
    // keeps every command and git call from running until it is.
    const unrestored = this.retryUnrestored();
    if (unrestored) return { ok: false, reason: `Commands are not run: ${unrestored}` };
    const env = scrubEnv(process.env, this.policy.secretValues());
    // The git tool's git, and what it starts — ssh, gpg, a credential
    // helper — run with the credentials it keeps in view, so they come only
    // from folders no command can write to: one could otherwise leave its
    // own `git` or `ssh` in ~/.local/bin for the next push to run.
    if (opts.keepGit) env['PATH'] = trustedDirs(this.policy.workspaceRoot).join(path.delimiter);
    const available = await (this.policy.detect ?? detectJail)();
    const kind = mode === 'auto' ? available : (available === mode ? mode : null);

    if (!kind) {
      if (mode !== 'auto') {
        return { ok: false, reason: `tools.processJail is "${mode}", which is not available on this machine, so the command was not run.` };
      }
      if (opts.offline) {
        return { ok: false, reason: 'A local-only subtask (privacy.paths) cannot run commands here: there is no process jail to keep them off the network.' };
      }
      // Scrubbing the environment keeps the keys out of it, not the files
      // on disk: an approved command could still read them. So `auto` fails
      // closed here, and "off" is the user's own choice to run without.
      if (!opts.confinesItself) return { ok: false, reason: noJailReason() };
      if (!this.warned) {
        this.warned = true;
        this.policy.log('[jail] No process jail is available (bubblewrap on Linux, sandbox-exec on macOS): the git tool runs with provider keys removed from its environment and no configuration that can start a program, and shell and code commands are refused until tools.processJail is "off".');
      }
      // No mount keeps git from changing .cascadeignore — a checkout of
      // another commit would — so it is put back as it was when git ends.
      const restorePolicy = guardFiles(this.policy.readOnlyFiles?.() ?? [], (failed) => this.keepUnrestored(failed));
      return { ok: true, launch: { file, args, env, cwd: opts.cwd, jail: null, unconfined: true, done: async () => restorePolicy() } };
    }

    // The jailer itself runs with everything Cascade can reach; one a
    // command left on PATH would run every later command unjailed.
    const jailer = (this.policy.program ?? ((name: string) => onTrustedPath([name], this.policy.workspaceRoot)))(kind);
    if (!jailer) {
      return { ok: false, reason: `${kind} was found only in folders a command could change (or not at all), so the command was not run.` };
    }
    // As root a command could rewrite any program on the machine — the
    // ones Cascade starts outside the jail too, its jailer and git among
    // them. bubblewrap shows it the system read-only (`rootLayout`);
    // sandbox-exec has no such view, so nothing is run.
    if (asRoot() && kind === 'sandbox-exec') {
      return { ok: false, reason: 'Cascade is running as root, and on macOS a command run as root could change the programs Cascade itself runs, so the command was not run. Run Cascade as an ordinary user.' };
    }
    if (opts.offline && kind === 'sandbox-exec') {
      return { ok: false, reason: 'A local-only subtask (privacy.paths) cannot run commands on macOS: sandbox-exec cannot stop a command from hard-linking a file outside the workspace in and writing to it, nor end a child it leaves running, so what it writes could not all be marked local-only.' };
    }
    // Repositories nested in the workspace — independent ones, submodules —
    // are found on the way: each store is checked as the workspace's own is.
    const nested: string[] = [];
    const hidden = await collectHidden(this.policy, opts.offline, nested);
    await this.trustGitConfigs(nested);
    if (!opts.keepGit) {
      for (const repo of [this.policy.workspaceRoot, ...nested]) {
        for (const dir of await this.gitDirsToHide(opts.offline, repo)) hidden.push({ path: dir, dir: true });
      }
      hidden.push(...secretsToHide(this.policy.hiddenSecrets?.() ?? []));
    }
    // A container daemon's socket reaches a process outside the jail that
    // will mount the host for whoever asks — every masked path included.
    // A local-only command has no Unix sockets at all (unixSocketFilter).
    if (!opts.offline) hidden.push(...secretsToHide(hostControlSockets()).map((h) => ({ ...h, socket: true })));
    // The service managers and agents of the user's session start programs
    // outside the jail, or sign with the user's keys, for whoever connects;
    // the git tool's git keeps them, for its credential helper and ssh.
    if (!opts.offline && !opts.keepGit) hidden.push(...secretsToHide(sessionSockets()).map((h) => ({ ...h, socket: true })));
    // Read-only besides: what decides what is protected, and — to every
    // command but the git tool's — git's own configuration, where a command
    // could name a program for the git tool to run with the credentials it
    // keeps (`gitConfigFiles`), with every file it includes.
    const gitConfig = opts.keepGit ? [] : await withIncludes(await gitConfigFiles(this.policy.workspaceRoot, undefined, undefined, nested));
    const policyFiles = this.policy.readOnlyFiles?.() ?? [];
    // Through a symlink — what it leads to — and under every other name the
    // file has in the workspace (hard links), where a write would reach it.
    const real = (f: string): string[] => {
      try { return fs.statSync(f).isFile() ? [fs.realpathSync(f)] : []; } catch { return []; }
    };
    const gitConfigReal = new Set(gitConfig.flatMap(real));
    const frozen = [...new Set([...policyFiles, ...gitConfig].flatMap(real))];
    frozen.push(...(await linkAliasesOf(frozen.map((f) => ({ path: f, dir: false })), this.policy.workspaceRoot)).map((h) => h.path).filter((f) => !frozen.includes(f)));
    // A mount keeps a file's contents, not its name: a command can still
    // remove a symlinked policy file and put another in its place. So each
    // is looked at again when the command ends, and put back if changed —
    // and so is every symlink on the way to a git config file, which a
    // command could swap for a config naming a program for the git tool.
    const restorePolicy = guardFiles([...policyFiles, ...new Set(gitConfig.flatMap((f) => symlinksAlong(f)))], (failed) => this.keepUnrestored(failed));

    if (!opts.offline) {
      // What git's configuration holds goes to the model with anything a
      // command prints, and it can hold a credential: a token in a remote's
      // URL, an `extraheader`. The command is shown each such file with
      // those taken out (`withoutCredentials`); git still finds its
      // remotes and settings there.
      const scrubbed = scrubbedCopies(frozen.filter((f) => gitConfigReal.has(f)));
      const done = async (): Promise<string | void> => {
        try { return restorePolicy(); } finally { scrubbed.cleanup(); }
      };
      if (kind === 'sandbox-exec') {
        // No mount to put a copy in its place: a file that holds one is not
        // readable at all.
        const unreadable = [...scrubbed.copies.keys()].map((f) => ({ path: f, dir: false }));
        return { ok: true, launch: { file: jailer, args: ['-p', seatbeltProfile([...hidden, ...unreadable], frozen), file, ...args], env, cwd: opts.cwd, jail: kind, done } };
      }
      const layout = asRoot() ? rootLayout(this.policy.workspaceRoot) : undefined;
      return { ok: true, launch: { file: jailer, args: bwrapArgs(hidden, false, opts.cwd, file, args, layout, frozen, scrubbed.copies), env, cwd: opts.cwd, jail: kind, done } };
    }

    // A local-only caller's command writes only into the workspace, where
    // what it changed is found when it ends and marked local-only (`done`) —
    // anywhere else, a later command of a cloud worker could read it. Its
    // git store is read-only: a commit message or a staged blob is a write
    // no file shows. The command runs alone meanwhile (tools/workspace-gate.ts).
    let root: string;
    try { root = fs.realpathSync(this.policy.workspaceRoot); } catch { root = path.resolve(this.policy.workspaceRoot); }
    const inside = (p: string) => isWithin(p, root);
    const gitDirs = [...new Set((await Promise.all([root, ...nested].map(gitDirsOf))).flat())].filter(inside);
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
      // Not known to be covered — the record unreadable — is taken as not
      // covered: what it made is then moved to the private folder, or set
      // aside, rather than left where it is.
      const coveredWhole = (rel: string, isDir: boolean) => {
        const parts = rel.split('/');
        try {
          for (let i = isDir ? parts.length : parts.length - 1; i > 0; i--) {
            if (this.policy.isLocalOnly?.(`${parts.slice(0, i).join('/')}/${PROBE}`)) return true;
          }
        } catch { /* see above */ }
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
    const filter = unixSocketFilterFile(this.policy.workspaceRoot);
    if (!filter) {
      return { ok: false, reason: `A local-only subtask (privacy.paths) cannot run commands on ${process.arch}: the filter that keeps them off host sockets is built for x64 and arm64 only.` };
    }
    const jailArgs = bwrapArgs(hidden, true, opts.cwd, file, args, layout, frozen);
    return {
      ok: true,
      launch: {
        file: '/bin/sh', args: ['-c', 'jailer=$1; shift; exec "$jailer" --seccomp 9 "$@" 9<"$0"', filter, jailer, ...jailArgs],
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
  async pushRefusal(
    cwd: string, args: string[], offline: boolean,
    lsRemote: (target: string) => Promise<string | null>,
  ): Promise<string | null> {
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
      // The last of `--delete` and `--no-delete` is the one git goes by. An
      // abbreviation of `--delete` is left alone: taken for a push, it is
      // checked as one.
      if (arg === '-d' || arg === '--delete') { deleting = true; continue; }
      if (abbreviates(arg, '--no-delete', '--no-de'.length)) { deleting = false; continue; }
      // A submodule's commits are not in this history, so a push that
      // sends them is not one this can check. The git tool turns the
      // configured default (push.recurseSubmodules) off.
      const [name = '', inline] = splitOption(arg);
      if (abbreviates(name, '--recurse-submodules', '--rec'.length)) {
        const value = inline ?? args[++i] ?? '';
        if (!PUSH_NO_RECURSION.has(value.toLowerCase())) {
          return `git push was refused: --recurse-submodules=${value} pushes submodules too, and their history is not checked for protected or local-only (privacy.paths) files. Push each submodule from its own folder instead.`;
        }
        continue;
      }
      // Git takes any unambiguous abbreviation (`--ta` for `--tags`); one
      // that could also be another option is taken for the bulk one, which
      // checks more.
      if (PUSH_BULK_OPTIONS.some((option) => abbreviates(arg, option, '--a'.length))) { bulk = true; continue; }
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
    // Asked as the push itself will be (`lsRemote`, the caller's jailed
    // git): reaching a remote can run a program — a remote helper, an
    // `ext::` URL — which must not have what a raw git here has.
    if (target.startsWith('-')) return unverified;
    const advertised = await lsRemote(target);
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
  private async gitDirsToHide(offline: boolean, repo = this.policy.workspaceRoot): Promise<string[]> {
    const root = repo;
    const patterns = this.policy.hiddenPatterns(offline);
    const specs = toPathspecs(patterns);
    if (specs.length === 0) return [];
    // Where a repository nested in the workspace sits in it: its paths are
    // named from there, not from the workspace the patterns are written for.
    const nestedAt = path.resolve(repo) === path.resolve(this.policy.workspaceRoot)
      ? undefined
      : path.relative(this.policy.workspaceRoot, repo).split(path.sep).join('/');
    const located = await git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
    // Git could not say where the store is, so not what it holds either:
    // the store the folder shows is hidden, as when git cannot tell below.
    if (located === null) return knownStores(root);
    const [gitDir = '', common = ''] = located.split('\n').map((line) => line.trim());
    if (!gitDir) return knownStores(root);
    const dirs = [...new Set([gitDir, path.resolve(root, common || gitDir)])];

    const key = [offline, specs.join('\0'), storeStamp(dirs)].join('|');
    const cached = this.gitChecks.get(`${gitDir}|${offline}`);
    if (cached?.key === key) return cached.dirs;

    const found = nestedAt === undefined
      ? await this.holdsHidden(root, specs)
      : await this.nestedHoldsHidden(root, nestedAt, patterns);
    // Reflogs are not counted as reaching anything: an amended commit is
    // reachable from one alone, and a command can read it there too.
    const leftovers = found !== false ? '' : await git(root, ['fsck', '--unreachable', '--no-reflogs', '--connectivity-only', '--no-progress']);
    const holds = found !== false || leftovers === null || /^unreachable /m.test(leftovers);
    const result = holds ? dirs : [];
    this.gitChecks.set(`${gitDir}|${offline}`, { key, dirs: result });
    return result;
  }

  /** Whether the workspace's own index or history holds a hidden path; null when git cannot tell. */
  private async holdsHidden(root: string, specs: string[]): Promise<boolean | null> {
    const tracked = await git(root, ['ls-files', '-z', '--', ...specs]);
    if (tracked === null) return null;
    if (tracked) return true;
    const history = await git(root, ['log', '--all', '-n', '1', '--format=%H', '--', ...specs]);
    return history === null ? null : Boolean(history);
  }

  /**
   * The same for a repository nested in the workspace at `at`. Its paths are
   * not the workspace's, so every path its index and history hold is named
   * as the workspace names it and judged by the patterns themselves — a
   * pattern naming a path through it (`vendor/lib/token.txt`, a local-only
   * mark there) included.
   */
  private async nestedHoldsHidden(root: string, at: string, patterns: string[]): Promise<boolean | null> {
    const tracked = await git(root, ['ls-files', '-z']);
    const history = tracked === null ? null : await git(root, ['log', '--all', '--name-only', '--format=', '-z']);
    if (tracked === null || history === null) return null;
    const matcher = ignoreFactory().add(patterns);
    const names = new Set([...tracked.split('\0'), ...history.split(/[\0\n]/)].filter(Boolean));
    for (const name of names) {
      try {
        if (matcher.ignores(`${at}/${name}`)) return true;
      } catch {
        return true;
      }
    }
    return false;
  }
}

/** `env` without provider keys: the known names, and any variable holding a configured secret. */
export function scrubEnv(env: NodeJS.ProcessEnv, secretValues: string[]): NodeJS.ProcessEnv {
  const secrets = [...new Set(secretValues.filter((v) => v && v.length >= 8))];
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAMES.includes(name.toUpperCase())) continue;
    // Anywhere in the value: `Bearer <key>`, a URL holding it.
    if (value !== undefined && secrets.some((secret) => value.includes(secret))) continue;
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
export async function collectHidden(policy: JailPolicy, offline: boolean, nestedRepos?: string[], linkedLimit = LINKED_WALK_LIMIT): Promise<Hidden[]> {
  const out: Hidden[] = [];
  let root: string;
  try { root = fs.realpathSync(policy.workspaceRoot); } catch { root = path.resolve(policy.workspaceRoot); }
  const hide = (rel: string): boolean => policy.isProtected(rel) || (!offline && !!policy.isLocalOnly?.(rel));
  const patterns = policy.hiddenPatterns(offline);
  /** Entries read through symlinked directories so far. See LINKED_WALK_LIMIT. */
  let throughLinks = 0;

  /**
   * `chain`: the real directories the walk is inside, so a link back up to
   * one of them is not followed round again. `link`: the symlink whose name
   * this part of the walk goes by, if any.
   */
  const walk = async (dir: string, relDir: string, chain: string[], link?: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A folder that cannot be listed — one that can be entered but not
      // read, say — cannot be checked for what it holds, though a command
      // that knows a name in it can open it: hidden whole. One gone
      // meanwhile has nothing to hide.
      // The workspace itself cannot be hidden whole and still be worked
      // in: commands are refused.
      if (!relDir) throw new Error(`Commands are not run: the workspace folder ${dir} cannot be listed (${(err as Error).message}), so what it holds cannot be checked for files to hide.`);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') out.push({ path: dir, dir: true });
      return;
    }
    if (link !== undefined) {
      throughLinks += entries.length;
      if (throughLinks > linkedLimit) {
        throw new Error(`Commands are not run: "${link}" is a symlinked folder in which a protection or privacy rule can name a file by that name, and it leads to more than ${linkedLimit.toLocaleString('en-US')} files to check.`);
      }
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      // A nested repository's store — a `.git` folder, or a submodule's
      // `.git` file naming one — for the caller to check.
      if (entry.name === '.git' && relDir) nestedRepos?.push(dir);
      // …and a bare one, which is a store with no `.git` in it.
      else if (entry.isDirectory() && entry.name !== '.git' && looksLikeBareRepo(abs)) nestedRepos?.push(abs);
      if (entry.isDirectory()) {
        if (rel === '.cascade') {
          const keep = CASCADE_DIR_KEPT.map((k) => path.join(abs, k)).filter((k) => fs.existsSync(k));
          out.push({ path: abs, dir: true, keep });
          // The kept parts are mounted back whole; what in them is hidden
          // is masked again after (a local-only subtask's file in tmp).
          for (const k of keep) await walk(k, `${rel}/${path.basename(k)}`, [...chain, abs, k], link);
          continue;
        }
        if (hide(`${rel}/`) || hide(`${rel}/${PROBE}`)) { out.push({ path: abs, dir: true }); continue; }
        if (chain.includes(abs)) continue;
        // Installed packages are walked only for a rule that names a path
        // in them by their folder's name (`node_modules/pkg/**`): the
        // secret-file patterns that match at any depth would hide what
        // packages ship and need, certificate bundles among them.
        if (UNWALKED_DIRS.has(entry.name) && (entry.name === '.git' || !patterns.some((p) => reachesUnder(p, rel)))) continue;
        await walk(abs, rel, [...chain, abs], link);
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
          if (hide(`${rel}/`) || hide(`${rel}/${PROBE}`)) {
            out.push({ path: target.real, dir: true });
          } else if (chain.includes(target.real) && patterns.some((p) => reachesUnder(p, rel))) {
            throw new Error(`Commands are not run: a protection or privacy rule reaches through the cyclic symlink "${rel}", so its paths could not all be hidden.`);
          } else if (!chain.includes(target.real) && (!UNWALKED_DIRS.has(entry.name) || (entry.name !== '.git' && patterns.some((p) => reachesUnder(p, rel))))) {
            // A rule naming something inside it by the link's name —
            // `alias/secret.txt` for `alias -> data` — is met by no other
            // walk: the one of `data` goes by `data/secret.txt`. So it is
            // walked again under this name, and what a rule matches there is
            // hidden where it really is, which hides it by both names. A
            // folder outside the workspace is met by no other walk at all,
            // so it is walked for every rule — `.env` at any depth too.
            if (!isWithin(target.real, root) || patterns.some((p) => reachesUnder(p, rel))) {
              await walk(target.real, rel, [...chain, target.real], link ?? rel);
            }
          }
        } else if (hide(rel)) {
          out.push({ path: abs, dir: false });
          if (target) out.push({ path: target.real, dir: false });
        }
      } else if (hide(rel)) {
        out.push({ path: abs, dir: false });
      }
    }
  };
  await walk(root, '', [root]);

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
export async function gitConfigFiles(
  root: string, home = os.homedir(), configHome = process.env['XDG_CONFIG_HOME'], nested: string[] = [],
): Promise<string[]> {
  const dirs = [...new Set((await Promise.all([root, ...nested].map(gitDirsOf))).flat())];
  const repo = repoConfigFiles(dirs);
  return [...repo, ...globalGitConfigFiles(home, configHome), '/etc/gitconfig'];
}

/** The most git config files, includes and all, frozen for one command (see withIncludes). */
const INCLUDE_LIMIT = 1_000;

/**
 * `files` and every file their `include.path` and `includeIf.*.path`
 * entries name, whatever the condition — one not in force now may be
 * later — followed into what those include in turn, as git does. What such
 * a file says git reads as its own configuration, so it is frozen with the
 * rest; one not there yet is made empty first, so no command can make it.
 * More than `limit` files throws rather than leave the rest unfrozen.
 */
export async function withIncludes(files: string[], home = os.homedir(), limit = INCLUDE_LIMIT): Promise<string[]> {
  const out = new Set<string>();
  const queue = [...files];
  while (queue.length) {
    const file = queue.shift()!;
    if (out.has(file)) continue;
    // Every file git would read is frozen, or no command runs: one left out
    // could be rewritten to name a program for the git tool.
    if (out.size >= limit) {
      throw new Error(`git's configuration includes more than ${limit} files, too many to keep from commands, so the command was not run.`);
    }
    out.add(file);
    if (!fs.existsSync(file)) continue;
    for (const target of await includesOf(file, home)) {
      if (out.has(target)) continue;
      if (!fs.existsSync(target)) {
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.writeFileSync(target, '', { flag: 'wx', mode: 0o600 });
        } catch { /* made meanwhile, or cannot be: frozen if there */ }
      }
      queue.push(target);
    }
  }
  return [...out];
}

/** What a config file's include entries name, as git resolves them: `~/` from home, a relative path from the file's own folder. */
const includeCache = new Map<string, { stamp: string; targets: string[] }>();
async function includesOf(file: string, home: string): Promise<string[]> {
  let stamp: string;
  try { const st = fs.statSync(file); stamp = `${st.ino}:${st.mtimeMs}:${st.size}`; } catch { return []; }
  const cached = includeCache.get(file);
  if (cached?.stamp === stamp) return cached.targets;
  // Expanded by git itself (`--path`): `~/`, `~user/` and `%(prefix)/` as it
  // reads them when it loads the include. What is still relative after that
  // is relative to the including file, as git takes an include.
  const listed = await new Promise<string>((resolve) => {
    execFile(trustedGit(), ['config', '--file', file, '--null', '--path', '--get-regexp', '^include(if\\..*)?\\.path$'],
      { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, HOME: home } }, (_err, stdout) => resolve(stdout ?? ''));
  });
  const targets = listed.split('\0').filter(Boolean).flatMap((entry) => {
    const value = entry.slice(entry.indexOf('\n') + 1);
    return value ? [path.resolve(path.dirname(file), value)] : [];
  });
  includeCache.set(file, { stamp, targets });
  return targets;
}

/** The user's global git configuration files, in the order git reads them. */
export function globalGitConfigFiles(home = os.homedir(), configHome = process.env['XDG_CONFIG_HOME']): string[] {
  return [path.join(configHome ? path.resolve(configHome) : path.join(home, '.config'), 'git', 'config'), path.join(home, '.gitconfig')];
}

/**
 * Where the user's session listens for requests that run a program outside
 * any jail or use the user's keys: D-Bus (the session bus and the system
 * one), whose systemd will start a unit for a caller — `systemd-run
 * --user` — and systemd's own sockets; the ssh and gpg agents. A bus
 * address in the abstract namespace has no file to hide.
 */
export function sessionSockets(env: NodeJS.ProcessEnv = process.env): string[] {
  const runtime = env['XDG_RUNTIME_DIR'] || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '');
  const out = ['/run/dbus/system_bus_socket', '/var/run/dbus/system_bus_socket', '/run/systemd/private'];
  if (runtime) out.push(path.join(runtime, 'bus'), path.join(runtime, 'systemd'), path.join(runtime, 'gnupg'), path.join(runtime, 'keyring'));
  for (const address of (env['DBUS_SESSION_BUS_ADDRESS'] ?? '').split(';')) {
    const at = /(?:^|[:,])path=([^,]+)/.exec(address)?.[1];
    if (at) out.push(decodeURIComponent(at));
  }
  if (env['SSH_AUTH_SOCK']) out.push(env['SSH_AUTH_SOCK']);
  return out;
}

/**
 * Where the daemons that run containers listen, for this user and for the
 * machine: Docker (rootful, rootless, Docker Desktop, Colima, Rancher
 * Desktop), Podman, containerd, CRI-O, LXD and BuildKit, and a socket
 * DOCKER_HOST names. Any of them will start a container with the host's
 * root mounted, for whoever can connect.
 */
export function hostControlSockets(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const runtime = env['XDG_RUNTIME_DIR'] || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '');
  const out = [
    '/var/run/docker.sock', '/run/docker.sock', '/run/podman', '/run/containerd', '/run/crio',
    '/var/snap/lxd/common/lxd/unix.socket', '/var/lib/lxd/unix.socket', '/run/buildkit',
    path.join(home, '.docker', 'run'), path.join(home, '.colima'), path.join(home, '.rd'), path.join(home, '.lima'),
  ];
  if (runtime) out.push(path.join(runtime, 'docker.sock'), path.join(runtime, 'podman'), path.join(runtime, 'containerd'), path.join(runtime, 'buildkit'));
  const dockerHost = env['DOCKER_HOST'];
  if (dockerHost?.startsWith('unix://')) out.push(dockerHost.slice('unix://'.length));
  return out;
}

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
  // A hidden folder on the workspace's disk that can't be read through may
  // hold a file with a name in the workspace too, which no inode says: then
  // every file there with other names is taken as one (`unknown`). One on
  // another disk can share no file with it.
  let rootDev: number | undefined;
  try { rootDev = fs.statSync(root).dev; } catch { /* checked as it comes */ }
  let unknown = false;
  const note = async (abs: string) => {
    try {
      const st = await fs.promises.lstat(abs);
      if (st.isFile() && st.nlink > 1) ids.add(fileIdentity(st));
    } catch { /* gone meanwhile */ }
  };
  const everything = async (dir: string, keep: Set<string>): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      try { if (fs.statSync(dir).dev === rootDev) unknown = true; } catch { /* gone meanwhile */ }
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (keep.has(abs)) continue;
      if (e.isDirectory()) await everything(abs, keep);
      else if (e.isFile()) await note(abs);
    }
  };
  for (const h of hidden) {
    if (h.socket) continue;
    if (h.dir) await everything(h.path, new Set(h.keep ?? []));
    else await note(h.path);
  }
  if (ids.size === 0 && !unknown) return [];

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
        // Installed packages stay in view (pnpm links them in from its store).
        const linked = ids.has(fileIdentity(st)) || (unknown && !abs.split(path.sep).includes('node_modules'));
        if (st.nlink > 1 && linked) aliases.push({ path: abs, dir: false });
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
  for (const rule of gitignoreRules(patterns)) {
    let p = stripTrailingSlashes(rule);
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
export function bwrapArgs(
  hidden: Hidden[], offline: boolean, cwd: string, file: string, args: string[],
  layout?: WriteLayout, readOnly: string[] = [], replaced: ReadonlyMap<string, string> = new Map(),
): string[] {
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
  // A `replaced` file is shown as its copy, read-only, at its own path.
  for (const p of readOnly) out.push('--ro-bind', replaced.get(p) ?? p, p);
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
    // Connecting to a Unix socket is a network rule here, not a file one.
    const sockets = hidden.filter((h) => h.socket);
    if (sockets.length) {
      lines.push(`(deny network-outbound ${sockets.map((h) => `(remote unix-socket (${h.dir ? 'path-prefix' : 'path-literal'} ${quote(h.path)}))`).join(' ')})`);
    }
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

/**
 * The filter in a file for the shell to open, in the workspace's state
 * folder — hidden from every command, where none can swap in a program
 * that lets sockets through for the next local-only one — and written
 * again whenever it is not the filter, so what a launch opens is.
 */
function unixSocketFilterFile(workspaceRoot: string): string | null {
  const program = unixSocketFilter();
  if (!program) return null;
  const file = statePath(workspaceRoot, 'jail-unix-sockets.bpf');
  try {
    if (fs.readFileSync(file).equals(program)) return file;
  } catch { /* not there yet */ }
  const next = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(next, program, { mode: 0o600 });
  fs.renameSync(next, file);
  return file;
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
      const bwrap = onTrustedPath(['bwrap']);
      const ok = bwrap !== undefined && await runs(bwrap, bwrapArgs([], true, '/', 'true', []));
      return ok ? 'bwrap' : null;
    }
    if (process.platform === 'darwin') {
      const probe = seatbeltProfile([
        { path: '/nonexistent/cascade-probe', dir: false },
        { path: '/nonexistent/cascade-dir', dir: true, keep: ['/nonexistent/cascade-dir/tmp'] },
      ], ['/nonexistent/cascade-read-only']);
      const sandboxExec = onTrustedPath(['sandbox-exec']);
      const ok = sandboxExec !== undefined && await runs(sandboxExec, ['-p', probe, '/usr/bin/true']);
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
 * Copies of the git configuration `files` that hold a credential, with it
 * taken out (`withoutCredentials`), keyed by the file they stand for; those
 * that hold none are not copied. In a folder of their own, readable by this
 * user alone, which `cleanup` removes.
 */
function scrubbedCopies(files: string[]): { copies: Map<string, string>; cleanup: () => void } {
  const copies = new Map<string, string>();
  let dir: string | undefined;
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const clean = withoutCredentials(text);
    if (clean === text) continue;
    dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-gitconfig-'));
    const copy = path.join(dir, `${copies.size}.config`);
    fs.writeFileSync(copy, clean, { mode: 0o600 });
    copies.set(file, copy);
  }
  return { copies, cleanup: () => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * A git configuration file's text without the credentials it can hold: the
 * user part of every URL (`https://user:token@host/` → `https://host/`), in
 * values and in section names alike, and every key whose name says it holds
 * a secret (`extraheader`, `password`, `token`, `secret`, `pass`), with the
 * lines its value continues onto. The rest is kept as written.
 */
export function withoutCredentials(text: string): string {
  const out: string[] = [];
  // Whether the line before went on to this one, and if so whether it was dropped.
  let continuing: 'kept' | 'dropped' | null = null;
  for (const line of text.split('\n')) {
    // A value ending in an unescaped backslash goes on to the next line.
    const continues = endsEscaped(line);
    const key: string | undefined = continuing ? undefined : /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(=|$)/.exec(line)?.[1];
    const drop: boolean = continuing === 'dropped' || (!!key && SECRET_GIT_KEY.test(key));
    if (!drop) out.push(withoutUserinfo(line));
    continuing = continues ? (drop ? 'dropped' : 'kept') : null;
  }
  return out.join('\n');
}

/** Keys in a git configuration that hold a secret, by their name. */
const SECRET_GIT_KEY = /(extraheader|password|passwd|token|secret|^pass$|smtppass)/i;

/** Whether `line` (a trailing `\r` aside) ends in an odd run of backslashes. */
function endsEscaped(line: string): boolean {
  let end = line.length;
  if (line[end - 1] === '\r') end--;
  let slashes = 0;
  while (end - slashes > 0 && line[end - slashes - 1] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** `line` with the user part of each URL in it taken out: `https://user:token@host` → `https://host`. */
function withoutUserinfo(line: string): string {
  let out = '';
  let from = 0;
  for (let at = line.indexOf('://'); at !== -1; at = line.indexOf('://', at + 3)) {
    const start = at + 3;
    let end = start;
    while (end < line.length && !/[\s/@"]/.test(line[end]!)) end++;
    if (line[end] !== '@') continue;
    out += line.slice(from, start);
    from = end + 1;
    // The next search starts just past the '@'.
    at = end - 2;
  }
  return out + line.slice(from);
}

/**
 * The symlinks met on the way to `file`, its own name included: each
 * folder or file along it that is one, and those along where each leads.
 */
function symlinksAlong(file: string, seen = new Set<string>()): string[] {
  const out: string[] = [];
  const full = path.resolve(file);
  let at = path.parse(full).root;
  for (const part of full.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    if (seen.has(at)) continue;
    const st = fs.lstatSync(at, { throwIfNoEntry: false });
    if (!st) break;
    if (!st.isSymbolicLink()) continue;
    seen.add(at);
    out.push(at);
    try {
      out.push(...symlinksAlong(path.resolve(path.dirname(at), fs.readlinkSync(at)), seen));
    } catch { /* unreadable: the link itself is still kept */ }
  }
  return out;
}

/** What a guarded file was: where it led, what it held, or that it was not there. */
type Guarded = { link: string } | { data: Buffer; mode: number } | { absent: true };

/**
 * Note what each file is now — its contents and mode, or where it leads if
 * a symlink, or that it is not there (one a command makes there is removed:
 * what it would hold decides what is protected as much as an edit would) —
 * and return a check that puts back any that has changed since, saying
 * which. One that cannot be put back is handed to `onFailed`.
 */
function guardFiles(files: string[], onFailed: (failed: Map<string, Guarded>) => void): () => string | void {
  const was = new Map<string, Guarded>();
  for (const file of files) {
    try {
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!st) was.set(file, { absent: true });
      else if (st.isSymbolicLink()) was.set(file, { link: fs.readlinkSync(file) });
      else if (st.isFile()) was.set(file, { data: fs.readFileSync(file), mode: st.mode & 0o7777 });
    } catch { /* unreadable: left to the read-only mount */ }
  }
  return () => {
    const { restored, failed } = putBack(was);
    if (failed.size) onFailed(failed);
    const notes: string[] = [];
    if (restored.length) notes.push(`${restored.join(', ')} decide${restored.length === 1 ? 's' : ''} what Cascade protects, and agents may not change ${restored.length === 1 ? 'it' : 'them'}: this command's change was undone.`);
    if (failed.size) notes.push(unrestoredReason(failed));
    if (notes.length) return notes.join(' ');
  };
}

/** Put each file back as `was` has it, where it differs: which were put back, and which could not be. */
function putBack(was: ReadonlyMap<string, Guarded>): { restored: string[]; failed: Map<string, Guarded> } {
  const restored: string[] = [];
  const failed = new Map<string, Guarded>();
  for (const [file, then] of was) {
    try {
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      const same = 'absent' in then
        ? !st
        : 'link' in then
          ? !!st?.isSymbolicLink() && fs.readlinkSync(file) === then.link
          : !!st?.isFile() && (st.mode & 0o7777) === then.mode && fs.readFileSync(file).equals(then.data);
      if (same) continue;
      fs.rmSync(file, { force: true, recursive: true });
      if ('absent' in then) { /* removed: it was not there */ } else if ('link' in then) fs.symlinkSync(then.link, file);
      else fs.writeFileSync(file, then.data, { mode: then.mode });
      restored.push(path.basename(file));
    } catch {
      failed.set(file, then);
    }
  }
  return { restored, failed };
}

/** Why commands are refused while `failed` could not be put back. */
function unrestoredReason(failed: ReadonlyMap<string, Guarded>): string {
  const names = [...failed.keys()];
  const one = names.length === 1;
  return `${names.join(', ')} ${one ? 'was' : 'were'} changed by a command and could not be put back. ${one ? 'It decides' : 'They decide'} what Cascade protects or what the git tool runs, so no command or git call runs until ${one ? 'it is' : 'they are'} restored: make ${one ? 'it' : 'them'} writable again, or put ${one ? 'it' : 'them'} back by hand.`;
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
export async function recordMarks(
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
  // Held in memory, these marks keep this process right; every other one
  // reads the record, which lacks them — deletions and links included,
  // which nothing below sets aside. So other processes are kept out until
  // the record has them.
  policy.holdPending?.(marked);
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

/**
 * The git directory of the repository `cwd` is in, and its common one, by
 * real path — the same from any folder in it — or null when git cannot say.
 */
async function repoGitDirs(cwd: string): Promise<string[] | null> {
  const located = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  if (located === null) return null;
  const dirs = located.split('\n').map((line) => line.trim()).filter(Boolean);
  if (dirs.length === 0) return null;
  return [...new Set(dirs.map((dir) => { try { return fs.realpathSync(dir); } catch { return dir; } }))];
}

/** Whether Cascade runs as root, who can write to every file on the machine. */
function asRoot(): boolean {
  return process.platform !== 'win32' && process.getuid?.() === 0;
}

/**
 * What a command run as root may write to: the workspace, the temporary
 * folders and the home folder. The rest of the machine is read-only to it —
 * the programs Cascade starts outside the jail (`onTrustedPath`), the
 * libraries they load, what cron, systemd and the dynamic loader read in
 * /etc and /var — since root, as their owner, could otherwise rewrite them.
 */
export function rootLayout(workspaceRoot: string, home = os.homedir()): WriteLayout {
  const writable = [workspaceRoot, os.tmpdir(), '/tmp', '/var/tmp', home]
    .filter((dir, i, all) => all.indexOf(dir) === i && fs.existsSync(dir));
  return { writable, readOnly: [], scratch: [] };
}

/** A git directory's configuration files: its own and its worktree's. */
function repoConfigFiles(gitDirs: string[]): string[] {
  return gitDirs.filter(Boolean).flatMap((dir) => [path.join(dir, 'config'), path.join(dir, 'config.worktree')]);
}

/**
 * What `file` holds, as a hash — what git reads from it, whichever file it
 * is (an inode can be used again) — or undefined when it is no file.
 */
function fingerprintOf(file: string): string | undefined {
  try {
    return fs.statSync(file).isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : undefined;
  } catch {
    return undefined;
  }
}

async function gitDirsOf(root: string): Promise<string[]> {
  const located = await git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  if (located === null) return knownStores(root);
  const [gitDir = '', common = ''] = located.split('\n').map((line) => line.trim());
  if (!gitDir) return knownStores(root);
  return [...new Set([gitDir, path.resolve(root, common || gitDir)])];
}

/**
 * Where a repository at `root` keeps its store, read from the folder alone,
 * for when git cannot say — a malformed config, a check that timed out: its
 * `.git` folder, the folder a `.git` file names, or `root` itself when it is
 * a bare one. None when it is not a repository at all.
 */
function knownStores(root: string): string[] {
  const dotGit = path.join(root, '.git');
  const st = fs.lstatSync(dotGit, { throwIfNoEntry: false });
  if (st?.isDirectory()) return [dotGit];
  if (st?.isFile()) {
    try {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1];
      return named ? [path.resolve(root, named)] : [dotGit];
    } catch {
      return [dotGit];
    }
  }
  return looksLikeBareRepo(root) ? [root] : [];
}

/** Whether `dir` is laid out as a bare git repository: a HEAD file beside objects/ and refs/. */
function looksLikeBareRepo(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'HEAD')).isFile()
      && fs.statSync(path.join(dir, 'objects')).isDirectory()
      && fs.statSync(path.join(dir, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

/** `git push` options that push refs wholesale rather than the ones named. */
const PUSH_BULK_OPTIONS = ['--all', '--branches', '--mirror', '--tags'];

/** `--recurse-submodules` values with which git push sends no submodule's commits. */
const PUSH_NO_RECURSION = new Set(['no', 'false', 'off', '0', 'check']);

/** Whether `arg` is `full` or an abbreviation of it git accepts — at least `min` long. */
function abbreviates(arg: string, full: string, min: number): boolean {
  return arg.length >= min && full.startsWith(arg);
}

/** A long option split at its first `=`: the name, and the value given inline. */
function splitOption(arg: string): [string, string | undefined] {
  const at = arg.indexOf('=');
  return at === -1 ? [arg, undefined] : [arg.slice(0, at), arg.slice(at + 1)];
}

/** `git push` options that take their value as the next argument. */
const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec']);

/** The remote a bare `git push` goes to: the branch's push remote, the default one, its upstream's, or origin. */
/** The hooks a repository runs as it receives a push: each can run anything, as whoever pushes. */
const RECEIVE_HOOKS = ['pre-receive', 'update', 'post-receive', 'post-update', 'push-to-checkout', 'reference-transaction', 'proc-receive'];

/**
 * The receive hooks a `git push` with `args` from `cwd` would run, because
 * its destination is a repository on this machine: there git runs the
 * receiving side here, with whatever the pusher has in view — the git tool
 * keeps the home credentials and the network, and a command could have
 * written the hook. Empty when the destination is elsewhere, or has none.
 */
export async function localReceiveHooks(cwd: string, args: string[]): Promise<string[]> {
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { target ??= args[i + 1]; break; }
    if (arg.startsWith('--repo=')) { target = arg.slice('--repo='.length); continue; }
    if (arg === '--repo') { target = args[++i]; continue; }
    if (PUSH_OPTIONS_WITH_VALUE.has(arg)) { i++; continue; }
    if (arg.startsWith('-')) continue;
    target ??= arg;
  }
  target ??= await defaultPushRemote(cwd);
  const remotes = (await git(cwd, ['remote']))?.split('\n').map((r) => r.trim()) ?? [];
  const urls = remotes.includes(target)
    ? (await git(cwd, ['remote', 'get-url', '--push', '--all', target]))?.split('\n').map((u) => u.trim()).filter(Boolean) ?? []
    : [target];
  const found: string[] = [];
  for (const url of urls) {
    let dest: string;
    if (url.startsWith('file://')) {
      try { dest = fileURLToPath(url); } catch { continue; }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      continue;
    } else {
      dest = path.resolve(cwd, url);
      if (!fs.existsSync(dest)) continue;
    }
    const store = knownStores(dest)[0];
    if (!store) continue;
    // Where it looks for hooks: core.hooksPath as git there reads it — its
    // own configuration, the user's and the system's — or its hooks folder,
    // in the common store for a linked worktree. Receive hooks run in the
    // store, which a relative core.hooksPath is taken from; the worktree is
    // looked in too, rather than miss one.
    const hooksPath = await git(dest, ['config', '--path', '--get', 'core.hooksPath']);
    const common = await git(dest, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const stores = [...new Set([store, ...(common ? [common] : [])])];
    const dirs = hooksPath
      ? [...new Set([...stores, dest].map((base) => path.resolve(base, hooksPath)))]
      : stores.map((s) => path.join(s, 'hooks'));
    for (const dir of dirs) {
      for (const hook of RECEIVE_HOOKS) {
        const file = path.join(dir, hook);
        try {
          if (fs.statSync(file).isFile() && (process.platform === 'win32' || (fs.accessSync(file, fs.constants.X_OK), true))) found.push(file);
        } catch { /* none */ }
      }
    }
  }
  return found;
}

async function defaultPushRemote(cwd: string): Promise<string> {
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const read = (key: string) => git(cwd, ['config', '--get', key]);
  return (branch ? await read(`branch.${branch}.pushRemote`) : null)
    || await read('remote.pushDefault')
    || (branch ? await read(`branch.${branch}.remote`) : null)
    || 'origin';
}

/**
 * git as the jail runs it outside any jail: from a folder no command can
 * write to (`onTrustedPath`), or a name that runs nothing when there is
 * none, so the call fails as it would with git missing.
 */
export function trustedGit(): string {
  return onTrustedPath(['git']) ?? path.join(os.tmpdir(), 'cascade-no-trusted-git', 'git');
}

/**
 * git's output in `cwd`, or null when it failed — not a repository, or git
 * missing. Run outside any jail, so with nothing its configuration names to
 * start: an fsmonitor as the index is read, gpg to show a signature.
 */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(trustedGit(), ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-C', cwd, ...args], { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}
