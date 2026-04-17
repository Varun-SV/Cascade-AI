import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileReadTool, FileWriteTool, FileDeleteTool } from './file.js';

const opts = { tierId: 'T3', sessionId: 's' };

describe('File tools — path sandbox', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-file-'));
    await fs.writeFile(path.join(workspace, 'hello.txt'), 'hi there\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('FileReadTool reads files inside the workspace', async () => {
    const tool = new FileReadTool();
    tool.setWorkspaceRoot(workspace);
    const out = await tool.execute({ path: 'hello.txt' }, opts);
    expect(out).toContain('hi there');
  });

  it('FileReadTool rejects ../ traversal', async () => {
    const tool = new FileReadTool();
    tool.setWorkspaceRoot(workspace);
    await expect(tool.execute({ path: '../../etc/passwd' }, opts)).rejects.toThrow(/workspace/i);
  });

  it('FileReadTool rejects absolute paths outside workspace', async () => {
    const tool = new FileReadTool();
    tool.setWorkspaceRoot(workspace);
    await expect(tool.execute({ path: '/etc/passwd' }, opts)).rejects.toThrow(/workspace/i);
  });

  it('FileWriteTool writes inside the workspace and refuses escapes', async () => {
    const tool = new FileWriteTool();
    tool.setWorkspaceRoot(workspace);
    await tool.execute({ path: 'out/x.txt', content: 'ok' }, opts);
    const written = await fs.readFile(path.join(workspace, 'out', 'x.txt'), 'utf-8');
    expect(written).toBe('ok');

    await expect(
      tool.execute({ path: '../escape.txt', content: 'nope' }, opts),
    ).rejects.toThrow(/workspace/i);
  });

  it('FileDeleteTool refuses escapes', async () => {
    const tool = new FileDeleteTool();
    tool.setWorkspaceRoot(workspace);
    await expect(tool.execute({ path: '../hello.txt' }, opts)).rejects.toThrow(/workspace/i);
  });
});
