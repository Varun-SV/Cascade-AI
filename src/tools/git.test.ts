import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGit = {
  status: vi.fn(),
  diff: vi.fn(),
  log: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
  branch: vi.fn(),
  checkout: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  stash: vi.fn(),
};

vi.mock('simple-git', () => ({
  simpleGit: () => mockGit,
}));

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitTool } from './git.js';

const opts = { tierId: 'T3', sessionId: 's' };

describe('GitTool', () => {
  beforeEach(() => {
    for (const fn of Object.values(mockGit)) fn.mockReset();
  });

  it('flags git operations as dangerous so approval is required upstream', () => {
    const tool = new GitTool();
    expect(tool.isDangerous()).toBe(true);
  });

  it('passes push args through to simple-git — approval gate is the registry job', async () => {
    mockGit.push.mockResolvedValue({});
    const tool = new GitTool();
    await tool.execute({ operation: 'push', args: ['origin', 'main', '--force'] }, opts);
    expect(mockGit.push).toHaveBeenCalledWith(['origin', 'main', '--force']);
  });

  it('surfaces simple-git errors verbatim', async () => {
    mockGit.push.mockRejectedValue(new Error('permission denied'));
    const tool = new GitTool();
    await expect(
      tool.execute({ operation: 'push', args: [] }, opts),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects unknown operations', async () => {
    const tool = new GitTool();
    await expect(
      tool.execute({ operation: 'rebase', args: [] }, opts),
    ).rejects.toThrow(/Unknown git operation/);
  });

  it('formats status output for humans', async () => {
    mockGit.status.mockResolvedValue({
      current: 'main',
      staged: ['a.ts'],
      modified: ['b.ts'],
      not_added: [],
      deleted: [],
      conflicted: [],
    });
    const tool = new GitTool();
    const out = await tool.execute({ operation: 'status' }, opts);
    expect(out).toContain('Branch: main');
    expect(out).toContain('Staged: a.ts');
  });
});

// The git tool keeps the home credentials in view for pushing, and runs even
// where no jail hides anything (Windows). git diff compares any two files
// with --no-index — or on its own, given a path outside the work tree — so
// the tool must decide what a diff may read, not the jail.
describe('GitTool — what a diff may read', () => {
  let ws: string;
  let outside: string;

  beforeEach(async () => {
    for (const fn of Object.values(mockGit)) fn.mockReset();
    mockGit.diff.mockResolvedValue('diff');
    ws = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cascade-gitdiff-ws-')));
    outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cascade-gitdiff-home-')));
    await fsp.mkdir(path.join(outside, '.ssh'));
    await fsp.writeFile(path.join(outside, '.ssh', 'id_rsa'), 'KEY');
    await fsp.writeFile(path.join(ws, 'a.md'), 'a');
    await fsp.writeFile(path.join(ws, 'b.md'), 'b');
    await fsp.writeFile(path.join(ws, '.env'), 'SECRET=1');
    await fsp.mkdir(path.join(ws, 'secret'));
    await fsp.writeFile(path.join(ws, 'secret', 'plan.md'), 'private');
    await fsp.symlink(path.join(outside, '.ssh', 'id_rsa'), path.join(ws, 'key-link'));
  });

  function tool() {
    const t = new GitTool();
    t.setWorkspaceRoot(ws);
    t.setPathGuard((abs) => path.basename(abs) === '.env');
    return t;
  }
  const diff = (args: string[], extra: Record<string, unknown> = {}) =>
    tool().execute({ operation: 'diff', args, ...extra }, { ...opts, mayRead: (abs: string) => !abs.includes(`${path.sep}secret`) });

  it('refuses a file outside the workspace, with --no-index or without it', async () => {
    const key = path.join(outside, '.ssh', 'id_rsa');
    await expect(diff(['--no-index', '/dev/null', key])).rejects.toThrow(/cannot compare .* outside the workspace/);
    await expect(diff(['/dev/null', key])).rejects.toThrow(/outside the workspace/);
    await expect(diff(['--no-index', '--', '/dev/null', key])).rejects.toThrow(/outside the workspace/);
    // A link in the workspace to it is the same file.
    await expect(diff(['--no-index', '/dev/null', 'key-link'])).rejects.toThrow(/outside the workspace/);
    expect(mockGit.diff).not.toHaveBeenCalled();
  });

  it('refuses a protected file, and one this call may not read', async () => {
    await expect(diff(['--no-index', '/dev/null', '.env'])).rejects.toThrow(/cannot compare \.env: it is protected/);
    await expect(diff(['--no-index', 'a.md', 'secret/plan.md'])).rejects.toThrow(/cannot compare secret\/plan\.md: it is protected/);
    expect(mockGit.diff).not.toHaveBeenCalled();
  });

  it('refuses --output, which writes a file', async () => {
    await expect(diff(['--output', path.join(outside, 'x'), 'HEAD'])).rejects.toThrow(/--output is not allowed/);
    await expect(diff([`--output=${path.join(outside, 'x')}`])).rejects.toThrow(/--output is not allowed/);
    expect(mockGit.diff).not.toHaveBeenCalled();
  });

  it('runs nowhere but the workspace', async () => {
    await expect(diff(['a', 'b'], { cwd: outside })).rejects.toThrow(/outside workspace root/);
    expect(mockGit.diff).not.toHaveBeenCalled();
  });

  it('still compares workspace files, and revisions and pathspecs as before', async () => {
    await diff(['--no-index', 'a.md', 'b.md']);
    await diff(['HEAD~1', '--', 'a.md', 'not-there-yet.md']);
    expect(mockGit.diff).toHaveBeenNthCalledWith(1, ['--no-index', 'a.md', 'b.md']);
    expect(mockGit.diff).toHaveBeenNthCalledWith(2, ['HEAD~1', '--', 'a.md', 'not-there-yet.md']);
  });
});
