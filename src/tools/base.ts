// ─────────────────────────────────────────────
//  Cascade AI — Abstract Tool Base
// ─────────────────────────────────────────────

import path from 'node:path';
import type { ReadDestination, ToolDefinition, ToolExecuteOptions } from '../types.js';
import type { ProcessJail } from './jail/process-jail.js';
import { PROBE } from '../utils/link-aliases.js';

export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: Record<string, unknown>;
  protected workspaceRoot: string = process.cwd();
  /**
   * True for an absolute path this tool must not read, list or write: set by
   * the registry from `.cascadeignore` and the built-in protected paths. A
   * tool that walks directories (grep, glob, file_list) consults it for every
   * file it would otherwise return.
   */
  protected isProtectedPath: (absPath: string) => boolean = () => false;

  /**
   * True for a tool that touches files only by calling other tools through
   * the registry, never itself — an agent-written tool. The registry's
   * workspace gate is taken by those calls, so not by this one.
   */
  readonly delegatesToTools: boolean = false;

  /**
   * True for a tool that sends nothing it is given off this machine, so a
   * local-only subtask (privacy.paths) may call it. The registry's own
   * built-ins are judged by the registry; any other tool is refused to such
   * a subtask unless it says this — its arguments can carry what it read.
   */
  readonly localOnlySafe: boolean = false;

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  setPathGuard(guard: (absPath: string) => boolean): void {
    this.isProtectedPath = guard;
  }

  /**
   * The jail a tool that runs real programs launches them in — set by the
   * registry. Unset (a tool used outside one), programs run as they are.
   */
  protected jail?: ProcessJail;

  setProcessJail(jail: ProcessJail): void {
    this.jail = jail;
  }

  /**
   * `options.mayRead` for this call, asked at most once per file: whether the
   * call may read that file's contents to `to`. Always true when nothing asks.
   */
  protected readGate(options: ToolExecuteOptions, to: ReadDestination = 'model'): (absPath: string) => boolean {
    const ask = options.mayRead;
    if (!ask) return () => true;
    const answers = new Map<string, boolean>();
    return (absPath) => {
      let answer = answers.get(absPath);
      if (answer === undefined) {
        answer = ask(absPath, to);
        answers.set(absPath, answer);
      }
      return answer;
    };
  }

  /**
   * For a tool that lists what it finds (file_list, glob): whether this call
   * may show a path's name. A name can carry what a local-only file holds —
   * it is where a local-only subtask could have put it — so the read gate
   * decides, for a search that did not name the file. A directory shows when
   * it is not covered whole.
   */
  protected listGate(options: ToolExecuteOptions): (absPath: string, dir: boolean) => boolean {
    const mayRead = this.readGate(options, 'scan');
    return (absPath, dir) => mayRead(absPath) && (!dir || mayRead(path.join(absPath, PROBE)));
  }

  abstract execute(
    input: Record<string, unknown>,
    options: ToolExecuteOptions,
  ): Promise<string>;

  isDangerous(): boolean {
    return false;
  }

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }
}
