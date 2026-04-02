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
    const offset = (input['offset'] as number | undefined) ?? 1;
    const limit = input['limit'] as number | undefined;

    const content = await fs.readFile(filePath, 'utf-8');
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

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    const content = input['content'] as string;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
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

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    const oldString = input['old_string'] as string;
    const newString = input['new_string'] as string;
    const replaceAll = (input['replace_all'] as boolean | undefined) ?? false;

    const content = await fs.readFile(filePath, 'utf-8');

    if (!content.includes(oldString)) {
      throw new Error(`old_string not found in ${filePath}. Make sure to match exactly.`);
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    await fs.writeFile(filePath, updated, 'utf-8');
    const count = replaceAll ? (content.split(oldString).length - 1) : 1;
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

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    await fs.rm(filePath, { recursive: false });
    return `Deleted ${filePath}`;
  }
}
