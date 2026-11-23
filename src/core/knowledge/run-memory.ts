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
  if (failed) {
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
  private results = new Map<string, { output: string; by: string; epoch: number; mark: string; at: number }>();
  /** Calls begun and not yet observed: the epoch and workspace mark each started at. */
  private started = new Map<number, { epoch: number; mark: string; leave?: () => void }>();
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
  reuse(tool: string, input: Record<string, unknown>): { output: string; by: string } | null {
    const key = this.reusable(tool, input);
    const hit = key ? this.results.get(key) : undefined;
    return hit && hit.epoch === this.epoch && this.changing === 0 && Date.now() - hit.at <= MAX_ANSWER_AGE_MS
      && hit.mark === this.changes.current() && !this.changes.busy() ? { output: hit.output, by: hit.by } : null;
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
    this.started.set(ticket, { epoch: this.epoch, mark: this.changes.current(), leave });
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
      // Who found it has seen it.
      this.seenBy(by).add(f.key);
      if (isNew && this.keep()) this.persist(() => this.db?.upsertFact(ENTITY, f.relation, f.value, `run:${by}`, undefined, []));
    }
    const key = this.reusable(tool, input);
    // Kept only if nothing changed while it ran, by this run or any other.
    if (key && !how.failed && started && started.epoch === this.epoch && started.mark === this.changes.current() && !this.changes.busy() && output.length <= MAX_RESULT_CHARS) {
      if (this.results.size >= MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
      this.results.set(key, { output, by, epoch: this.epoch, mark: started.mark, at: Date.now() });
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

  /** Every fact on the board (for tests and readouts). */
  all(): RunFact[] {
    return [...this.facts.values()].map(({ key, text, from }) => ({ key, text, from }));
  }
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
