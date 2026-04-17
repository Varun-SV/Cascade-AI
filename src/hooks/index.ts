// ─────────────────────────────────────────────
//  Cascade AI — Hooks System
// ─────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HookDefinition, HooksConfig } from '../types.js';

const execFileAsync = promisify(execFile);

const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function sanitizeEnvValue(v: unknown): string {
  const raw = typeof v === 'string' ? v : JSON.stringify(v);
  // Strip control chars and cap length so a malicious hook cannot inject NUL
  // or ANSI escape sequences that change how a downstream script parses its
  // environment.
  return raw.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 8192);
}

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
        const envVars: Record<string, string> = {};
        for (const [k, v] of Object.entries(env)) {
          const name = `CASCADE_${k.toUpperCase()}`;
          // Reject environment variable names that contain shell-unsafe chars.
          // This cannot happen with the built-in callers (fixed strings), but
          // guards against future callers that forward user input.
          if (!SAFE_ENV_NAME.test(name)) continue;
          envVars[name] = sanitizeEnvValue(v);
        }

        // SECURITY: Previously this used `exec(hook.command, { env })`, which
        // interpolates the command string verbatim. Because `env` carries
        // tool input, any value containing `$(...)`, backticks, or `;` could
        // be executed by the shell that ran the hook. We now hand the command
        // to the platform shell as a literal argument via `execFile` — the
        // shell still interprets the command body (so users can keep writing
        // pipelines), but env values can never graft onto the command line.
        const isWin = process.platform === 'win32';
        const shell = isWin ? 'cmd.exe' : '/bin/sh';
        const shellArgs = isWin ? ['/d', '/s', '/c', hook.command] : ['-c', hook.command];

        const { stdout } = await execFileAsync(shell, shellArgs, {
          timeout: hook.timeout ?? 10_000,
          env: { ...process.env, ...envVars },
          windowsHide: true,
        });
        const text = typeof stdout === 'string' ? stdout : Buffer.from(stdout as ArrayBufferLike).toString('utf-8');
        if (text.trim()) results.push(text.trim());
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
