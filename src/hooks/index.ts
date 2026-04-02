// ─────────────────────────────────────────────
//  Cascade AI — Hooks System
// ─────────────────────────────────────────────

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { HookDefinition, HooksConfig } from '../types.js';

const execAsync = promisify(exec);

export class HooksRunner {
  private config: HooksConfig;

  constructor(config: HooksConfig) {
    this.config = config;
  }

  async runPreToolUse(toolName: string, input: Record<string, unknown>): Promise<HookResult> {
    return this.runHooks(this.config.preToolUse ?? [], toolName, { tool: toolName, input });
  }

  async runPostToolUse(toolName: string, output: string): Promise<HookResult> {
    return this.runHooks(this.config.postToolUse ?? [], toolName, { tool: toolName, output });
  }

  async runPreTask(prompt: string): Promise<HookResult> {
    return this.runHooks(this.config.preTask ?? [], '*', { prompt });
  }

  async runPostTask(output: string, durationMs: number): Promise<HookResult> {
    return this.runHooks(this.config.postTask ?? [], '*', { output, durationMs });
  }

  private async runHooks(
    hooks: HookDefinition[],
    toolName: string,
    env: Record<string, unknown>,
  ): Promise<HookResult> {
    const applicable = hooks.filter(
      (h) => !h.tools?.length || h.tools.includes(toolName) || h.tools.includes('*'),
    );

    const results: string[] = [];
    for (const hook of applicable) {
      try {
        const envVars = Object.fromEntries(
          Object.entries(env).map(([k, v]) => [
            `CASCADE_${k.toUpperCase()}`,
            typeof v === 'string' ? v : JSON.stringify(v),
          ]),
        );
        const { stdout } = await execAsync(hook.command, {
          timeout: hook.timeout ?? 10_000,
          env: { ...process.env, ...envVars },
        });
        if (stdout.trim()) results.push(stdout.trim());
      } catch (err) {
        return {
          success: false,
          output: results.join('\n'),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { success: true, output: results.join('\n') };
  }
}

export interface HookResult {
  success: boolean;
  output: string;
  error?: string;
}
