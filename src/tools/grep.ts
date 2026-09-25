// ─────────────────────────────────────────────
//  Cascade AI — Grep Tool
// ─────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { WithheldError } from './file.js';

const execFileAsync = promisify(execFile);

export class GrepTool extends BaseTool {
  readonly name = 'grep';
  readonly description =
    'Search file contents using a regex pattern. Returns matching lines with file paths and line numbers. Tries ripgrep (rg) first, falls back to Node.js regex scan.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for in file contents',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in. Defaults to workspace root.',
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files, e.g. "*.ts", "**/*.tsx"',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description:
          '"content" shows matching lines (default), "files_with_matches" shows file paths only, "count" shows match counts',
      },
      context: {
        type: 'number',
        description: 'Lines of context around each match (content mode only). Default: 0.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case-insensitive search. Default: false.',
      },
    },
    required: ['pattern'],
  };

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const pattern = input['pattern'] as string;
    const searchPath = (input['path'] as string | undefined)
      ? path.resolve(this.workspaceRoot, input['path'] as string)
      : this.workspaceRoot;
    const globPattern = input['glob'] as string | undefined;
    const outputMode = (input['output_mode'] as string | undefined) ?? 'content';
    const context = (input['context'] as number | undefined) ?? 0;
    const caseInsensitive = (input['case_insensitive'] as boolean | undefined) ?? false;
    // Searching a file is reading it: whether it matched says something
    // about what it holds. A file the search names is asked about before the
    // search, as a read would be; files it comes across in a folder are
    // searched only where that changes nothing about the caller ('scan') —
    // a local-only one is left out for a caller that is not local-only.
    let mayRead = this.readGate(options, 'scan');
    try {
      if ((input['path'] as string | undefined) && (await fs.stat(searchPath)).isFile()) {
        const named = this.readGate(options, 'model');
        if (!this.isProtectedPath(searchPath) && !named(searchPath)) {
          throw new WithheldError(input['path'] as string);
        }
        mayRead = named;
      }
    } catch (err) {
      if (err instanceof WithheldError) throw err;
    }

    // Try ripgrep first
    try {
      const result = await this.runRipgrep(
        pattern,
        searchPath,
        globPattern,
        outputMode,
        context,
        caseInsensitive,
        mayRead,
      );
      return result;
    } catch {
      // ripgrep not available — fall back to Node.js scan
    }

    return this.nodeScan(pattern, searchPath, globPattern, outputMode, context, caseInsensitive, mayRead);
  }

  private async runRipgrep(
    pattern: string,
    searchPath: string,
    globPattern: string | undefined,
    outputMode: string,
    context: number,
    caseInsensitive: boolean,
    mayRead: (absPath: string) => boolean,
  ): Promise<string> {
    const args: string[] = ['--no-heading'];
    if (caseInsensitive) args.push('-i');
    if (outputMode === 'files_with_matches') args.push('-l');
    else if (outputMode === 'count') args.push('-c');
    else {
      args.push('-n'); // line numbers
      if (context > 0) args.push(`-C${context}`);
    }
    if (globPattern) args.push('--glob', globPattern);
    // Every line names its file — even when the search is one file, which rg
    // would otherwise leave unnamed — with a NUL after it, so a path can be
    // told from what follows it even when it contains a colon, and a file's
    // lines dropped when it is protected or its contents are withheld.
    // An absolute path, so no name printed can begin like a `--` separator.
    args.push('--with-filename', '--null', '--', pattern, path.resolve(searchPath));

    const { stdout } = await execFileAsync('rg', args, {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    const allowed = (file: string): boolean => {
      const abs = path.resolve(searchPath, file);
      return !this.isProtectedPath(abs) && mayRead(abs);
    };
    let lines: string[];
    if (outputMode === 'files_with_matches') {
      lines = stdout.split('\0').map((file) => file.trim()).filter((file) => file && allowed(file));
    } else {
      lines = [];
      // A `--` between context groups is kept only between two groups that
      // are shown: one beside a file left out would say it had matches.
      let separate = false;
      // Each record is a path, a NUL, and the rest of its line. A path may
      // hold a newline itself, so it is read up to its NUL — not split off
      // a line — or the part after the newline would pass for the path.
      let at = 0;
      while (at < stdout.length) {
        if (stdout.startsWith('--\n', at) || stdout.slice(at) === '--') {
          separate = lines.length > 0;
          at += 3;
          continue;
        }
        const nul = stdout.indexOf('\0', at);
        if (nul === -1) break;
        const file = stdout.slice(at, nul);
        const end = stdout.indexOf('\n', nul);
        const rest = stdout.slice(nul + 1, end === -1 ? stdout.length : end);
        at = end === -1 ? stdout.length : end + 1;
        if (!allowed(file)) continue;
        if (separate) {
          lines.push('--');
          separate = false;
        }
        // rg's own layout: `file:12:match`, `file-13-context`, `file:3` for a count.
        lines.push(`${file}${/^\d+-/.test(rest) ? '-' : ':'}${rest}`);
      }
    }

    const trimmed = lines.join('\n').trim();
    return trimmed || `No matches found for: ${pattern}`;
  }

  private async nodeScan(
    pattern: string,
    searchPath: string,
    globPattern: string | undefined,
    outputMode: string,
    context: number,
    caseInsensitive: boolean,
    mayRead: (absPath: string) => boolean,
  ): Promise<string> {
    const flags = caseInsensitive ? 'gi' : 'g';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      return `Invalid regex pattern: ${pattern}`;
    }

    const fileGlob = globPattern ?? '**/*';
    let files: string[];
    try {
      files = await glob(fileGlob, {
        cwd: searchPath,
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
        nodir: true,
      });
    } catch {
      // If searchPath is a single file
      files = [path.relative(searchPath, searchPath) || '.'];
    }

    const results: string[] = [];
    let totalCount = 0;

    for (const rel of files) {
      const abs = path.join(searchPath, rel);
      if (this.isProtectedPath(abs) || !mayRead(abs)) continue;
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      const matchingLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) matchingLines.push(i);
        regex.lastIndex = 0;
      }

      if (matchingLines.length === 0) continue;
      totalCount += matchingLines.length;

      if (outputMode === 'files_with_matches') {
        results.push(rel);
      } else if (outputMode === 'count') {
        results.push(`${rel}: ${matchingLines.length}`);
      } else {
        const shown = new Set<number>();
        for (const lineIdx of matchingLines) {
          const start = Math.max(0, lineIdx - context);
          const end = Math.min(lines.length - 1, lineIdx + context);
          for (let i = start; i <= end; i++) shown.add(i);
        }
        const sortedIdxs = [...shown].sort((a, b) => a - b);
        for (const i of sortedIdxs) {
          const marker = matchingLines.includes(i) ? ':' : '-';
          results.push(`${rel}:${i + 1}${marker}${lines[i]}`);
        }
      }
    }

    if (results.length === 0) return `No matches found for: ${pattern}`;
    if (outputMode === 'count') {
      results.push(`\nTotal: ${totalCount} matches`);
    }
    return results.join('\n');
  }
}
