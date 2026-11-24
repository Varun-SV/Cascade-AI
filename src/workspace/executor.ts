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

import type { PrivacyPaths } from '../core/privacy/paths.js';
import { assessRisk, type Risk } from '../core/permissions/risk.js';
import type { ToolDefinition, ToolExecuteOptions } from '../types.js';
import { capResult, isWorkspaceTool } from './protocol.js';

/** What the executor needs of a tool registry: Cascade's ToolRegistry, rooted at the folder. */
export interface WorkspaceRegistry {
  getWorkspaceRoot(): string;
  getToolDefinitions(): ToolDefinition[];
  execute(name: string, input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string>;
}

/** What the executor needs of the folder's checkpoints (src/core/checkpoints.ts). */
export interface WorkspaceCheckpoints {
  /** Null when the folder can't be recorded: the run is then not undoable. */
  begin(label: string): Promise<{ n: number } | null>;
  end(cp: { n: number }): Promise<unknown>;
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

export type CallOutcome = { ok: true; output: string } | { ok: false; error: string };

export interface WorkspaceExecutor {
  /** The allowed tools, with the schemas this machine's registry gives them. */
  definitions(): ToolDefinition[];
  /** One call. `waiting` is called when it waits for the person's answer. */
  run(tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; waiting?: () => void }): Promise<CallOutcome>;
  /** The session is over: the checkpoint is closed, so the run's changes can be undone. */
  finish(): Promise<void>;
}

export function createWorkspaceExecutor(opts: WorkspaceExecutorOptions): WorkspaceExecutor {
  const root = opts.registry.getWorkspaceRoot();
  const allowed = new Set(opts.tools.filter(isWorkspaceTool));
  const log = opts.log ?? (() => {});
  /** Taken once, before the first change: the checkpoint, or null when none could be. */
  let checkpoint: Promise<{ n: number } | null> | null = null;
  let finished = false;

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

  return {
    definitions: () => opts.registry.getToolDefinitions().filter((t) => allowed.has(t.name as never)),

    async run(tool, input, { signal, waiting }) {
      if (finished) return { ok: false, error: 'The workspace session is over.' };
      if (!allowed.has(tool as never)) return { ok: false, error: `${tool} is not allowed on this machine for this run.` };
      if (signal.aborted) return { ok: false, error: `${tool} was not run: the run withdrew it.` };
      let risk: Risk;
      try { risk = assessRisk(tool, input, root); } catch { risk = { level: 'risky', category: 'unclassified', reason: `${tool} could not be checked` }; }
      if (risk.level !== 'safe') {
        const cp = await firstChange();
        // Undoable only with a checkpoint: without one, a change asks as a risky one does.
        if (risk.level === 'recoverable' && !cp) {
          risk = { ...risk, reason: `${risk.reason.replace(/ \(checkpointed\)$/, '')}, and no checkpoint of the folder could be taken to undo it` };
        }
        if (risk.level === 'risky' || !cp) {
          waiting?.();
          let yes = false;
          try { yes = await opts.ask({ tool, input, risk, signal }); } catch { yes = false; }
          if (signal.aborted) return { ok: false, error: `${tool} was not run: the run withdrew it.` };
          if (!yes) {
            log(`declined ${tool}: ${risk.reason}`);
            return { ok: false, error: `Declined on the machine: ${tool} ${risk.reason}.` };
          }
        }
      }
      try {
        const out = await opts.registry.execute(tool, input, {
          tierId: 'workspace', sessionId: 'workspace', requireApproval: false, signal,
          // Shown to a cloud model, whatever the destination asked about.
          mayRead: (absPath) => mayRead(absPath),
        });
        return { ok: true, output: capResult(out) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async finish() {
      if (finished) return;
      finished = true;
      const cp = checkpoint ? await checkpoint : null;
      if (cp && opts.checkpoints) await opts.checkpoints.end(cp).catch(() => undefined);
    },
  };
}
