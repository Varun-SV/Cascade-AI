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
import { factMayLeave, type FactPrivacy, type WorldStateDB } from './world-state.js';

/** A fact for the board: `key` identifies it (one per thing it is about). */
export interface RunFact { key: string; text: string; from: string }

interface Kept { relation: string; value: string }

const ENTITY = 'environment';
const MAX_FACTS = 60;
const MAX_RESULTS = 200;
const MAX_RESULT_CHARS = 20_000;

/** Tools that only read, whatever their input. */
const READ_TOOLS = new Set(['file_read', 'file_list', 'grep', 'glob', 'diff_view', 'code_search', 'graph_search']);

/** Commands whose answer depends only on the files, and that change nothing. */
const READ_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'tree', 'stat', 'file',
  'du', 'which', 'where', 'whereis', 'pwd', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'readlink',
  'cut', 'jq', 'diff', 'cmp', 'comm', 'find',
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'test-path', 'resolve-path', 'get-location',
]);
/** git subcommands that only read; a few only in their listing form. */
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'describe', 'blame', 'shortlog', 'cat-file', 'ls-tree']);
const GIT_LISTS = new Set(['branch', 'tag', 'remote']);
/**
 * Options that make an otherwise reading command write or run something: find's
 * actions, an output file, and ripgrep's `--pre`, which runs a program on every
 * file it searches.
 */
const WRITES = /(^|\s)(-exec|-execdir|-delete|-ok|-fprint\S*|-fls|--output\S*|-o|--pre|--pre-glob)(\s|=|$)/;

/** Subcommands whose output is a diff by default: git runs configured helpers for it. */
const GIT_DIFFS = new Set(['diff', 'show', 'blame']);
const GIT_PATCH_OPTIONS = /^(-p|-u|--patch|-U\d*|--unified(=.*)?|--patch-with-stat|--cc|-c)$/;

/**
 * Whether `args` (after a git subcommand) leave it reading only.
 *
 * A diff git shows may run programs the repository configures: `diff.external`
 * (which `git diff` uses unless told not to) and textconv filters. They can do
 * anything, so a command that may run them is not taken as a read unless it
 * turns both off (`--no-ext-diff --no-textconv`), and one that asks for them is
 * never taken as one.
 */
function gitReads(sub: string, args: string[]): boolean {
  const s = sub.toLowerCase();
  if (args.some((a) => /^--(ext-diff|textconv|filters)$/.test(a))) return false;
  const showsDiff = GIT_DIFFS.has(s) || (s === 'log' && args.some((a) => GIT_PATCH_OPTIONS.test(a)));
  if (showsDiff && !(args.includes('--no-ext-diff') && args.includes('--no-textconv'))) return false;
  if (GIT_READS.has(s)) return !args.some((a) => /^--output/.test(a));
  if (!GIT_LISTS.has(s)) return false;
  // `git branch`, `git tag -l`, `git remote -v`: listing. Any other word names one to make or change.
  return args.every((a) => /^(-a|-r|-v|-l|--list|--all|--remotes|--verbose|--show-current|-vv)$/.test(a));
}

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
    if (cmd === 'git') return rest.length > 0 && !rest[0]!.startsWith('-') && gitReads(rest[0]!, rest.slice(1));
    return READ_COMMANDS.has(cmd) && !WRITES.test(` ${rest.join(' ')} `);
  });
}

/** Whether a tool call only reads, judged as strictly as `commandReadsOnly`. */
export function callReadsOnly(tool: string, input: Record<string, unknown>): boolean {
  if (READ_TOOLS.has(tool)) return true;
  if (tool === 'shell') return commandReadsOnly(typeof input['command'] === 'string' ? input['command'] : '');
  if (tool === 'git') {
    const op = typeof input['operation'] === 'string' ? input['operation'] : '';
    const args = Array.isArray(input['args']) ? (input['args'] as unknown[]).map(String) : [];
    return !!op && gitReads(op, args);
  }
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
/** How the project folder itself is named in facts. */
const ROOT_LABEL = 'The project folder';

/**
 * The relation a "not a git repository" fact is kept under, for a folder as it
 * is spelt. The project's knowledge lowercases relations, and on a filesystem
 * that tells `Docs` from `docs` they are two folders: a name with capitals gets a
 * short hash of its exact spelling, so the two never share (or retract) a fact.
 * The exact spelling is kept in the fact's value (see repoValue). An all-lowercase
 * name keeps the plain form, as facts kept before this have it.
 */
function repoRelation(folder: string): string {
  const lower = folder.toLowerCase();
  return lower === folder ? `git repository at ${folder}` : `git repository at ${lower} #${crypto.createHash('sha256').update(folder).digest('hex').slice(0, 8)}`;
}
function repoValue(folder: string): string {
  return folder === folder.toLowerCase() ? 'none' : `none (at ${folder})`;
}
/** The folder a kept "not a git repository" fact is about, exactly as spelt; null when it is not one. */
function repoFolderOf(relation: string, value: string): string | null {
  const m = /^git repository at (.+?)(?: #([0-9a-f]{8}))?$/.exec(relation);
  const v = /^none(?: \(at (.+)\))?$/i.exec(value.trim());
  if (!m || !v) return null;
  const folder = v[1] ?? m[1]!;
  // The spelling in the value must be the one the relation was made for.
  return repoRelation(folder) === relation ? folder : null;
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
    learnt.push({ key: repoKey, text: `${cwdLabel} is not a git repository: git commands there fail (run "git init" first if one is needed).`, from: '', relation: repoRelation(folder), value: repoValue(folder) });
  } else if (gitRelated && !/not a git repository/i.test(text) && (!failed || /\bgit\s+(init|clone)\b/.test(command))) {
    // git worked there (or a repository was just made): it is one now.
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
      learnt.push({ key: `missing:${name.toLowerCase()}`, text: `\`${name}\` is not available in this machine's shell: use another way (another command, or run_code).`, from: '', relation: `command ${name.toLowerCase()}`, value: 'not available' });
    }
  }
  return { learnt, unlearnt };
}

/**
 * What the workspace has been through, as far as any run in it knows: every run's
 * board (in this process or another) changes it when a call that may change the
 * workspace starts and ends. A stored answer is given again only while it is the
 * same as when that answer was got, so a write made by another run, in another
 * window, makes this run's stored answers stale as surely as its own.
 */
export interface ChangeMarker {
  /** The current mark. Two reads give the same mark only if nothing was marked between them. */
  current(): string;
  /** Mark a change. */
  bump(): void;
}

/** One per process, so marks from two processes never coincide. */
const INSTANCE = crypto.randomBytes(6).toString('hex');
let marks = 0;

/**
 * The marker kept in the project's state folder, out of reach of tools. It holds
 * only a random mark. When it can't be read or written, nothing is given again:
 * a mark that can't be trusted never matches.
 */
export function workspaceChangeMarker(root: string): ChangeMarker {
  let file: string | null = null;
  let broken = false;
  const where = (): string => (file ??= statePath(root, STATE.boardChanges));
  const never = (): string => `unreadable:${INSTANCE}:${++marks}`;
  return {
    current() {
      if (broken) return never();
      try { return fs.readFileSync(where(), 'utf8'); } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? '' : never();
      }
    },
    bump() {
      try {
        const target = where();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Written whole, then renamed into place: a reader sees the old mark or the new one.
        const tmp = `${target}.${INSTANCE}.${++marks}`;
        fs.writeFileSync(tmp, `${INSTANCE}:${marks}:${Date.now()}`);
        fs.renameSync(tmp, target);
      } catch {
        broken = true;
      }
    },
  };
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
  private facts = new Map<string, RunFact & { relation?: string }>();
  private seen = new Map<string, Set<string>>();
  private results = new Map<string, { output: string; by: string; epoch: number; mark: string }>();
  /** Calls begun and not yet observed: the epoch and workspace mark each started at. */
  private started = new Map<number, { epoch: number; mark: string }>();
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
    for (const f of db?.getFactsForEntities([ENTITY]) ?? []) {
      // Only the failure each relation records: the entity is general knowledge, and
      // a fact extracted or imported there may say the opposite ("command jq:
      // available"), which must not reach workers as something missing.
      const folder = f.relation.startsWith('git repository at ') ? repoFolderOf(f.relation, f.value) : null;
      const key = folder !== null ? `git-repo:${folder}`
        : f.relation.startsWith('command ') && f.value.trim().toLowerCase() === 'not available' ? `missing:${f.relation.slice('command '.length)}` : '';
      if (!key) continue;
      if (!factMayLeave(f, rules, root)) continue;
      if (key.startsWith('git-repo:') && this.folderPrivate(key.slice('git-repo:'.length), rules)) continue;
      const text = key.startsWith('git-repo:')
        ? `${key.slice('git-repo:'.length)} is not a git repository: git commands there fail (run "git init" first if one is needed).`
        : `\`${key.slice('missing:'.length)}\` is not available in this machine's shell: use another way (another command, or run_code).`;
      this.facts.set(key, { key, text, from: 'an earlier run', relation: f.relation });
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
    return hit && hit.epoch === this.epoch && this.changing === 0 && hit.mark === this.changes.current() ? { output: hit.output, by: hit.by } : null;
  }

  /**
   * Called as a call starts. A call that may change things is counted while it
   * runs: no stored answer is given meanwhile, as it may already be out of date.
   * Returns a ticket for `observe`: what the board and the workspace were when it started.
   */
  begin(tool: string, input: Record<string, unknown>): number {
    if (!callReadsOnly(tool, input)) { this.changing += 1; this.changes.bump(); }
    const ticket = this.nextTicket++;
    this.started.set(ticket, { epoch: this.epoch, mark: this.changes.current() });
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
    if (!callReadsOnly(tool, input)) { this.epoch += 1; this.changing = Math.max(0, this.changing - 1); this.changes.bump(); }
    if (!how.publish) return;
    const where = this.cwd(input);
    const { learnt, unlearnt } = factsFrom(tool, input, output, this.label(where), how.failed);
    for (const key of unlearnt) this.forget(key);
    // A command that ran is no longer missing.
    const ran = commandOf(tool, input).trim().split(/\s+/)[0]?.toLowerCase();
    if (ran && !how.failed) this.forget(`missing:${ran}`);
    for (const f of learnt) {
      if (f.key.startsWith('git-repo:') && this.folderPrivate(path.relative(this.root, where).split(path.sep).join('/') || 'the project folder')) continue;
      if (this.facts.size >= MAX_FACTS && !this.facts.has(f.key)) break;
      const isNew = !this.facts.has(f.key);
      this.facts.set(f.key, { key: f.key, text: f.text, from: by, relation: f.relation });
      // Who found it has seen it.
      this.seenBy(by).add(f.key);
      if (isNew && this.keep()) this.db?.upsertFact(ENTITY, f.relation, f.value, `run:${by}`, undefined, []);
    }
    const key = this.reusable(tool, input);
    // Kept only if nothing changed while it ran, by this run or any other.
    if (key && !how.failed && started && started.epoch === this.epoch && started.mark === this.changes.current() && output.length <= MAX_RESULT_CHARS) {
      if (this.results.size >= MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
      this.results.set(key, { output, by, epoch: this.epoch, mark: started.mark });
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
    this.changes.bump();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.epoch += 1;
      this.changing = Math.max(0, this.changing - 1);
      this.changes.bump();
    };
  }

  private forget(key: string): void {
    const fact = this.facts.get(key);
    if (!fact) return;
    this.facts.delete(key);
    if (fact.relation && this.keep()) this.db?.deleteFact(ENTITY, fact.relation);
  }

  private seenBy(worker: string): Set<string> {
    let s = this.seen.get(worker);
    if (!s) { s = new Set(); this.seen.set(worker, s); }
    return s;
  }

  /** The facts `worker` hasn't been shown yet, now marked shown. */
  unseenBy(worker: string): RunFact[] {
    const seen = this.seenBy(worker);
    const out = [...this.facts.values()].filter((f) => !seen.has(f.key));
    for (const f of out) seen.add(f.key);
    return out.map(({ key, text, from }) => ({ key, text, from }));
  }

  /** Every fact on the board (for tests and readouts). */
  all(): RunFact[] {
    return [...this.facts.values()].map(({ key, text, from }) => ({ key, text, from }));
  }
}

/** How a worker is told what the others found, before its next model call. */
export function formatRunFacts(facts: RunFact[]): string {
  return `ALREADY FOUND IN THIS RUN (by other workers, or earlier runs in this project). Take these as known; don't spend calls finding them out again:\n${facts.map((f) => `- ${f.text}`).join('\n')}`;
}
