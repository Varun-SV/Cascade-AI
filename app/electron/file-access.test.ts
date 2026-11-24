import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insideWorkspace, isRunnable } from './file-access.js';

let base: string;
let ws: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'file-access-'));
  ws = join(base, 'ws');
  await mkdir(join(ws, 'generated'), { recursive: true });
  await writeFile(join(ws, 'generated', 'a.png'), 'x');
  await writeFile(join(base, 'outside.png'), 'x');
  await symlink(join(base, 'outside.png'), join(ws, 'link.png'));
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe('preview file access', () => {
  it('allows files inside the workspace', async () => {
    expect(await insideWorkspace(ws, join(ws, 'generated', 'a.png'))).toBe(true);
    expect(await insideWorkspace(ws, ws)).toBe(true);
  });

  it('refuses files outside it, by path or through a link', async () => {
    expect(await insideWorkspace(ws, join(base, 'outside.png'))).toBe(false);
    expect(await insideWorkspace(ws, join(ws, '..', 'outside.png'))).toBe(false);
    expect(await insideWorkspace(ws, join(ws, 'link.png'))).toBe(false);
    expect(await insideWorkspace('', join(ws, 'generated', 'a.png'))).toBe(false);
  });

  it('never hands a program or script to the OS to open', () => {
    for (const f of ['setup.exe', 'run.BAT', 'x.cmd', 'a.ps1', 'b.sh', 'c.vbs', 'd.lnk', 'App.app', 'i.msi', 'k.jar']) {
      expect(isRunnable(f), f).toBe(true);
    }
    for (const f of ['report.docx', 'data.xlsx', 'archive.zip', 'book.epub', 'photo.png']) {
      expect(isRunnable(f), f).toBe(false);
    }
  });
});
