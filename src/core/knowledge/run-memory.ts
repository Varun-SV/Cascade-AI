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
//  - Facts about the machine, read from what tools answered: a folder that is
//    not a git repository, a command the shell doesn't have. Each worker is
//    shown the ones it hasn't seen yet before its next model call.
//  - Results of read-only commands (shell and git, judged by the same risk
//    rules auto mode uses): the same command in the same folder gives the
//    earlier answer again instead of running, until anything that can change
//    things runs. Then every stored result is dropped.
//  - The facts are kept in the project's knowledge (entity "environment"), so
//    the next run starts knowing them, and one that stops being true (a
//    repository made, a command that now works) is taken back out.
//
//  Only short facts in Cascade's own words are kept, never a tool's output,
//  and a local-only subtask (privacy.paths) adds nothing and reads nothing.

import path from 'node:path';
import { assessRisk } from '../permissions/risk.js';
import type { WorldStateDB } from './world-state.js';

/** A fact for the board: `key` identifies it (one per thing it is about). */
export interface RunFact { key: string; text: string; from: string }

interface Kept { relation: string; value: string }

const ENTITY = 'environment';
const MAX_FACTS = 60;
const MAX_RESULTS = 200;
const MAX_RESULT_CHARS = 20_000;
/** Read-only commands whose answer changes by itself: never given again. */
const TIME_BOUND = /^\s*(date|time|uptime|ps|top|free|vmstat|iostat|netstat|ss|get-date|get-process|tasklist|sleep)\b/i;

/** The facts a tool's answer shows about the machine. */
export function factsFrom(tool: string, input: Record<string, unknown>, output: string, cwdLabel: string): { learnt: (RunFact & Kept)[]; unlearnt: string[] } {
  const learnt: (RunFact & Kept)[] = [];
  const unlearnt: string[] = [];
  const text = output.slice(0, 8000);
  const command = typeof input['command'] === 'string' ? input['command'] : '';
  const gitRelated = tool === 'git' || /^\s*git\b/.test(command) || /\bgit\s/.test(command);
  // Lowercase, as the project's knowledge stores it, so a kept fact and a fresh one are the same fact.
  const repoKey = `git-repo:${cwdLabel.toLowerCase()}`;
  if (gitRelated && /not a git repository/i.test(text)) {
    learnt.push({ key: repoKey, text: `${cwdLabel} is not a git repository: git commands there fail (run "git init" first if one is needed).`, from: '', relation: `git repository at ${cwdLabel.toLowerCase()}`, value: 'none' });
  } else if (gitRelated && /\bgit\s+init\b/.test(command)) {
    unlearnt.push(repoKey);
  }
  const missing = new Set<string>();
  for (const m of text.matchAll(/(?:^|\n)(?:[\w./-]+: )?(?:(?:line )?\d+: )?([\w.+-]{1,40}): (?:command )?not found/g)) missing.add(m[1]!);
  for (const m of text.matchAll(/'([\w.+-]{1,40})' is not recognized as an internal or external command/g)) missing.add(m[1]!);
  for (const m of text.matchAll(/The term '([\w.+-]{1,40})' is not recognized as (?:the )?name of a cmdlet/g)) missing.add(m[1]!);
  for (const name of missing) {
    learnt.push({ key: `missing:${name.toLowerCase()}`, text: `\`${name}\` is not available in this machine's shell: use another way (another command, or run_code).`, from: '', relation: `command ${name.toLowerCase()}`, value: 'not available' });
  }
  return { learnt, unlearnt };
}

/** The command a call ran, when it is a shell command. */
function commandOf(tool: string, input: Record<string, unknown>): string {
  if (tool === 'shell') return typeof input['command'] === 'string' ? input['command'] : '';
  if (tool === 'git') return `git ${String(input['operation'] ?? '')} ${Array.isArray(input['args']) ? (input['args'] as unknown[]).join(' ') : ''}`;
  return '';
}

export class RunMemory {
  private facts = new Map<string, RunFact & { relation?: string }>();
  private seen = new Map<string, Set<string>>();
  private results = new Map<string, { output: string; by: string; epoch: number }>();
  /** Bumped by every call that can change anything: a stored result from before it is stale. */
  private epoch = 0;
  /** Calls that can change things, still running. */
  private changing = 0;

  constructor(private readonly root: string, private readonly db?: WorldStateDB) {
    // Start knowing what earlier runs found.
    for (const f of db?.getFactsForEntities([ENTITY]) ?? []) {
      const key = f.relation.startsWith('git repository at ') ? `git-repo:${f.relation.slice('git repository at '.length)}`
        : f.relation.startsWith('command ') ? `missing:${f.relation.slice('command '.length)}` : '';
      if (!key) continue;
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

  private label(abs: string): string {
    const rel = path.relative(this.root, abs);
    return rel ? rel.split(path.sep).join('/') : 'The project folder';
  }

  private reusable(tool: string, input: Record<string, unknown>): string | null {
    if (tool !== 'shell' && tool !== 'git') return null;
    const command = commandOf(tool, input);
    if (!command.trim() || TIME_BOUND.test(command)) return null;
    if (assessRisk(tool, input, this.root).level !== 'safe') return null;
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
   * Called as a call starts. A call that can change things is counted while it
   * runs: no stored answer is given meanwhile, as it may already be out of date.
   * Returns the moment it started, for `observe`.
   */
  begin(tool: string, input: Record<string, unknown>): number {
    if (!this.readsOnly(tool, input)) this.changing += 1;
    return this.epoch;
  }

  private readsOnly(tool: string, input: Record<string, unknown>): boolean {
    try { return assessRisk(tool, input, this.root).level === 'safe'; } catch { return false; }
  }

  /** What a call answered, or the error it failed with: its facts go on the board, and a read-only answer is kept. */
  observe(tool: string, input: Record<string, unknown>, output: string, by: string, startedAt: number): void {
    const cwd = this.cwd(input);
    const { learnt, unlearnt } = factsFrom(tool, input, output, this.label(cwd));
    // Something that can change things, and finished (or failed part way): anything
    // stored before it is stale.
    if (!this.readsOnly(tool, input)) { this.epoch += 1; this.changing = Math.max(0, this.changing - 1); }
    for (const key of unlearnt) this.forget(key);
    // A command that worked is no longer missing.
    const ran = commandOf(tool, input).trim().split(/\s+/)[0]?.toLowerCase();
    if (ran && !learnt.some((f) => f.key === `missing:${ran}`) && this.facts.has(`missing:${ran}`) && !/not (found|recognized)/i.test(output)) this.forget(`missing:${ran}`);
    for (const f of learnt) {
      if (this.facts.size >= MAX_FACTS && !this.facts.has(f.key)) break;
      const isNew = !this.facts.has(f.key);
      this.facts.set(f.key, { key: f.key, text: f.text, from: by, relation: f.relation });
      // Who found it has seen it.
      this.seenBy(by).add(f.key);
      if (isNew) this.db?.upsertFact(ENTITY, f.relation, f.value, `run:${by}`, undefined, []);
    }
    const key = this.reusable(tool, input);
    if (key && startedAt === this.epoch && output.length <= MAX_RESULT_CHARS) {
      if (this.results.size >= MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
      this.results.set(key, { output, by, epoch: this.epoch });
    }
  }

  private forget(key: string): void {
    const fact = this.facts.get(key);
    if (!fact) return;
    this.facts.delete(key);
    if (fact.relation) this.db?.deleteFact(ENTITY, fact.relation);
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
