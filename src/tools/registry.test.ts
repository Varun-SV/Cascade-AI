import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolRegistry } from './registry.js';

const toolsConfig = {
  shellAllowlist: [],
  shellBlocklist: [],
  requireApprovalFor: [],
  globalMcpServers: [],
  mcpServers: [],
  customTools: [],
} as unknown as Parameters<typeof ToolRegistry>[0];

const opts = { tierId: 'T3', sessionId: 's' };

describe('ToolRegistry .cascadeignore', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-reg-'));
    await fs.writeFile(path.join(workspace, 'safe.txt'), 'ok', 'utf-8');
    await fs.mkdir(path.join(workspace, 'node_modules'));
    await fs.writeFile(path.join(workspace, 'node_modules', 'pkg.txt'), 'private', 'utf-8');
    await fs.writeFile(path.join(workspace, 'mynodemodules.js'), 'unrelated', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('blocks paths inside ignored directories', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['node_modules/']);
    await expect(
      reg.execute('file_read', { path: 'node_modules/pkg.txt' }, opts),
    ).rejects.toThrow(/cascadeignore/);
  });

  it('does NOT match ignored pattern by substring — the old bug', async () => {
    // Before the fix, this path would be blocked because `node_modules` is a
    // substring of "mynodemodules.js". With gitignore semantics it is allowed.
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['node_modules/']);
    const result = await reg.execute('file_read', { path: 'mynodemodules.js' }, opts);
    expect(result).toContain('unrelated');
  });

  it('blocks paths that escape the workspace root', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    await expect(
      reg.execute('file_read', { path: '../../etc/passwd' }, opts),
    ).rejects.toThrow();
  });

  it('allows regular workspace files when no patterns match', async () => {
    const reg = new ToolRegistry(toolsConfig, workspace);
    const result = await reg.execute('file_read', { path: 'safe.txt' }, opts);
    expect(result).toContain('ok');
  });

  it('respects negation patterns (gitignore semantics)', async () => {
    await fs.mkdir(path.join(workspace, 'build'));
    await fs.writeFile(path.join(workspace, 'build', 'keep.txt'), 'keep', 'utf-8');
    await fs.writeFile(path.join(workspace, 'build', 'skip.txt'), 'skip', 'utf-8');
    const reg = new ToolRegistry(toolsConfig, workspace);
    reg.setIgnoredPaths(['build/*', '!build/keep.txt']);
    await expect(
      reg.execute('file_read', { path: 'build/skip.txt' }, opts),
    ).rejects.toThrow(/cascadeignore/);
    const kept = await reg.execute('file_read', { path: 'build/keep.txt' }, opts);
    expect(kept).toContain('keep');
  });
});
