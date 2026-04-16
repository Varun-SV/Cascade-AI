// ─────────────────────────────────────────────
//  Cascade AI — File Tools
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

// ── File Read ─────────────────────────────────

export class FileReadTool extends BaseTool {
  readonly name = 'file_read';
  readonly description = 'Read the contents of a file. Returns the file content as a string.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
      offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
      limit: { type: 'number', description: 'Maximum number of lines to read' },
    },
    required: ['path'],
  };

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspaceRoot, filePath);
    const offset = (input['offset'] as number | undefined) ?? 1;
    const limit = input['limit'] as number | undefined;

    const content = await fs.readFile(absPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, offset - 1);
    const end = limit ? start + limit : lines.length;
    const sliced = lines.slice(start, end);

    const numbered = sliced.map((line, i) => `${start + i + 1}\t${line}`).join('\n');
    return numbered;
  }
}

// ── File Write ────────────────────────────────

export class FileWriteTool extends BaseTool {
  readonly name = 'file_write';
  readonly description = 'Write content to a file. Creates the file and parent directories if they do not exist. OVERWRITES existing content.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  };

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspaceRoot, filePath);
    const content = input['content'] as string;

    if (options.saveSnapshot) {
      try {
        const oldContent = await fs.readFile(absPath, 'utf-8');
        await options.saveSnapshot(absPath, oldContent);
      } catch {
        // File doesn't exist, nothing to snapshot for rollback (delete on rollback)
      }
    }

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
    return `Written ${content.length} characters to ${filePath}`;
  }
}

// ── File Edit ─────────────────────────────────

export class FileEditTool extends BaseTool {
  readonly name = 'file_edit';
  readonly description = 'Replace a specific string in a file with a new string. The old_string must match exactly.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'The exact string to find and replace' },
      new_string: { type: 'string', description: 'The replacement string' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  };

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspaceRoot, filePath);
    const oldString = input['old_string'] as string;
    const newString = input['new_string'] as string;
    const replaceAll = (input['replace_all'] as boolean | undefined) ?? false;

    const rawContent = await fs.readFile(absPath, 'utf-8');

    if (options.saveSnapshot) {
      await options.saveSnapshot(absPath, rawContent);
    }

    // Normalize CRLF → LF so edits work on Windows-formatted files transparently.
    const content = rawContent.replace(/\r\n/g, '\n');
    const normalizedOld = oldString.replace(/\r\n/g, '\n');

    if (!content.includes(normalizedOld)) {
      throw new Error(
        `old_string not found in ${filePath}. Make sure to match exactly (line endings are normalized to LF).`,
      );
    }

    const updated = replaceAll
      ? content.split(normalizedOld).join(newString)
      : content.replace(normalizedOld, newString);

    await fs.writeFile(absPath, updated, 'utf-8');
    const count = replaceAll ? (content.split(normalizedOld).length - 1) : 1;
    return `Replaced ${count} occurrence(s) in ${filePath}`;
  }
}

// ── File Delete ───────────────────────────────

export class FileDeleteTool extends BaseTool {
  readonly name = 'file_delete';
  readonly description = 'Delete a file or empty directory.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to delete' },
    },
    required: ['path'],
  };

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspaceRoot, filePath);
    
    if (options.saveSnapshot) {
      try {
        const oldContent = await fs.readFile(absPath, 'utf-8');
        await options.saveSnapshot(absPath, oldContent);
      } catch {
        // Already gone or dir
      }
    }

    await fs.rm(absPath, { recursive: false });
    return `Deleted ${filePath}`;
  }
}

// ── File List ─────────────────────────────────

export class FileListTool extends BaseTool {
  readonly name = 'file_list';
  readonly description = 'List files and directories in a given path. Returns a list of filenames.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to list (relative to workspace root)' },
    },
    required: ['path'],
  };

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const inputPath = (input['path'] as string) || '.';
    const absPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(this.workspaceRoot, inputPath);

    const entries = await fs.readdir(absPath, { withFileTypes: true });
    return entries.map(e => `${e.isDirectory() ? '[DIR] ' : '      '}${e.name}`).join('\n') || '(empty directory)';
  }
}
