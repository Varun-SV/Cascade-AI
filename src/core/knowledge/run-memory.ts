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

import path from 'node:path';
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

/** Whether `args` (after a git subcommand) leave it reading only. */
function gitReads(sub: string, args: string[]): boolean {
  const s = sub.toLowerCase();
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
  if (!command.trim() || /[`<>]|\$\(/.test(command)) return false;
  // A lone `&` ends a command too (it runs it in the background): `echo ready & touch x` is two.
  const parts = command.split(/&&|\|\||;|\||&|\n/);
  return parts.every((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean);
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
export function factsFrom(tool: string, input: Record<string, unknown>, output: string, cwdLabel: string, failed: boolean): { learnt: (RunFact & Kept)[]; unlearnt: string[] } {
  const learnt: (RunFact & Kept)[] = [];
  const unlearnt: string[] = [];
  const command = commandOf(tool, input);
  if (!command) return { learnt, unlearnt };
  const text = output.slice(0, 8000);
  // Lowercase, as the project's knowledge stores it, so a kept fact and a fresh one are the same fact.
  const repoKey = `git-repo:${cwdLabel.toLowerCase()}`;
  const gitRelated = (tool === 'git' || /(^|[\s;&|])git\s/.test(` ${command}`)) && !runsElsewhere(tool, input, command);
  if (gitRelated && failed && /not a git repository/i.test(text)) {
    learnt.push({ key: repoKey, text: `${cwdLabel} is not a git repository: git commands there fail (run "git init" first if one is needed).`, from: '', relation: `git repository at ${cwdLabel.toLowerCase()}`, value: 'none' });
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
  private results = new Map<string, { output: string; by: string; epoch: number }>();
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
  ) {
    // Start knowing what earlier runs found: only what may go to any model. The
    // entity is the project's general knowledge, not only what this board wrote,
    // so each fact passes the same gate as T1's plan and graph_search
    // (factMayLeave), and one about a folder that is local-only now is left out.
    const rules = privacy();
    for (const f of db?.getFactsForEntities([ENTITY]) ?? []) {
      const key = f.relation.startsWith('git repository at ') ? `git-repo:${f.relation.slice('git repository at '.length)}`
        : f.relation.startsWith('command ') ? `missing:${f.relation.slice('command '.length)}` : '';
      if (!key) continue;
      // Only the failure each relation records: the entity is general knowledge, and
      // a fact extracted or imported there may say the opposite ("command jq:
      // available"), which must not reach workers as something missing.
      if (f.value.trim().toLowerCase() !== (key.startsWith('git-repo:') ? 'none' : 'not available')) continue;
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
    return rel ? rel.split(path.sep).join('/') : 'The project folder';
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
    return hit && hit.epoch === this.epoch && this.changing === 0 ? { output: hit.output, by: hit.by } : null;
  }

  /**
   * Called as a call starts. A call that may change things is counted while it
   * runs: no stored answer is given meanwhile, as it may already be out of date.
   * Returns the moment it started, for `observe`.
   */
  begin(tool: string, input: Record<string, unknown>): number {
    if (!callReadsOnly(tool, input)) this.changing += 1;
    return this.epoch;
  }

  /**
   * How a call went (its answer, or the error it failed with). Always ends what
   * `begin` started; its facts and answer go on the board only if `publish`.
   */
  observe(tool: string, input: Record<string, unknown>, output: string, by: string, startedAt: number, how: Observed): void {
    // Something that may change things, and finished (or failed part way): anything
    // stored before it is stale.
    if (!callReadsOnly(tool, input)) { this.epoch += 1; this.changing = Math.max(0, this.changing - 1); }
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
    if (key && !how.failed && startedAt === this.epoch && output.length <= MAX_RESULT_CHARS) {
      if (this.results.size >= MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
      this.results.set(key, { output, by, epoch: this.epoch });
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
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.epoch += 1;
      this.changing = Math.max(0, this.changing - 1);
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
