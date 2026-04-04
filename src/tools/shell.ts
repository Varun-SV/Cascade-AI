// ─────────────────────────────────────────────
//  Cascade AI — Shell Tool
// ─────────────────────────────────────────────

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

const execAsync = promisify(exec);

export class ShellTool extends BaseTool {
  readonly name = 'shell';
  readonly description = 'Execute a shell command and return its output. Use for running scripts, compiling code, running tests, etc.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  };

  private allowlist: string[];
  private blocklist: string[];

  constructor(allowlist: string[] = [], blocklist: string[] = []) {
    super();
    this.allowlist = allowlist;
    this.blocklist = blocklist;
  }

  isDangerous(): boolean {
    return true;
  }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const command = input['command'] as string;
    const cwd = (input['cwd'] as string | undefined) ?? this.workspaceRoot;
    const timeout = (input['timeout'] as number | undefined) ?? 30_000;

    this.validateCommand(command);

    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout });
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      return out || '(no output)';
    } catch (err) {
      if (err instanceof Error && 'stdout' in err && 'stderr' in err) {
        const e = err as Error & { stdout: string; stderr: string; code: number };
        return `Exit ${e.code ?? 1}:\n${[e.stdout, e.stderr].filter(Boolean).join('\n').trim()}`;
      }
      throw err;
    }
  }

  private validateCommand(command: string): void {
    // Block dangerous patterns
    const builtinDangerous = [
      /rm\s+-rf\s+\//,
      />\s*\/dev\/sda/,
      /mkfs\./,
      /dd\s+if=.*of=\/dev\//,
      /chmod\s+777\s+\//,
    ];

    for (const pattern of builtinDangerous) {
      if (pattern.test(command)) {
        throw new Error(`Command blocked: matches dangerous pattern`);
      }
    }

    // User blocklist (substring match)
    for (const blocked of this.blocklist) {
      if (command.toLowerCase().includes(blocked.toLowerCase())) {
        throw new Error(`Command blocked by blocklist: "${blocked}"`);
      }
    }

    // User allowlist (if set, command must match one entry)
    if (this.allowlist.length > 0) {
      const allowed = this.allowlist.some((a) => command.startsWith(a));
      if (!allowed) {
        throw new Error(`Command not in allowlist. Allowed prefixes: ${this.allowlist.join(', ')}`);
      }
    }
  }
}
