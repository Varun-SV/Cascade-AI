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

describe('File tools — reading only what the running tier allows', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-mayread-'));
    await fs.writeFile(path.join(workspace, 'plan.md'), 'the launch plan\n', 'utf-8');
    await fs.writeFile(path.join(workspace, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('file_read asks before reading, and a refusal reads nothing', async () => {
    const tool = new FileReadTool();
    tool.setWorkspaceRoot(workspace);
    const asked: Array<[string, string]> = [];
    const refuse = { ...opts, mayRead: (abs: string, to: 'model' | 'service') => { asked.push([abs, to]); return false; } };
    await expect(tool.execute({ path: 'plan.md' }, refuse as never)).rejects.toThrow(/local-only \(privacy\.paths\)/);
    expect(asked).toEqual([[path.join(workspace, 'plan.md'), 'model']]);
    const allow = { ...opts, mayRead: () => true };
    expect(await tool.execute({ path: 'plan.md' }, allow as never)).toContain('the launch plan');
  });

  it('image_analyze asks about the workspace file it reads — not one beside the process', async () => {
    const { ImageAnalyzeTool } = await import('./image.js');
    const tool = new ImageAnalyzeTool();
    tool.setWorkspaceRoot(workspace);
    const asked: string[] = [];
    const refuse = { ...opts, mayRead: (abs: string) => { asked.push(abs); return false; } };
    await expect(tool.execute({ path: 'shot.png' }, refuse as never)).rejects.toThrow(/local-only/);
    expect(asked).toEqual([path.join(workspace, 'shot.png')]);
    // A relative path resolves in the workspace, as it does for every file tool.
    const out = JSON.parse(await tool.execute({ path: 'shot.png' }, opts as never)) as { attachment: { data: string } };
    expect(out.attachment.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  });
});
