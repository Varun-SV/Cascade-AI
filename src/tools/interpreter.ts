// ─────────────────────────────────────────────
//  Cascade AI — Code Interpreter Tool
// ─────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { statePath, STATE } from '../config/project-state.js';
import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

/** Detect the first available command from a candidate list. Returns null if none found. */
function detectCommand(candidates: string[]): string | null {
  for (const cmd of candidates) {
    try {
      // `where` on Windows, `which` on Unix — both exit non-zero if not found
      const which = process.platform === 'win32' ? 'where' : 'which';
      execSync(`${which} ${cmd}`, { stdio: 'ignore' });
      return cmd;
    } catch {
      // command not found, try next
    }
  }
  return null;
}

// Detect Python and Node at module load time to avoid repeated PATH scans
const PYTHON_CMD = detectCommand(['python3', 'python']);
const NODE_CMD = detectCommand(['node']);

export class CodeInterpreterTool extends BaseTool {
  readonly name = 'run_code';
  readonly description = 'Execute a Python or Node.js script to perform complex tasks (data processing, file conversion, etc.). The script is automatically cleaned up after execution.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'nodejs'], description: 'Programming language of the script' },
      code: { type: 'string', description: 'The complete source code to execute' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments for the script' },
    },
    required: ['language', 'code'],
  };

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const language = input['language'] as 'python' | 'nodejs';
    const code = input['code'] as string;
    const args = (input['args'] as string[]) ?? [];

    // Resolve interpreter command
    let cmdPrefix: string;
    if (language === 'python') {
      if (!PYTHON_CMD) {
        return [
          'Error: Python interpreter not found.',
          'Please install Python and ensure it is in your PATH.',
          'Tried: python3, python',
        ].join('\n');
      }
      cmdPrefix = PYTHON_CMD;
    } else {
      if (!NODE_CMD) {
        return [
          'Error: Node.js interpreter not found.',
          'Please install Node.js and ensure it is in your PATH.',
          'Tried: node',
        ].join('\n');
      }
      cmdPrefix = NODE_CMD;
    }

    // The script goes in the project's scratch folder, outside the project;
    // the jail mounts it back for the command (jail/process-jail.ts).
    const tmpDir = statePath(this.workspaceRoot, STATE.tmp);
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const extension = language === 'python' ? 'py' : 'js';
    const fileName = `intp_${randomUUID().slice(0, 8)}.${extension}`;
    const filePath = path.join(tmpDir, fileName);

    // 1. Write the script
    fs.writeFileSync(filePath, code, 'utf-8');

    // 2. Execute via execFile with an argv array — the interpreter and its
    //    arguments are passed directly to the OS, never through a shell, so a
    //    value like `"; rm -rf ~ #` in `args` is an inert string rather than a
    //    second command. (Previously these were string-interpolated into an
    //    `exec` command line.)
    const execArgs = [filePath, ...args];

    // In the jail, when there is one (jail/process-jail.ts). The script lives
    // under .cascade/tmp, which the jail leaves in view.
    const prepared = this.jail
      ? await this.jail.prepare(cmdPrefix, execArgs, { cwd: this.workspaceRoot, offline: options.isOffline?.() === true })
      : undefined;
    if (prepared && !prepared.ok) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
      throw new Error(prepared.reason);
    }
    const launch = prepared?.launch ?? { file: cmdPrefix, args: execArgs, cwd: this.workspaceRoot, env: process.env };

    // 3. Execute
    const output = await new Promise<string>((resolve) => {
      const startMs = Date.now();
      execFile(launch.file, launch.args, { cwd: launch.cwd, env: launch.env, timeout: 30000 }, (error, stdout, stderr) => {
        const duration = Date.now() - startMs;

        // 4. Cleanup (Always delete the script from the filesystem)
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (cleanupErr) {
          console.error(`Failed to cleanup interpreter script ${filePath}:`, cleanupErr);
        }

        if (error) {
          const timedOut = error.killed && duration >= 30000;
          if (timedOut) {
            resolve(`Execution timed out after 30s. Consider breaking the task into smaller pieces.\nPartial stdout: ${stdout}\nStderr: ${stderr}`);
          } else {
            resolve(`Execution failed (${duration}ms):\nError: ${error.message}\nStderr: ${stderr}\nStdout: ${stdout}`);
          }
        } else {
          resolve(`Execution successful (${duration}ms):\nStdout: ${stdout}\nStderr: ${stderr}`);
        }
      });
    });
    const note = await prepared?.launch.done?.();
    return note ? `${output}\n\n[note] ${note}` : output;
  }
}
