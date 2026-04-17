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
