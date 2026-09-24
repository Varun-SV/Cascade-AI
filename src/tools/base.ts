// ─────────────────────────────────────────────
//  Cascade AI — Abstract Tool Base
// ─────────────────────────────────────────────

import type { ToolDefinition, ToolExecuteOptions } from '../types.js';

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

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  setPathGuard(guard: (absPath: string) => boolean): void {
    this.isProtectedPath = guard;
  }

  /**
   * `options.mayRead` for this call, asked at most once per file: whether the
   * call may read that file's contents to `to`. Always true when nothing asks.
   */
  protected readGate(options: ToolExecuteOptions, to: 'model' | 'service' = 'model'): (absPath: string) => boolean {
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
