// ─────────────────────────────────────────────
//  Cascade AI — Abstract Tool Base
// ─────────────────────────────────────────────

import type { ToolDefinition, ToolExecuteOptions } from '../types.js';

export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: Record<string, unknown>;

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
