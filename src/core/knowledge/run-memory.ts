// ─────────────────────────────────────────────
//  Cascade AI — What the run's workers have found, shared
// ─────────────────────────────────────────────
//
//  Workers running side by side used to find the same things out one by one:
//  one ran `git status` in a folder with no repository and learnt that, and
//  the next ran the same command in the same folder and paid to learn it
//  again. Peer messages reach the workers of one section only, and what a
//  worker learns reached the project's knowledge only after it finished.
//
//  RunMemory is one board for the whole run, every section's workers alike:
//
//  - Facts about the machine, read from commands that ran here and failed: a
//    folder that is not a git repository, a command the shell doesn't have.
//    Each worker is shown the ones it hasn't seen yet before its next model
//    call. Text that merely mentions such a failure (a log being read) is not
//    evidence and is ignored.
//  - Answers of commands that only read (a short list of commands and git
//    subcommands, every part of a compound command checked): the same command
//    in the same folder gives the earlier answer again instead of running,
//    until anything that isn't on that list runs. Then every stored answer is
//    dropped. Auto mode's "safe" rating is not used for this: it is about
//    whether to ask, and counts some writes (git config, git fetch) as safe.
//  - The facts are kept in the project's knowledge (entity "environment"), so
//    the next run starts knowing them, and one that stops being true (git
//    working in that folder, the command now running) is taken back out.
//
//  Only short facts in Cascade's own words are kept, never a tool's output,
//  and none while knowledge.factsExtraction is off. A local-only subtask
//  (privacy.paths) adds nothing and reads nothing, including one that became
//  local-only during the call being observed; what it changes still makes the
//  stored answers stale.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { statePath, STATE } from '../../config/project-state.js';
import { ownerState, ownerToken, STALE_LOCK_MS } from '../../utils/file-lock.js';
import { factMayLeave, type FactPrivacy, type WorldStateDB } from './world-state.js';

/** A fact for the board: `key` identifies it (one per thing it is about). */
export interface RunFact {
  key: string;
  text: string;
  from: string;
  /** Set when this tells a worker that something it was shown is no longer true. */
  retracted?: boolean;
}

interface Kept { relation: string; value: string }

const ENTITY = 'environment';
const MAX_FACTS = 60;
const MAX_RESULTS = 200;
const MAX_RESULT_CHARS = 20_000;
/** Files tracked per worker for "changed since you read it". */
const MAX_TRACKED_READS = 300;
/**
 * How long a stored answer is given again. Runs mark their own changes, and the
 * desktop editor marks its saves, but an edit made in another editor or a
 * terminal isn't seen at all: this bounds how long one can go unnoticed.
 */
export const MAX_ANSWER_AGE_MS = 60_000;

/** Tools that only read, whatever their input. */
const READ_TOOLS = new Set(['file_read', 'file_list', 'grep', 'glob', 'diff_view', 'code_search', 'graph_search']);

/** Commands whose answer depends only on the files, and that change nothing. */
const READ_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'tree', 'stat', 'file',
  'du', 'which', 'where', 'whereis', 'pwd', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'readlink',
  'cut', 'jq', 'diff', 'cmp', 'comm', 'find',
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'test-path', 'resolve-path', 'get-location',
]);
/**
 * git is never taken as a read, whatever the subcommand: what it runs depends on
 * the repository's configuration, and that can run programs on its own (a
 * core.fsmonitor hook to look at the working tree, diff.external and textconv
 * filters to show a diff, gpg.program to check a signature, and more). So no git
 * command is answered from the board, and each counts as a change. Facts are
 * still learnt from all of them (factsFrom).
 */
/**
 * Options that make an otherwise reading command write a file or run a program,
 * per command (one option means different things to different commands: `-o` is
 * an output file to `tree` and only-matching to `grep`). Matched against each
 * word as the program gets it, in either `--opt value` or `--opt=value` form.
 */
const COMMAND_WRITES: Readonly<Record<string, RegExp>> = {
  find: /^-(exec|execdir|delete|ok|okdir|fprint\S*|fls)$/,
  // --pre runs a program on every file searched; --hostname-bin runs one for hyperlinks.
  rg: /^--(pre|pre-glob|hostname-bin)(=|$)/,
  tree: /^(-o|--output)(=|$)/,
  // Compiles a magic file, written next to it.
  file: /^(-C|--compile)$/,
};
/** An output file, whichever command takes it. */
const ANY_WRITES = /^--output(=|$)/;
/** Whether a word given to `cmd` makes it write or run something. */
const writes = (cmd: string, word: string): boolean => ANY_WRITES.test(word) || (COMMAND_WRITES[cmd]?.test(word) ?? false);

/**
 * Whether a shell command only reads, every part of it: no substitution or
 * redirect, and each `&&`, `||`, `;` or `|` part a reading command (git only in
 * its reading forms). Strict on purpose: answering a command from memory when
 * it would have changed something is worse than running it twice.
 */
export function commandReadsOnly(command: string): boolean {
  // Nothing the shell expands into words this can't see: substitution, a
  // variable (`git diff $OPT` may be `--output=x`), braces, redirects.
  if (!command.trim() || /[`<>${}]/.test(command)) return false;
  // A lone `&` ends a command too (it runs it in the background): `echo ready & touch x` is two.
  const parts = command.split(/&&|\|\||;|\||&|\n/);
  return parts.every((part) => {
    // Words as the program gets them: the shell takes quotes and backslashes
    // away, so `'--output=x'` and `--out\put=x` are `--output=x` to git. A quote
    // splitting a word across spaces only joins it, and the options are found
    // all the same.
    const words = part.trim().split(/\s+/).map((w) => w.replace(/['"\\]/g, '')).filter(Boolean);
    if (!words.length) return false;
    const [head, ...rest] = words;
    const cmd = head!.toLowerCase();
    return READ_COMMANDS.has(cmd) && !rest.some((w) => writes(cmd, w));
  });
}

/** Whether a tool call only reads, judged as strictly as `commandReadsOnly`. */
export function callReadsOnly(tool: string, input: Record<string, unknown>): boolean {
  if (READ_TOOLS.has(tool)) return true;
  if (tool === 'shell') return commandReadsOnly(typeof input['command'] === 'string' ? input['command'] : '');
  return false;
}

/**
 * Whether git may have run somewhere other than the folder the call was given:
 * a `cd` (or the like) in the command, `git -C`, or a git directory or work tree
 * named outright. What git said is then about that other place and tells
 * nothing about this folder either way. Erring wide is safe: a fact not learnt
 * is only a command run again.
 */
function runsElsewhere(tool: string, input: Record<string, unknown>, command: string): boolean {
  if (tool === 'git') {
    const args = Array.isArray(input['args']) ? (input['args'] as unknown[]).map(String) : [];
    return args.some((a) => /^--(git-dir|work-tree)(=|$)/.test(a));
  }
  return /(^|[\s;&|(])(cd|pushd|popd|chdir|set-location|sl|push-location|pop-location)(?=$|[\s;&|)])/i.test(command)
    || /(^|\s)-C(\s|$)|--git-dir|--work-tree|(^|\s)GIT_(DIR|WORK_TREE)=/.test(command);
}

/** The command a call ran, when it ran one. */
function commandOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'shell') return typeof input['command'] === 'string' ? input['command'] : '';
  if (tool === 'git') return `git ${String(input['operation'] ?? '')} ${Array.isArray(input['args']) ? (input['args'] as unknown[]).join(' ') : ''}`;
  return '';
}

/**
 * The facts a command's answer shows about the machine. Only for a command that
 * ran here (shell or git): a file being read can say anything. A fact is learnt
 * only from a failure; `unlearnt` is what the answer shows to be no longer true.
 */
/** The git invocations in a call: each subcommand and the words after it. */
function gitInvocations(tool: string, input: Record<string, unknown>, command: string): Array<{ sub: string; args: string[] }> {
  if (tool === 'git') {
    const sub = typeof input['operation'] === 'string' ? input['operation'] : '';
    return sub ? [{ sub: sub.toLowerCase(), args: Array.isArray(input['args']) ? (input['args'] as unknown[]).map(String) : [] }] : [];
  }
  const out: Array<{ sub: string; args: string[] }> = [];
  for (const part of command.split(/&&|\|\||;|\||&|\n/)) {
    const words = part.trim().split(/\s+/).map((w) => w.replace(/['"\\]/g, '')).filter(Boolean);
    if (words[0]?.toLowerCase() !== 'git') continue;
    // The subcommand is the first word that isn't an option (`git --no-pager log`).
    const at = words.findIndex((w, i) => i > 0 && !w.startsWith('-'));
    if (at > 0) out.push({ sub: words[at]!.toLowerCase(), args: words.slice(at + 1) });
  }
  return out;
}

/** Subcommands that fail outside a repository: one working is evidence that this folder is one. */
const NEEDS_REPO = new Set([
  'status', 'log', 'show', 'rev-parse', 'branch', 'tag', 'ls-files', 'add', 'commit', 'checkout', 'switch',
  'restore', 'reset', 'stash', 'describe', 'blame', 'shortlog', 'cat-file', 'ls-tree', 'merge', 'rebase',
  'fetch', 'pull', 'push', 'remote', 'rm', 'mv', 'diff', 'grep',
]);

/**
 * Whether a git invocation that worked shows this folder is a repository: one
 * that needs a repository (not `--no-index`, which works anywhere), or `git init`
 * or `git clone … .` aimed at this folder itself. `git clone url child` made
 * `child` one, and `git --version` says nothing about any folder.
 */
function makesOrNeedsRepoHere({ sub, args }: { sub: string; args: string[] }): boolean {
  const targets = args.filter((a) => !a.startsWith('-'));
  if (sub === 'init') return targets.length === 0 || (targets.length === 1 && targets[0] === '.');
  if (sub === 'clone') return targets.at(-1) === '.';
  return NEEDS_REPO.has(sub) && !args.includes('--no-index');
}

/**
 * Whether a command may run with another program search path than the shell's
 * own: a `NAME=value` before a command, `env`, `export`, `set`/`setx`, `path`,
 * `source` or `.`, PowerShell's `$env:`, or a tool that activates an
 * environment. Erring wide: a fact not learnt only costs finding it out again.
 */
function changesSearchPath(command: string): boolean {
  // Looked for where a command starts, in each part: `jq . a.json` passes `.` as an argument.
  return command.split(/&&|\|\||;|\||&|\n|\(/).some((part) =>
    /^\s*([A-Za-z_][A-Za-z0-9_]*=|(env|export|set|setx|path|source|\.|conda|nvm|pyenv|rbenv|asdf|mise|direnv|nix-shell|poetry|pipenv|activate)(\s|$)|\$env:)/i.test(part));
}

/** How the project folder itself is named in facts. */
const ROOT_LABEL = 'The project folder';

/**
 * The relation a fact about a name (a folder, a command) is kept under, for the
 * name as it is spelt. The project's knowledge lowercases relations, and on a
 * filesystem or shell that tells `Docs` from `docs`, or `JQ` from `jq`, they are
 * two things: a name with capitals gets a short hash of its exact spelling, so
 * the two never share (or retract) a fact. The exact spelling is kept in the
 * fact's value (see keyedValue). An all-lowercase name keeps the plain form, as
 * facts kept before this have it.
 */
function keyedRelation(stem: string, name: string): string {
  const lower = name.toLowerCase();
  return lower === name ? `${stem}${name}` : `${stem}${lower} #${crypto.createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}
function keyedValue(fail: string, word: string, name: string): string {
  return name === name.toLowerCase() ? fail : `${fail} (${word} ${name})`;
}
/** The name a kept fact is about, exactly as spelt; null when it is not that failure. */
function keyedNameOf(stem: string, fail: string, word: string, relation: string, value: string): string | null {
  if (!relation.startsWith(stem)) return null;
  const m = /^(.+?)(?: #[0-9a-f]{8})?$/.exec(relation.slice(stem.length));
  const v = new RegExp(`^${fail}(?: \\(${word} (.+)\\))?$`, 'i').exec(value.trim());
  if (!m || !v) return null;
  const name = v[1] ?? m[1]!;
  // The spelling in the value must be the one the relation was made for.
  return keyedRelation(stem, name) === relation ? name : null;
}
const REPO = { stem: 'git repository at ', fail: 'none', word: 'at' } as const;
const COMMAND = { stem: 'command ', fail: 'not available', word: 'as' } as const;
const repoRelation = (folder: string): string => keyedRelation(REPO.stem, folder);
const repoValue = (folder: string): string => keyedValue(REPO.fail, REPO.word, folder);
const missingText = (name: string): string => `\`${name}\` is not available in this machine's shell: use another way (another command, or run_code).`;
const repoText = (folder: string): string => `${folder} is not a git repository: git commands there fail (run "git init" first if one is needed).`;

/** What a worker shown a fact is told once it stops being true. */
function retractionText(key: string): string {
  if (key.startsWith('git-repo:')) {
    const folder = key.slice('git-repo:'.length);
    return `${folder === 'the project folder' ? ROOT_LABEL : folder} is a git repository now: git commands work there.`;
  }
  return `\`${key.slice('missing:'.length)}\` runs in this machine's shell now: use it.`;
}

export function factsFrom(tool: string, input: Record<string, unknown>, output: string, cwdLabel: string, failed: boolean): { learnt: (RunFact & Kept)[]; unlearnt: string[] } {
  const learnt: (RunFact & Kept)[] = [];
  const unlearnt: string[] = [];
  const command = commandOf(tool, input);
  if (!command) return { learnt, unlearnt };
  const text = output.slice(0, 8000);
  // The folder exactly as spelt: `Docs` and `docs` may be two folders. The project
  // folder itself has a fixed name, as kept facts have it.
  const folder = cwdLabel === ROOT_LABEL ? 'the project folder' : cwdLabel;
  const repoKey = `git-repo:${folder}`;
  const gitRelated = (tool === 'git' || /(^|[\s;&|])git\s/.test(` ${command}`)) && !runsElsewhere(tool, input, command);
  if (gitRelated && failed && /not a git repository/i.test(text)) {
    learnt.push({ key: repoKey, text: repoText(cwdLabel), from: '', relation: repoRelation(folder), value: repoValue(folder) });
  } else if (gitRelated && !failed && !/not a git repository/i.test(text) && gitInvocations(tool, input, command).some(makesOrNeedsRepoHere)) {
    // A command that needs a repository worked there, or one was made there: it is one now.
    unlearnt.push(repoKey);
  }
  // A command that changes where the shell looks for programs (PATH=… cmd, env,
  // export, set, source, an activated environment) says nothing about what this
  // machine's shell has: `PATH=/nowhere ls` failing doesn't make `ls` missing.
  if (failed && !changesSearchPath(command)) {
    const words = new Set(command.toLowerCase().split(/[\s;&|()]+/).filter(Boolean));
    const missing = new Set<string>();
    for (const m of text.matchAll(/(?:^|\n)(?:[\w./-]+: )?(?:(?:line )?\d+: )?([\w.+-]{1,40}): (?:command )?not found/g)) missing.add(m[1]!);
    for (const m of text.matchAll(/'([\w.+-]{1,40})' is not recognized as an internal or external command/g)) missing.add(m[1]!);
    for (const m of text.matchAll(/The term '([\w.+-]{1,40})' is not recognized as (?:the )?name of a cmdlet/g)) missing.add(m[1]!);
    // Only a command this call asked for: an error it printed about something else is not about this machine's shell.
    for (const name of missing) {
      if (!words.has(name.toLowerCase())) continue;
      // As spelt: on a shell that tells `JQ` from `jq`, one failing says nothing of the other.
      learnt.push({ key: `missing:${name}`, text: missingText(name), from: '', relation: keyedRelation(COMMAND.stem, name), value: keyedValue(COMMAND.fail, COMMAND.word, name) });
    }
  }
  return { learnt, unlearnt };
}

/**
 * What the workspace has been through, as far as any run in it knows: every run's
 * board (in this process or another) changes the mark when a call that may change
 * the workspace starts and ends, and leaves an "active" note while it runs (or
 * while a fallback is held open). A stored answer is given again only while the
 * mark is the one it was got under and no run has a change under way, so a write
 * made by another run, in another window, makes this run's stored answers stale
 * as surely as its own.
 */
export interface ChangeMarker {
  /** The current mark. Two reads give the same mark only if nothing was marked between them. */
  current(): string;
  /** Mark a change. */
  bump(): void;
  /** A change under way, until the returned function is called. */
  enter(): () => void;
  /** Whether any run has a change under way. */
  busy(): boolean;
}

/** One per process, so marks and notes from two processes never coincide. */
const INSTANCE = crypto.randomBytes(6).toString('hex');
let marks = 0;

/**
 * The marker kept in the project's state folder, out of reach of tools: a `mark`
 * file holding only a random mark, and `active/`, one note per change under way,
 * holding only which process left it (file-lock.ts's owner token). A note left by
 * a process that has ended is cleared; one whose process can't be checked (another
 * host, no /proc) counts until it is STALE_LOCK_MS old. When any of it can't be
 * read or written, nothing is given again: a mark that can't be trusted never
 * matches, and the workspace counts as busy.
 */
export function workspaceChangeMarker(root: string): ChangeMarker {
  let dir: string | null = null;
  let broken = false;
  const where = (): string => (dir ??= statePath(root, STATE.boardChanges));
  const never = (): string => `unreadable:${INSTANCE}:${++marks}`;
  return {
    current() {
      if (broken) return never();
      try { return fs.readFileSync(path.join(where(), 'mark'), 'utf8'); } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? '' : never();
      }
    },
    bump() {
      try {
        const target = path.join(where(), 'mark');
        fs.mkdirSync(where(), { recursive: true });
        // Written whole, then renamed into place: a reader sees the old mark or the new one.
        const tmp = `${target}.${INSTANCE}.${++marks}`;
        fs.writeFileSync(tmp, `${INSTANCE}:${marks}:${Date.now()}`);
        fs.renameSync(tmp, target);
      } catch {
        broken = true;
      }
    },
    enter() {
      const note = path.join(where(), 'active', `${INSTANCE}.${++marks}`);
      try {
        fs.mkdirSync(path.dirname(note), { recursive: true });
        fs.writeFileSync(note, ownerToken(process.pid));
      } catch {
        broken = true;
      }
      let left = false;
      return () => {
        if (left) return;
        left = true;
        try { fs.rmSync(note, { force: true }); } catch { broken = true; }
      };
    },
    busy() {
      if (broken) return true;
      const active = path.join(where(), 'active');
      let names: string[];
      try { names = fs.readdirSync(active); } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      for (const name of names) {
        // This process's own notes are its own changes, under way.
        if (name.startsWith(`${INSTANCE}.`)) return true;
        const note = path.join(active, name);
        try {
          const state = ownerState(fs.readFileSync(note, 'utf8'));
          const stale = state === 'dead' || (state === 'unknown' && Date.now() - fs.statSync(note).mtimeMs > STALE_LOCK_MS);
          if (!stale) return true;
          fs.rmSync(note, { force: true });
        } catch (err) {
          // Gone meanwhile: that change has ended. Anything else: assume it hasn't.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return true;
        }
      }
      return false;
    },
  };
}

/**
 * For a host that writes to the workspace itself (the desktop app's editor
 * saving a file): every run's stored answers there are stale from now on. A
 * path outside the workspace changes nothing.
 */
export function noteWorkspaceChange(root: string, changed: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(changed));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  workspaceChangeMarker(root).bump();
}

/** What a file was when last looked at: equal snapshots mean it hasn't been written since. */
interface Snapshot { mtimeMs: number; ctimeMs: number; size: number; ino: number }
function snapshot(abs: string): Snapshot | null {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino } : null;
  } catch { return null; }
}
const sameSnapshot = (a: Snapshot | null, b: Snapshot | null): boolean =>
  !!a && !!b && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;

/** Whether `abs`, or a folder above it, holds a `.git`: git would find a repository there. */
function insideGitRepo(abs: string): boolean {
  let dir = path.resolve(abs);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** Whether a program of this name is on this process's search path (with Windows' extensions). */
function onSearchPath(name: string): boolean {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

/**
 * Commands whose answer is the content of the files named and nothing else, so it
 * stays right until one of those files changes (see readsOf).
 */
const FILE_READERS = new Set(['cat', 'type', 'head', 'tail', 'wc', 'stat', 'file', 'cmp', 'diff', 'get-content', 'gc']);
/** Options of head/tail that take a value as the next word. */
const VALUE_OPTIONS = /^(-n|-c|--lines|--bytes)$/;
/**
 * The short options taken, per command: only ones that change how the named
 * files are shown, not which files are read or what else is reported. Left out
 * on purpose, among others: `stat -f` (the whole filesystem's free blocks),
 * `tail -f` (follows), `file -f`/`-m` and `diff -X` (read other files named
 * inside), and anything that takes a value. Any other option, and every long
 * one but the value options above, means the command isn't taken.
 */
const SHORT_OPTIONS: Record<string, RegExp> = {
  cat: /^-[AbeEnstTuv]+$/,
  head: /^-(\d+|[qv]+)$/,
  tail: /^-(\d+|[qv]+)$/,
  wc: /^-[clmwL]+$/,
  stat: /^-[Lt]+$/,
  file: /^-[bhiLkNz]+$/,
  cmp: /^-[bls]+$/,
  diff: /^-[abBdEiNpqstTuwy]+$/,
};

/**
 * The files a read-only shell command reads, when its answer depends on them
 * alone: one command (no pipe or `&&`), a FILE_READERS command, and every other
 * word an option or an existing file (no folders, no globs). Null otherwise:
 * `ls`, `rg`, `find` and the like depend on what is in a folder, not on files
 * that can be named, and keep the coarser rule.
 */
export function readsOf(command: string, cwd: string): string[] | null {
  if (/&&|\|\||;|\||&|\n|[*?[\]]/.test(command)) return null;
  // Quoting, escapes, expansions and redirects change which words the shell
  // sees; rather than track the wrong files, none of these are taken. (A
  // backslash is Windows' path separator there, not an escape.)
  if (/['"`$~<>(){}]/.test(command) || (process.platform !== 'win32' && command.includes('\\'))) return null;
  const words = command.trim().split(/\s+/).filter(Boolean);
  const cmd = words[0]?.toLowerCase();
  if (!cmd || !FILE_READERS.has(cmd)) return null;
  const files: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith('-')) {
      // PowerShell parameters take values in ways not worth guessing at; `-` alone reads stdin.
      if (cmd === 'get-content' || cmd === 'gc' || w === '-') return null;
      const counts = cmd === 'head' || cmd === 'tail';
      // Only head and tail take a count as the next word: `wc -c a b` reads both.
      if (counts && VALUE_OPTIONS.test(w)) { i++; continue; }
      if (w.startsWith('--')) {
        if (counts && /^--(lines|bytes)=/.test(w)) continue;
        return null;
      }
      if (!SHORT_OPTIONS[cmd]?.test(w)) return null;
      continue;
    }
    const abs = path.resolve(cwd, w);
    if (!snapshot(abs)) return null;
    files.push(abs);
  }
  return files.length ? files : null;
}

/** What `observe` needs to know about how the call went. */
export interface Observed {
  /** The call failed: it threw, or the command exited non-zero. */
  failed: boolean;
  /**
   * Whether its answer may go on the board. False for a local-only subtask,
   * judged after the call, since a read during it can make the subtask local-only.
   */
  publish: boolean;
}

export class RunMemory {
  /** `sources`: what a fact kept by an earlier run was drawn from, checked again each time it is shown. */
  private facts = new Map<string, RunFact & { relation?: string; sources?: string[] | null }>();
  private seen = new Map<string, Set<string>>();
  /** Per worker: facts it was shown that have since stopped being true, to tell it. */
  private retractions = new Map<string, RunFact[]>();
  /**
   * Stored answers. One with `reads` depends on those files alone and stays right
   * until one of them changes, whatever else runs; any other is kept only while
   * nothing at all changes (epoch, mark, MAX_ANSWER_AGE_MS).
   */
  private results = new Map<string, { output: string; by: string; epoch: number; mark: string; at: number; reads?: Array<[string, Snapshot]> }>();
  /** Calls begun and not yet observed: the epoch and workspace mark each started at, and the files a read reads. */
  private started = new Map<number, { epoch: number; mark: string; leave?: () => void; reads?: Array<[string, Snapshot | null]> }>();
  /** Per worker: the files it has read into its prompt, as they were when it last read them or was told of a change. */
  private readsBy = new Map<string, Map<string, Snapshot>>();
  /**
   * Per fact: whether the cheap check (stillTrue) is trusted to drop it. One found
   * in this run is checked only if the check agreed with it then; where it
   * disagreed from the start (the shell's search path differs from this
   * process's, git stops at a filesystem boundary) it can't tell, and the fact
   * stands until a command shows otherwise. One kept by an earlier run is always
   * checked (see the constructor).
   */
  private checkable = new Map<string, boolean>();
  private checkedAt = 0;
  private nextTicket = 1;
  /** Bumped by every call that may change anything: a stored answer from before it is stale. */
  private epoch = 0;
  /** Calls that may change things, still running. */
  private changing = 0;

  /**
   * @param keep Whether facts may be written to the project's knowledge now. Asked
   *   at each write, so a setting changed mid-run (knowledge.factsExtraction) holds
   *   from then on; the board itself still works for the run.
   */
  constructor(
    private readonly root: string,
    private readonly db?: WorldStateDB,
    private readonly keep: () => boolean = () => true,
    /** The project's privacy.paths rules: what the board shows goes to cloud models. */
    private readonly privacy: () => FactPrivacy | undefined = () => undefined,
    /** Changes seen by every run in this workspace (see ChangeMarker). */
    private readonly changes: ChangeMarker = workspaceChangeMarker(root),
  ) {
    // Start knowing what earlier runs found: only what may go to any model. The
    // entity is the project's general knowledge, not only what this board wrote,
    // so each fact passes the same gate as T1's plan and graph_search
    // (factMayLeave), and one about a folder that is local-only now is left out.
    const rules = privacy();
    let kept: ReturnType<WorldStateDB['getFactsForEntities']> = [];
    try { kept = db?.getFactsForEntities([ENTITY]) ?? []; } catch { /* starts empty */ }
    for (const f of kept) {
      // Only the failure each relation records: the entity is general knowledge, and
      // a fact extracted or imported there may say the opposite ("command jq:
      // available"), which must not reach workers as something missing.
      const folder = keyedNameOf(REPO.stem, REPO.fail, REPO.word, f.relation, f.value);
      const command = folder === null ? keyedNameOf(COMMAND.stem, COMMAND.fail, COMMAND.word, f.relation, f.value) : null;
      const key = folder !== null ? `git-repo:${folder}` : command !== null ? `missing:${command}` : '';
      if (!key) continue;
      if (!factMayLeave(f, rules, root)) continue;
      if (key.startsWith('git-repo:') && this.folderPrivate(key.slice('git-repo:'.length), rules)) continue;
      const text = folder !== null ? repoText(folder) : missingText(command!);
      this.facts.set(key, { key, text, from: 'an earlier run', relation: f.relation, sources: f.sources ?? null });
      // Checked whatever the check says now: what it said when the fact was found
      // isn't kept, and a fact that tells workers to stop using a command is never
      // disproved by them. Where the shell sees things differently, the cost is one
      // failed call in this run to find it again.
      this.checkable.set(key, true);
    }
    // One that no longer holds (you installed it, or ran git init, since) is dropped now.
    this.checkFacts(true);
  }

  /** The cheap check of a fact against this machine: still true? */
  private stillTrue(key: string): boolean {
    if (key.startsWith('git-repo:')) {
      const folder = key.slice('git-repo:'.length);
      return !insideGitRepo(path.resolve(this.root, folder === 'the project folder' ? '.' : folder));
    }
    if (key.startsWith('missing:')) return !onSearchPath(key.slice('missing:'.length));
    return true;
  }

  /**
   * Drop the facts this machine no longer bears out: a repository made since, a
   * command installed since (by you, another run, or a worker by a way the board
   * didn't see). Workers already told get the correction. At most every 2s.
   */
  private checkFacts(now = false): void {
    if (!now && Date.now() - this.checkedAt < 2_000) return;
    this.checkedAt = Date.now();
    for (const key of [...this.facts.keys()]) {
      if (this.checkable.get(key) && !this.stillTrue(key)) this.forget(key);
    }
  }

  private cwd(input: Record<string, unknown>): string {
    const raw = typeof input['cwd'] === 'string' && input['cwd'] ? input['cwd'] : '.';
    return path.resolve(this.root, raw);
  }

  /**
   * Whether the folder a fact names (relative to the project, or the project
   * folder itself) is local-only: its name then stays off the board, which
   * every worker reads, whatever model it runs on.
   */
  private folderPrivate(rel: string, rules = this.privacy()): boolean {
    if (!rules?.hasPolicies()) return false;
    const name = rel === 'the project folder' ? '.' : rel;
    if (name === '.') return rules.isLocalOnly('.');
    return rules.isLocalOnly(name) || rules.coversFile(path.resolve(this.root, name), this.root);
  }

  private label(abs: string): string {
    const rel = path.relative(this.root, abs);
    return rel ? rel.split(path.sep).join('/') : ROOT_LABEL;
  }

  /** The key a stored answer is kept under, for a command that may be given again; else null. */
  private reusable(tool: string, input: Record<string, unknown>): string | null {
    if (tool !== 'shell' && tool !== 'git') return null;
    if (!callReadsOnly(tool, input)) return null;
    return `${tool}\u0000${this.cwd(input)}\u0000${JSON.stringify(input)}`;
  }

  /**
   * The answer this read-only call gave earlier in the run, when nothing has
   * changed since: the call needn't run again. Null otherwise.
   */
  reuse(tool: string, input: Record<string, unknown>, to?: string): { output: string; by: string } | null {
    const key = this.reusable(tool, input);
    const hit = key ? this.results.get(key) : undefined;
    if (!hit || this.changing !== 0 || this.changes.busy()) return null;
    // Depends on named files: right as long as they are as they were, however long
    // ago and whatever else has run (an edit outside Cascade changes them too).
    if (hit.reads) {
      if (!hit.reads.every(([abs, was]) => sameSnapshot(was, snapshot(abs)))) return null;
      // The worker given it now holds those files as they were: told if they change.
      if (to) for (const [abs, was] of hit.reads) this.noteRead(to, abs, was);
      return { output: hit.output, by: hit.by };
    }
    return hit.epoch === this.epoch && Date.now() - hit.at <= MAX_ANSWER_AGE_MS && hit.mark === this.changes.current()
      ? { output: hit.output, by: hit.by } : null;
  }

  /**
   * Called as a call starts. A call that may change things is counted while it
   * runs: no stored answer is given meanwhile, as it may already be out of date.
   * Returns a ticket for `observe`: what the board and the workspace were when it started.
   */
  begin(tool: string, input: Record<string, unknown>): number {
    let leave: (() => void) | undefined;
    if (!callReadsOnly(tool, input)) { this.changing += 1; leave = this.changes.enter(); this.changes.bump(); }
    const ticket = this.nextTicket++;
    const files = tool === 'shell' && this.reusable(tool, input) ? readsOf(String(input['command'] ?? ''), this.cwd(input)) : null;
    this.started.set(ticket, { epoch: this.epoch, mark: this.changes.current(), leave, ...(files ? { reads: files.map((f) => [f, snapshot(f)] as [string, Snapshot | null]) } : {}) });
    return ticket;
  }

  /**
   * How a call went (its answer, or the error it failed with). Always ends what
   * `begin` started; its facts and answer go on the board only if `publish`.
   */
  observe(tool: string, input: Record<string, unknown>, output: string, by: string, ticket: number, how: Observed): void {
    const started = this.started.get(ticket);
    this.started.delete(ticket);
    // Something that may change things, and finished (or failed part way): anything
    // stored before it is stale, here and in every other run in this workspace.
    if (!callReadsOnly(tool, input)) { this.epoch += 1; this.changing = Math.max(0, this.changing - 1); this.changes.bump(); started?.leave?.(); }
    // The files a read read are files this worker now has in its prompt, as they
    // were when it started (a change while it ran is one it didn't see). Before
    // the gate below: a local-only worker is told of changes too, though what it
    // found and got stays off the board.
    for (const [abs, was] of started?.reads ?? []) this.noteRead(by, abs, was ?? undefined);
    if (!how.publish) return;
    const where = this.cwd(input);
    const { learnt, unlearnt } = factsFrom(tool, input, output, this.label(where), how.failed);
    for (const key of unlearnt) this.forget(key);
    // A command that ran is no longer missing.
    const ran = commandOf(tool, input).trim().split(/\s+/)[0];
    if (ran && !how.failed) this.forget(`missing:${ran}`);
    for (const f of learnt) {
      if (f.key.startsWith('git-repo:') && this.folderPrivate(path.relative(this.root, where).split(path.sep).join('/') || 'the project folder')) continue;
      if (this.facts.size >= MAX_FACTS && !this.facts.has(f.key)) break;
      const isNew = !this.facts.has(f.key);
      this.facts.set(f.key, { key: f.key, text: f.text, from: by, relation: f.relation });
      this.checkable.set(f.key, this.stillTrue(f.key));
      // Who found it has seen it.
      this.seenBy(by).add(f.key);
      if (isNew && this.keep()) this.persist(() => this.db?.upsertFact(ENTITY, f.relation, f.value, `run:${by}`, undefined, []));
    }
    const key = this.reusable(tool, input);
    if (!key || how.failed || !started || this.changes.busy() || output.length > MAX_RESULT_CHARS) return;
    let stored: { output: string; by: string; epoch: number; mark: string; at: number; reads?: Array<[string, Snapshot]> } | null = null;
    if (started.reads) {
      // Kept only if its files didn't change while it ran.
      const now = started.reads.map(([abs, was]) => [abs, snapshot(abs), was] as const);
      if (now.every(([, cur, was]) => sameSnapshot(was, cur))) {
        stored = { output, by, epoch: this.epoch, mark: started.mark, at: Date.now(), reads: now.map(([abs, cur]) => [abs, cur!]) };
      }
    } else if (started.epoch === this.epoch && started.mark === this.changes.current()) {
      // Kept only if nothing changed while it ran, by this run or any other.
      stored = { output, by, epoch: this.epoch, mark: started.mark, at: Date.now() };
    }
    if (stored) {
      if (this.results.size >= MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
      this.results.set(key, stored);
    }
  }

  /**
   * Work that may change things and that the board sees no call for (after a
   * failure, the fallback that runs another tool in its place): no stored answer
   * is given while it runs, and none from before it afterwards. Call the
   * returned function once it is over.
   */
  hold(): () => void {
    this.changing += 1;
    // Under way for every run in the workspace, not only this one: another run must
    // not answer from memory while this fallback may be writing.
    const leave = this.changes.enter();
    this.changes.bump();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.epoch += 1;
      this.changing = Math.max(0, this.changing - 1);
      this.changes.bump();
      leave();
    };
  }

  /**
   * A write to the project's knowledge, best-effort: the board is for this run
   * first, and a store that can't be written (read-only, locked) must not turn a
   * command that succeeded into a failed tool call.
   */
  private persist(write: () => void): void {
    try { write(); } catch { /* kept for this run only */ }
  }

  private forget(key: string): void {
    const fact = this.facts.get(key);
    if (!fact) return;
    this.facts.delete(key);
    this.checkable.delete(key);
    // A worker that was shown it is working from it: told it no longer holds,
    // before its next model call, and shown it afresh should it come back.
    for (const [worker, seen] of this.seen) {
      if (!seen.delete(key)) continue;
      let queued = this.retractions.get(worker);
      if (!queued) { queued = []; this.retractions.set(worker, queued); }
      queued.push({ key: `retracted:${key}`, text: retractionText(key), from: '', retracted: true });
    }
    if (fact.relation && this.keep()) this.persist(() => this.db?.deleteFact(ENTITY, fact.relation!));
  }

  private seenBy(worker: string): Set<string> {
    let s = this.seen.get(worker);
    if (!s) { s = new Set(); this.seen.set(worker, s); }
    return s;
  }

  /**
   * What `worker` hasn't been shown yet, now marked shown: facts found since, and
   * facts it was shown that have stopped being true.
   */
  unseenBy(worker: string): RunFact[] {
    this.checkFacts();
    const seen = this.seenBy(worker);
    // The privacy rules as they are now, not as they were when the board began: a
    // file a local-only subtask has written since is local-only now, and so is a
    // fact drawn from it, or about a folder that has become local-only. One held
    // back now is not marked shown, and is shown should the rules loosen.
    const rules = this.privacy();
    const out = [...this.facts.values()].filter((f) => !seen.has(f.key) && this.mayShow(f, rules));
    for (const f of out) seen.add(f.key);
    const retracted = this.retractions.get(worker) ?? [];
    this.retractions.delete(worker);
    return [...retracted, ...out.map(({ key, text, from }) => ({ key, text, from }))];
  }

  /** Whether a fact may go to any model now (see unseenBy). */
  private mayShow(f: RunFact & { sources?: string[] | null }, rules: FactPrivacy | undefined): boolean {
    if ('sources' in f && !factMayLeave({ sources: f.sources } as Parameters<typeof factMayLeave>[0], rules, this.root)) return false;
    return !(f.key.startsWith('git-repo:') && this.folderPrivate(f.key.slice('git-repo:'.length), rules));
  }

  /**
   * The facts as they stand, for the planners (T1, T2): checked against this
   * machine and the privacy rules now, marking nothing shown.
   */
  known(): RunFact[] {
    this.checkFacts();
    const rules = this.privacy();
    return [...this.facts.values()].filter((f) => this.mayShow(f, rules)).map(({ key, text, from }) => ({ key, text, from }));
  }

  /**
   * `worker` has read this file into its prompt: it is told if the file changes.
   * `as` is the file as it was read, when that was earlier than now.
   */
  noteRead(worker: string, abs: string, as?: Snapshot): void {
    const snap = as ?? snapshot(abs);
    if (!snap) return;
    let reads = this.readsBy.get(worker);
    if (!reads) { reads = new Map(); this.readsBy.set(worker, reads); }
    reads.delete(abs);
    reads.set(abs, snap);
    // The most recent MAX_TRACKED_READS: one read long ago is likely gone from its context too.
    if (reads.size > MAX_TRACKED_READS) reads.delete(reads.keys().next().value!);
  }

  /** `worker` wrote this file itself (file_write, file_edit): no news to it. */
  noteWritten(worker: string, abs: string): void {
    const reads = this.readsBy.get(worker);
    if (!reads?.has(abs)) return;
    const snap = snapshot(abs);
    if (snap) reads.set(abs, snap);
    else reads.delete(abs);
  }

  /**
   * The files `worker` read that have changed since (or are gone), by anyone: another
   * worker, another run, the desktop editor, or an edit outside Cascade. Each change
   * is told once. Paths are relative to the project; a file under privacy.paths is
   * left out unless `privately` (a local-only worker, on a private model).
   */
  changedFor(worker: string, privately = false): Array<{ path: string; gone: boolean }> {
    const reads = this.readsBy.get(worker);
    if (!reads?.size) return [];
    const rules = privately ? undefined : this.privacy();
    const out: Array<{ path: string; gone: boolean }> = [];
    for (const [abs, was] of [...reads]) {
      const now = snapshot(abs);
      if (sameSnapshot(was, now)) continue;
      if (now) reads.set(abs, now); else reads.delete(abs);
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      if (rules?.hasPolicies() && rules.coversFile(abs, this.root)) continue;
      out.push({ path: rel || abs, gone: !now });
    }
    return out;
  }

  /** Every fact on the board (for tests and readouts). */
  all(): RunFact[] {
    return [...this.facts.values()].map(({ key, text, from }) => ({ key, text, from }));
  }
}

/** How a worker is told that files it read have changed, before its next model call. */
export function formatChangedFiles(files: Array<{ path: string; gone: boolean }>): string {
  return `FILES CHANGED SINCE YOU READ THEM (by another worker, a command, or an edit outside Cascade). What you read of these is out of date: read them again before relying on them or editing them:\n${files.map((f) => `- ${f.path}${f.gone ? ' (deleted)' : ''}`).join('\n')}`;
}

/** How a planner (T1, T2) is told what workers found, so it doesn't plan around it. */
export function formatPlannerFacts(facts: RunFact[]): string {
  return `KNOWN ABOUT THIS MACHINE (found by workers in this or earlier runs of this project): plan with these in mind, and pass any that matter on to the workers:\n${facts.map((f) => `- ${f.text}`).join('\n')}`;
}

/** How a worker is told what the others found, before its next model call. */
export function formatRunFacts(facts: RunFact[]): string {
  const known = facts.filter((f) => !f.retracted);
  const gone = facts.filter((f) => f.retracted);
  const parts: string[] = [];
  if (gone.length) parts.push(`NO LONGER TRUE (changed since you were told, by another worker): this replaces what you were told before:\n${gone.map((f) => `- ${f.text}`).join('\n')}`);
  if (known.length) parts.push(`ALREADY FOUND IN THIS RUN (by other workers, or earlier runs in this project). Take these as known; don't spend calls finding them out again:\n${known.map((f) => `- ${f.text}`).join('\n')}`);
  return parts.join('\n\n');
}
