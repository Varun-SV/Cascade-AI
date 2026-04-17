import { describe, it, expect } from 'vitest';
import { ShellTool } from './shell.js';

function run(tool: ShellTool, command: string): Promise<string> {
  return tool.execute({ command }, { tierId: 'T3', sessionId: 's' });
}

describe('ShellTool allowlist', () => {
  it('allows exact first-token match', async () => {
    const tool = new ShellTool(['echo']);
    await expect(run(tool, 'echo hello')).resolves.toContain('hello');
  });

  it('rejects prefix-only first-token (npm-foo vs npm)', async () => {
    const tool = new ShellTool(['npm']);
    await expect(run(tool, 'npm-foo install')).rejects.toThrow(/allowlist/i);
  });

  it('rejects commands with shell metacharacters when allowlist active', async () => {
    const tool = new ShellTool(['echo']);
    await expect(run(tool, 'echo hi ; ls')).rejects.toThrow(/metacharacters/i);
    await expect(run(tool, 'echo hi && ls')).rejects.toThrow(/metacharacters/i);
    await expect(run(tool, 'echo $(whoami)')).rejects.toThrow(/metacharacters/i);
    await expect(run(tool, 'echo `whoami`')).rejects.toThrow(/metacharacters/i);
  });

  it('blocks builtin dangerous patterns regardless of allowlist', async () => {
    const tool = new ShellTool();
    await expect(run(tool, 'rm -rf /')).rejects.toThrow(/dangerous/i);
    await expect(run(tool, 'mkfs.ext4 /dev/sda1')).rejects.toThrow(/dangerous/i);
  });

  it('blocks blocklisted substrings case-insensitively', async () => {
    const tool = new ShellTool([], ['SECRET']);
    await expect(run(tool, 'echo $secret')).rejects.toThrow(/blocklist/i);
  });

  it('reports the rejected token in the error message', async () => {
    const tool = new ShellTool(['git']);
    await expect(run(tool, 'gitlab-runner status')).rejects.toThrow(/gitlab-runner/);
  });
});
