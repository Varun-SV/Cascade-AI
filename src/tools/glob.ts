// ─────────────────────────────────────────────
//  Cascade AI — Glob Tool
// ─────────────────────────────────────────────

import { glob } from 'glob';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { resolveInWorkspace } from './utils/workspace-path.js';
import { statePathFor } from '../config/project-state.js';
import { realPathOf } from '../utils/real-path.js';

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

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const pattern = input['pattern'] as string;
    const given = input['path'] as string | undefined;
    // `@private/…` and `@screenshots/…` lead into the project's state folder,
    // where the registry has let this call in; what is listed stays inside it.
    const searchPath = given ? resolveInWorkspace(this.workspaceRoot, given) : this.workspaceRoot;
    const stateRoot = given ? statePathFor(this.workspaceRoot, given.split(/[\\/]/)[0]!) : null;

    const found = await glob(pattern, {
      cwd: searchPath,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
      nodir: true,
      dot: false,
    });
    // Protected files are not listed, nor is anything a `../` pattern
    // reached outside the workspace — and nor, for a worker that may not
    // read it, is a local-only file.
    const shown = this.listGate(options);
    const matches = found.filter((rel) => {
      const abs = path.resolve(searchPath, rel);
      if (stateRoot) return isWithin(realPathOf(abs), realPathOf(stateRoot));
      return !this.isProtectedPath(abs) && shown(abs, false);
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

/** Whether `p` is `dir` or inside it. */
function isWithin(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
