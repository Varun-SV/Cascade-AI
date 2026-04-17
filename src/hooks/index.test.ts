import { describe, it, expect } from 'vitest';
import { HooksRunner } from './index.js';

// These tests run real child processes. They're POSIX-only. Skip on Windows
// because cmd.exe has different semantics for the shell injection pattern.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('HooksRunner env-var shell injection', () => {
  it('neutralizes $(command) payloads that arrive via env vars', async () => {
    const runner = new HooksRunner({
      preTask: [{
        name: 'echo-prompt',
        command: 'echo "prompt=$CASCADE_PROMPT"',
      }],
    });
    // If values were interpolated into the command string, `$(whoami)` would
    // execute and leak the current user. With execFile + env-only the literal
    // text round-trips instead.
    const result = await runner.runPreTask('hello $(whoami)');
    expect(result.success).toBe(true);
    expect(result.output).toContain('$(whoami)');
    expect(result.output).not.toMatch(/^prompt=hello [a-z0-9_]+$/m);
  });

  it('strips control characters from env values', async () => {
    const runner = new HooksRunner({
      preTask: [{
        name: 'echo-prompt',
        command: 'printf "%s" "$CASCADE_PROMPT"',
      }],
    });
    const result = await runner.runPreTask('line1\nline2\x00tail');
    expect(result.success).toBe(true);
    // \n and \x00 both get replaced with a single space
    expect(result.output).toBe('line1 line2 tail');
  });

  it('reports errors when the hook exits non-zero', async () => {
    const runner = new HooksRunner({
      preTask: [{ name: 'fail', command: 'exit 7' }],
    });
    const result = await runner.runPreTask('anything');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('runs hooks in order and concatenates output', async () => {
    const runner = new HooksRunner({
      preTask: [
        { name: 'a', command: 'echo one' },
        { name: 'b', command: 'echo two' },
      ],
    });
    const result = await runner.runPreTask('anything');
    expect(result.success).toBe(true);
    expect(result.output.split('\n')).toEqual(['one', 'two']);
  });
});
