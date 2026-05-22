// ─────────────────────────────────────────────
//  Cascade AI — Glob Tool
// ─────────────────────────────────────────────

import { glob } from 'glob';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

export class GlobTool extends BaseTool {
  readonly name = 'glob';
  readonly description =
    'Fast file pattern matching. Returns file paths matching a glob pattern, sorted by modification time. Use this to find files by name patterns.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files against, e.g. "**/*.ts", "src/**/*.tsx"',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the workspace root.',
      },
    },
    required: ['pattern'],
  };

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const pattern = input['pattern'] as string;
    const searchPath = (input['path'] as string | undefined)
      ? path.resolve(this.workspaceRoot, input['path'] as string)
      : this.workspaceRoot;

    const matches = await glob(pattern, {
      cwd: searchPath,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
      nodir: true,
      dot: false,
    });

    if (matches.length === 0) {
      return `No files matched pattern: ${pattern}`;
    }

    // Sort by modification time (most recently modified first)
    const withMtime: Array<{ rel: string; mtime: number }> = await Promise.all(
      matches.map(async (rel) => {
        try {
          const stat = await fs.stat(path.join(searchPath, rel));
          return { rel, mtime: stat.mtimeMs };
        } catch {
          return { rel, mtime: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const lines = withMtime.map((f) => f.rel);
    return lines.join('\n');
  }
}
