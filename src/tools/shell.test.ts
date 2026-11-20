import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellTool, stopsCascade } from './shell.js';

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

  it('blocks dangerous variants (reversed flags, extra whitespace, fork bomb)', async () => {
    const tool = new ShellTool();
    await expect(run(tool, 'rm -fr  ~')).rejects.toThrow(/dangerous/i);
    await expect(run(tool, 'rm  -rf  /')).rejects.toThrow(/dangerous/i);
    await expect(run(tool, ':(){ :|:& };:')).rejects.toThrow(/dangerous/i);
  });

  it('does not block benign relative deletes', async () => {
    const tool = new ShellTool(['rm']);
    // Targets a relative path, not / ~ or $HOME — should pass validation.
    await expect(run(tool, 'rm -rf ./does-not-exist-xyz')).resolves.toBeDefined();
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

describe('ShellTool — stopping', () => {
  it('stops a running command when its call is cancelled', async () => {
    const tool = new ShellTool();
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 100);
    await tool.execute({ command: 'sleep 5' }, { tierId: 'T3', sessionId: 's', signal: stop.signal } as never).catch(() => 'stopped');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.skipIf(process.platform === 'win32')("a command's own interrupt never reaches Cascade: it runs in a process group of its own", async () => {
    let interrupted = 0;
    const onInt = () => { interrupted += 1; };
    process.on('SIGINT', onInt);
    try {
      // kill 0 signals the whole process group the command is in.
      await new ShellTool().execute({ command: 'kill -INT 0; sleep 0.2; echo after' }, { tierId: 'T3', sessionId: 's' } as never);
      await new Promise((r) => setTimeout(r, 200));
      expect(interrupted).toBe(0);
    } finally { process.off('SIGINT', onInt); }
  });

  it.skipIf(process.platform === 'win32')('a timeout stops the command and everything it started', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-tree-'));
    const marker = path.join(dir, 'still-running');
    const started = Date.now();
    const out = await new ShellTool().execute({ command: `(sleep 1; touch ${marker}) & sleep 30`, timeout: 300 }, { tierId: 'T3', sessionId: 's' } as never);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out).toMatch(/stopped after 0s: it timed out/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a command that waits for input gets end-of-input rather than hanging', async () => {
    const started = Date.now();
    await new ShellTool().execute({ command: process.platform === 'win32' ? 'more' : 'cat', timeout: 10_000 }, { tierId: 'T3', sessionId: 's' } as never);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('stopsCascade: commands that would end Cascade itself', () => {
  it('by its program name, on Windows and POSIX', () => {
    for (const c of [
      'taskkill /F /IM node.exe', 'taskkill /im node.exe /t /f', 'TASKKILL /IM "node.exe" /F',
      'Stop-Process -Name node -Force', 'Get-Process node | Stop-Process', 'spps -Name node',
      'pkill node', 'pkill -9 node', 'killall node', 'killall -q nodejs',
      "wmic process where name='node.exe' delete",
    ]) expect(stopsCascade(c), c).toBe(true);
  });
  it('by its own or its parent\'s process id', () => {
    expect(stopsCascade('kill -9 4242', [4242, 77])).toBe(true);
    expect(stopsCascade('taskkill /PID 77 /F', [4242, 77])).toBe(true);
    expect(stopsCascade('Stop-Process -Id 4242', [4242, 77])).toBe(true);
  });
  it('but not another program, another pid, or a word that only looks like it', () => {
    for (const c of [
      'taskkill /IM python.exe /F', 'pkill -f uvicorn', 'kill 12345', 'taskkill /PID 999 /F',
      'node server.js', 'npm run kill-port', 'kill %1', 'npx kill-port 3000',
    ]) expect(stopsCascade(c, [4242, 77]), c).toBe(false);
  });
  it('reads a long command in linear time (CodeQL on 53bc237)', () => {
    const t = Date.now();
    expect(stopsCascade(`pkill${' -- --'.repeat(50_000)}x`, [4242, 77])).toBe(false);
    expect(stopsCascade(`pkill${' -9'.repeat(20_000)} node`, [4242, 77])).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('is refused before it runs, with a way to do what was meant', async () => {
    await expect(new ShellTool().execute({ command: 'taskkill /F /IM node.exe' }, { tierId: 'T3', sessionId: 's' } as never))
      .rejects.toThrow(/would stop Cascade itself.*by its own process id, or by the port/);
  });
});
