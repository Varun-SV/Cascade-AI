// ─────────────────────────────────────────────
//  Cascade AI — Running a cloud run's tool calls in a folder on this machine
// ─────────────────────────────────────────────
//
//  The machine's side of a workspace (docs/design/workspace-env.md). Each call is
//  run by Cascade's own tool registry, rooted at the folder the user chose, with
//  what a local run has: the workspace path sandbox, the process jail, the
//  folder's .cascadeignore and privacy.paths. On top of that, because the asker is
//  a run elsewhere:
//
//    - Only the tools the user allowed run. Anything else is refused here, whatever
//      the server sends.
//    - Each call's risk is judged here (src/core/permissions/risk.ts). A risky one
//      (deletes, sends off the machine, rewrites git history, installs, changes
//      things outside the folder, …) is asked about on this machine; a no, or no
//      answer, refuses it.
//    - Before the run's first change the folder is checkpointed, so everything the
//      run did can be undone here. Where no checkpoint could be taken, every change
//      is asked about.
//    - Every result goes to the run's models, which are cloud models: a local-only
//      file (privacy.paths) is never read for one, for any destination.

import fs from 'node:fs';
import path from 'node:path';
import type { PrivacyPaths } from '../core/privacy/paths.js';
import { assessRisk, type Risk } from '../core/permissions/risk.js';
import type { ToolDefinition, ToolExecuteOptions } from '../types.js';
import { CONTEXT_LIMIT_CHARS } from '../utils/truncate.js';
import { CUT_NOTE, MAX_CHANGED, MAX_CHANGED_PATH_CHARS, capResult, isWorkspaceTool } from './protocol.js';

/** Files remembered per worker, and workers remembered: bounds on what the machine keeps. */
const MAX_TRACKED_FILES = 500;
const MAX_TRACKED_WORKERS = 64;

/** The calls that change the file they name: a worker's own change is no news to it. */
const SELF_CHANGES = new Set(['file_write', 'file_edit', 'file_delete']);

/** What the executor needs of a tool registry: Cascade's ToolRegistry, rooted at the folder. */
export interface WorkspaceRegistry {
  getWorkspaceRoot(): string;
  getToolDefinitions(): ToolDefinition[];
  execute(name: string, input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string>;
  /** The policies the process jail hides local-only paths from commands by. */
  setPrivacyPaths?(paths: PrivacyPaths | undefined): void;
  /** How commands are confined: "off" means nothing hides a file from them. */
  processJailMode?(): string;
}

/** What the executor needs of the folder's checkpoints (src/core/checkpoints.ts). */
export interface WorkspaceCheckpoints {
  /** Null when the folder can't be recorded: the run is then not undoable. */
  begin(label: string): Promise<{ n: number } | null>;
  end(cp: { n: number }): Promise<unknown>;
  /** Whether a checkpoint records every one of these files (absolute paths). False when it can't tell. */
  covers?(paths: string[]): Promise<boolean>;
}

/** A call put to the person on this machine. */
export interface WorkspaceQuestion {
  tool: string;
  input: Record<string, unknown>;
  risk: Risk;
  /** Ends the question: the run withdrew the call, or the session ended. */
  signal: AbortSignal;
}

export interface WorkspaceExecutorOptions {
  registry: WorkspaceRegistry;
  /** The tools the user allowed for this run. */
  tools: readonly string[];
  /** Asks the person on this machine. True runs the call. */
  ask(q: WorkspaceQuestion): Promise<boolean>;
  checkpoints?: WorkspaceCheckpoints;
  /** The folder's privacy.paths, read when each call runs. */
  privacy?: () => PrivacyPaths | undefined;
  /** What the checkpoint is labelled: the run, as the person knows it. */
  label?: string;
  /** For the machine's own log. Never sent to the server. */
  log?(line: string): void;
}

export type CallOutcome = { ok: true; output: string; changed?: string[] } | { ok: false; error: string };

export interface WorkspaceExecutor {
  /** The allowed tools, with the schemas this machine's registry gives them. */
  definitions(): ToolDefinition[];
  /**
   * One call. `waiting` is called when it waits for the person's answer. `worker` is
   * who asks: the machine tells each worker which files it read have changed since.
   */
  run(tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; waiting?: () => void; worker?: string }): Promise<CallOutcome>;
  /** The session is over: the checkpoint is closed, so the run's changes can be undone. */
  finish(): Promise<void>;
}

/** Tools that run programs, which see the folder through the process jail, not mayRead. */
const PROCESS_TOOLS = new Set(['shell', 'run_code', 'git']);

/**
 * The folder's own path, as `.`, wherever it appears in what goes back: an error
 * from a file tool names the absolute path, and the path never leaves the machine.
 */
function pathScrubber(root: string): (text: string) => string {
  const forms = new Set<string>();
  for (const p of [root, (() => { try { return fs.realpathSync(root); } catch { return root; } })()]) {
    forms.add(p);
    forms.add(p.split(path.sep).join('/'));
  }
  // Longest first, so a real path that extends another is replaced whole.
  const ordered = [...forms].filter((f) => f.length > 1).sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((t, f) => t.split(f).join('.'), text);
}

export function createWorkspaceExecutor(opts: WorkspaceExecutorOptions): WorkspaceExecutor {
  const root = opts.registry.getWorkspaceRoot();
  const scrub = pathScrubber(root);
  const allowed = new Set(opts.tools.filter(isWorkspaceTool));
  const log = opts.log ?? (() => {});
  /** Taken once, before the first change: the checkpoint, or null when none could be. */
  let checkpoint: Promise<{ n: number } | null> | null = null;
  let finished = false;
  /** Per worker: the files it read here, as they were (mtime, size), by absolute path. */
  const reads = new Map<string, Map<string, { mtimeMs: number; size: number }>>();

  const stat = (abs: string): { mtimeMs: number; size: number } | null => {
    try { const st = fs.statSync(abs); return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null; } catch { return null; }
  };
  const inFolder = (abs: string): string | null => {
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
  };

  /**
   * After a successful call by `worker`: its own reads and writes are no news to it, and
   * what else it read earlier is checked against the disk. Returns the folder-relative
   * paths that changed since, once each. Never a local-only file's name, and never
   * more than the protocol allows.
   */
  const trackReads = (worker: string, tool: string, input: Record<string, unknown>, heldWasCurrent = true, complete = true): string[] => {
    let mine = reads.get(worker);
    const given = typeof input['path'] === 'string' ? path.resolve(root, input['path']) : null;
    if (given && tool === 'file_read' && inFolder(given) !== null && mayRead(given)) {
      if (!mine) {
        if (reads.size >= MAX_TRACKED_WORKERS) reads.delete(reads.keys().next().value as string);
        mine = new Map();
        reads.set(worker, mine);
      }
      const now = stat(given);
      // A read of part of a file (offset, limit) shows only that part: a file already
      // held keeps what it was held at, so a change elsewhere in it is still reported.
      // So does a whole read the result cap cut short: the rest was never sent.
      const partial = !complete || (typeof input['offset'] === 'number' && input['offset'] > 1) || typeof input['limit'] === 'number';
      if (now && !(partial && mine.has(given))) {
        mine.delete(given);
        mine.set(given, now);
        if (mine.size > MAX_TRACKED_FILES) mine.delete(mine.keys().next().value as string);
      }
    } else if (given && mine?.has(given) && SELF_CHANGES.has(tool) && (heldWasCurrent || tool !== 'file_edit')) {
      // Its own write, edit or delete: it knows. (A listing or a search changes nothing.)
      // Not an edit of a copy that was already stale: an edit shows only the lines it
      // replaced, so what else changed is still news, and the check below reports it.
      const now = tool === 'file_delete' ? null : stat(given);
      if (now) mine.set(given, now); else mine.delete(given);
    }
    if (!mine) return [];
    const changed: string[] = [];
    for (const [abs, was] of [...mine]) {
      const now = stat(abs);
      if (now && now.mtimeMs === was.mtimeMs && now.size === was.size) continue;
      const rel = inFolder(abs);
      const reportable = rel !== null && rel.length <= MAX_CHANGED_PATH_CHARS && mayRead(abs);
      // Over the cap: held as it was, so the next call reports it.
      if (reportable && changed.length >= MAX_CHANGED) continue;
      // Reported once (or never reportable): a file that is gone is forgotten, one that changed is held as it is now.
      if (now) mine.set(abs, now); else mine.delete(abs);
      if (reportable) changed.push(rel);
    }
    return changed;
  };

  const firstChange = (): Promise<{ n: number } | null> => {
    checkpoint ??= opts.checkpoints
      ? opts.checkpoints.begin(opts.label ?? 'A Cascade Cloud run').catch(() => null)
      : Promise.resolve(null);
    return checkpoint;
  };

  // Every result is read by a cloud model: a local-only file isn't, for any destination.
  const mayRead = (absPath: string): boolean => {
    const privacy = opts.privacy?.();
    return !(privacy?.hasPolicies() && privacy.coversFile(absPath, root));
  };

  const api: Pick<WorkspaceExecutor, 'definitions' | 'run'> = {
    definitions: () => opts.registry.getToolDefinitions().filter((t) => allowed.has(t.name as never)),

    async run(tool, input, call) {
      // Never rejects: whatever fails (an unreadable privacy record, say) is a refused call.
      try {
        // Whether what the worker last read is still what's on disk, before its edit changes it.
        let heldWasCurrent = true;
        if (tool === 'file_edit' && call.worker && typeof input['path'] === 'string') {
          try {
            const abs = path.resolve(root, input['path']);
            const was = reads.get(call.worker)?.get(abs);
            const now = was ? stat(abs) : null;
            heldWasCurrent = !was || (!!now && now.mtimeMs === was.mtimeMs && now.size === was.size);
          } catch { /* best effort */ }
        }
        const outcome = await runCall(tool, input, call);
        if (!outcome.ok || !call.worker) return outcome;
        // Best effort: a failure to look at the disk is no failure of the call.
        try {
          // Complete only if the worker sees all of it: neither cut by the result cap here,
          // nor longer than the part of a result its context keeps whole.
          const complete = !CUT_NOTE.test(outcome.output) && outcome.output.length <= CONTEXT_LIMIT_CHARS;
          const changed = trackReads(call.worker, tool, input, heldWasCurrent, complete);
          return changed.length ? { ...outcome, changed } : outcome;
        } catch { return outcome; }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`${tool} failed before it ran: ${message}`);
        return { ok: false, error: scrub(`${tool} was not run: ${message}`) };
      }
    },
  };

  async function runCall(tool: string, input: Record<string, unknown>, { signal, waiting }: { signal: AbortSignal; waiting?: () => void; worker?: string }): Promise<CallOutcome> {
    if (finished) return { ok: false, error: 'The workspace session is over.' };
    if (!allowed.has(tool as never)) return { ok: false, error: `${tool} is not allowed on this machine for this run.` };
    if (signal.aborted) return { ok: false, error: `${tool} was not run: the run withdrew it.` };
    const privacy = opts.privacy?.();
    // Commands see the folder through the jail: it hides local-only paths only when
    // told them, and only when there is a jail. With none, nothing would keep a
    // local-only file from a command whose output goes to a cloud model.
    opts.registry.setPrivacyPaths?.(privacy);
    if (PROCESS_TOOLS.has(tool) && privacy?.hasPolicies() && (opts.registry.processJailMode?.() ?? 'off') === 'off') {
      return { ok: false, error: `${tool} is not run for a cloud run here: this folder has local-only files (privacy.paths), and with the process jail off nothing keeps them from a command.` };
    }
    let risk: Risk;
    try { risk = assessRisk(tool, input, root); } catch { risk = { level: 'risky', category: 'unclassified', reason: `${tool} could not be checked` }; }
    if (risk.level !== 'safe') {
      const cp = await firstChange();
      // Undoable only with a checkpoint: without one, a change asks as a risky one does.
      let undoable = !!cp;
      if (risk.level === 'recoverable' && !cp) {
        risk = { ...risk, reason: `${risk.reason.replace(/ \(checkpointed\)$/, '')}, and no checkpoint of the folder could be taken to undo it` };
      } else if (risk.level === 'recoverable' && risk.writes?.length && opts.checkpoints?.covers) {
        // A file the checkpoint leaves out (one the project's .gitignore excludes,
        // say) can't be put back by /undo, checkpoint or no.
        const covered = await opts.checkpoints.covers(risk.writes).catch(() => false);
        if (!covered) {
          undoable = false;
          risk = { ...risk, reason: `${risk.reason.replace(/ \(checkpointed\)$/, '')}, a file the checkpoint doesn't record, so undo couldn't put it back` };
        }
      }
      if (risk.level === 'risky' || !undoable) {
        waiting?.();
        // Withdrawn while the question is open: the call ends now, whatever the question does.
        const withdrawn = new Promise<false>((resolve) => {
          if (signal.aborted) resolve(false); else signal.addEventListener('abort', () => resolve(false), { once: true });
        });
        let yes = false;
        try { yes = await Promise.race([opts.ask({ tool, input, risk, signal }), withdrawn]); } catch { yes = false; }
        if (signal.aborted) return { ok: false, error: `${tool} was not run: the run withdrew it.` };
        if (!yes) {
          log(`declined ${tool}: ${risk.reason}`);
          return { ok: false, error: scrub(`Declined on the machine: ${tool} ${risk.reason}.`) };
        }
      }
    }
    try {
      const out = await opts.registry.execute(tool, input, {
        tierId: 'workspace', sessionId: 'workspace', requireApproval: false, signal,
        // Shown to a cloud model, whatever the destination asked about.
        mayRead: (absPath) => mayRead(absPath),
      });
      return { ok: true, output: capResult(scrub(out)) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`${tool} failed: ${message}`);
      return { ok: false, error: scrub(message) };
    }
  }

  return {
    ...api,
    async finish() {
      if (finished) return;
      finished = true;
      const cp = checkpoint ? await checkpoint : null;
      if (cp && opts.checkpoints) await opts.checkpoints.end(cp).catch(() => undefined);
    },
  };
}
