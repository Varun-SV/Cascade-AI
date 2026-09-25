import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileReadTool, FileWriteTool, FileDeleteTool, FileEditTool } from './file.js';

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

  // The desktop app and the server do not run in the workspace, so a PDF
  // written relative to the process landed somewhere no check was looking.
  it('pdf_create writes into the workspace, not where the process runs', async () => {
    const { PDFCreateTool } = await import('./pdf.js');
    const tool = new PDFCreateTool();
    tool.setWorkspaceRoot(workspace);
    const name = `cascade-pdf-${process.pid}.pdf`;
    await tool.execute({ path: `out/${name}`, content: 'hello' }, opts);
    expect((await fs.stat(path.join(workspace, 'out', name))).size).toBeGreaterThan(0);
    await expect(fs.stat(path.join(process.cwd(), 'out', name))).rejects.toThrow();
    await expect(tool.execute({ path: '../escape.pdf', content: 'x' }, opts)).rejects.toThrow(/workspace/i);
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

  // An edit's answer — "not found", or how many it replaced — says what the
  // file holds, so a no-op edit was a way to probe one a read may not see.
  it('file_edit asks before reading, and a refusal says nothing about the file', async () => {
    const tool = new FileEditTool();
    tool.setWorkspaceRoot(workspace);
    const refuse = { ...opts, mayRead: () => false };
    for (const probe of ['launch', 'no such text']) {
      await expect(
        tool.execute({ path: 'plan.md', old_string: probe, new_string: probe }, refuse as never),
      ).rejects.toThrow(/local-only \(privacy\.paths\)/);
    }
    const allow = { ...opts, mayRead: () => true };
    expect(await tool.execute({ path: 'plan.md', old_string: 'launch', new_string: 'launch' }, allow as never))
      .toContain('Replaced 1');
  });

  // Between context groups rg prints a bare `--`, which names no file; kept
  // beside groups that were all left out, it said the file had matched.
  it('grep with context leaves no trace of a file it left out', async () => {
    const { GrepTool } = await import('./grep.js');
    await fs.writeFile(path.join(workspace, 'secret.md'), 'MARK one\nx\nx\nx\nx\nMARK two\n');
    await fs.writeFile(path.join(workspace, 'public.md'), 'nothing here\n');
    const tool = new GrepTool();
    tool.setWorkspaceRoot(workspace);
    const scan = { ...opts, mayRead: (abs: string) => !abs.endsWith('secret.md') };
    expect(await tool.execute({ pattern: 'MARK', context: 1 }, scan as never)).toBe('No matches found for: MARK');
    await fs.writeFile(path.join(workspace, 'public.md'), 'MARK a\nx\nx\nx\nx\nMARK b\n');
    const out = await tool.execute({ pattern: 'MARK', context: 1 }, scan as never);
    expect(out).toContain('MARK a');
    expect(out).not.toContain('MARK one');
    expect(out.trim().startsWith('--')).toBe(false);
    expect(out.trim().endsWith('--')).toBe(false);
    // One between public.md's two groups where ripgrep prints them; none
    // where the Node fallback searches, which prints no separators at all.
    expect(out.split('\n').filter((l) => l === '--').length).toBeLessThanOrEqual(1);
  });

  // A path can hold a newline. Split into lines first, the part after it
  // passed for the path — a public one — and the file's lines came back.
  it.skipIf(process.platform === 'win32')('grep reads each path whole, a newline in it included', async () => {
    const { GrepTool } = await import('./grep.js');
    await fs.mkdir(path.join(workspace, 'secret'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'secret', 'a\nb.md'), 'SECRET-LOCAL line\n');
    await fs.writeFile(path.join(workspace, 'b.md'), 'public\n');
    const tool = new GrepTool();
    tool.setWorkspaceRoot(workspace);
    const scan = { ...opts, mayRead: (abs: string) => !abs.includes(`${path.sep}secret${path.sep}`) };
    for (const mode of ['content', 'count']) {
      const out = await tool.execute({ pattern: 'SECRET', output_mode: mode }, scan as never);
      expect(out).not.toContain('SECRET-LOCAL');
      expect(out).not.toMatch(/b\.md:1/);
    }
  });

  // A name ending in a space was trimmed before the check, so the check was
  // of another name — one nothing marked — and the real one was listed.
  it.skipIf(process.platform === 'win32')('grep lists a file by its exact name, a trailing space included', async () => {
    const { GrepTool } = await import('./grep.js');
    await fs.writeFile(path.join(workspace, 'private-name '), 'MARK\n');
    const tool = new GrepTool();
    tool.setWorkspaceRoot(workspace);
    const scan = { ...opts, mayRead: (abs: string) => !abs.endsWith('private-name ') };
    const out = await tool.execute({ pattern: 'MARK', output_mode: 'files_with_matches' }, scan as never);
    expect(out).not.toContain('private-name');
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

describe('File tools — a workspace opened through a symlink', () => {
  // The real paths of its files all lie under the root's real path, which the
  // check compared against the name the workspace was opened by — so every
  // file in it looked like an escape.
  let real: string;
  let link: string;

  beforeEach(async () => {
    real = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-real-'));
    link = `${real}-link`;
    await fs.symlink(real, link);
    await fs.writeFile(path.join(real, 'hello.txt'), 'hi through a link\n', 'utf-8');
    await fs.writeFile(path.join(real, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(async () => {
    await fs.rm(link, { force: true });
    await fs.rm(real, { recursive: true, force: true });
  });

  it('reads its files, and still refuses a way out of it', async () => {
    const tool = new FileReadTool();
    tool.setWorkspaceRoot(link);
    expect(await tool.execute({ path: 'hello.txt' }, opts)).toContain('hi through a link');
    const outside = path.join(os.tmpdir(), `cascade-outside-${path.basename(real)}.txt`);
    await fs.writeFile(outside, 'not yours', 'utf-8');
    await fs.symlink(outside, path.join(real, 'out'));
    await expect(tool.execute({ path: 'out' }, opts)).rejects.toThrow(/workspace/i);
    await fs.rm(outside, { force: true });
  });

  it('lets image_analyze read an image in it', async () => {
    const { ImageAnalyzeTool } = await import('./image.js');
    const tool = new ImageAnalyzeTool();
    tool.setWorkspaceRoot(link);
    const out = JSON.parse(await tool.execute({ path: 'shot.png' }, opts as never)) as { attachment: { data: string } };
    expect(out.attachment.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  });
});
