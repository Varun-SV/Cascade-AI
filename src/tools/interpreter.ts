// ─────────────────────────────────────────────
//  Cascade AI — Code Interpreter Tool
// ─────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

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

    // Setup temporary directory structure in .cascade/tmp
    const tmpDir = path.join(process.cwd(), '.cascade', 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const extension = language === 'python' ? 'py' : 'js';
    const fileName = `intp_${randomUUID().slice(0, 8)}.${extension}`;
    const filePath = path.join(tmpDir, fileName);

    // 1. Write the script
    fs.writeFileSync(filePath, code, 'utf-8');

    // 2. Prepare command
    const cmdPrefix = language === 'python' ? 'python3' : 'node';
    const fullCmd = `${cmdPrefix} "${filePath}" ${args.map(a => `"${a}"`).join(' ')}`;

    // 3. Execute
    return new Promise((resolve) => {
      const startMs = Date.now();
      exec(fullCmd, { cwd: process.cwd(), timeout: 30000 }, (error, stdout, stderr) => {
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
          resolve(`Execution failed (${duration}ms):\nError: ${error.message}\nStderr: ${stderr}\nStdout: ${stdout}`);
        } else {
          resolve(`Execution successful (${duration}ms):\nStdout: ${stdout}\nStderr: ${stderr}`);
        }
      });
    });
  }
}
