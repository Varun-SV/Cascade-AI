import { describe, it, expect, vi } from 'vitest';
import { restoreTerminal } from './terminal.js';

function ttyStdin() {
  return { isTTY: true, setRawMode: vi.fn() };
}
function ttyStdout() {
  return { isTTY: true, write: vi.fn() };
}

describe('restoreTerminal', () => {
  it('takes stdin back out of raw mode', () => {
    // The whole point. Ink puts stdin into raw mode to read keystrokes and
    // restores it on a clean unmount; a crash skips that, and the shell that
    // inherits the terminal has no echo and no line editing — which reads as a
    // stuck modifier key rather than as a dead program.
    const stdin = ttyStdin();
    restoreTerminal(stdin, ttyStdout());
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  it('shows the cursor again', () => {
    const stdout = ttyStdout();
    restoreTerminal(ttyStdin(), stdout);
    expect(stdout.write).toHaveBeenCalledWith('\x1b[?25h');
  });

  it('does nothing to a stdin that was never a tty', () => {
    // A piped or redirected stdin has no raw mode to leave, and calling into
    // it would throw on the way out of an already-failing process.
    const stdin = { isTTY: false, setRawMode: vi.fn() };
    restoreTerminal(stdin, ttyStdout());
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });

  it('writes no escape sequence into a redirected stdout', () => {
    // Otherwise a `cascade -p … > out.txt` ends with a stray control sequence
    // in the file.
    const stdout = { isTTY: false, write: vi.fn() };
    restoreTerminal(ttyStdin(), stdout);
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it('survives a stdin with no setRawMode at all', () => {
    expect(() => restoreTerminal({ isTTY: true }, ttyStdout())).not.toThrow();
  });

  it('still shows the cursor when leaving raw mode throws', () => {
    // Runs while the process may already be dying, so one failing step must
    // not skip the next — and must not replace the real error with its own.
    const stdin = {
      isTTY: true,
      setRawMode: vi.fn(() => { throw new Error('tty is gone'); }),
    };
    const stdout = ttyStdout();
    expect(() => restoreTerminal(stdin, stdout)).not.toThrow();
    expect(stdout.write).toHaveBeenCalledWith('\x1b[?25h');
  });

  it('survives a stdout that is already closed', () => {
    const stdout = { isTTY: true, write: vi.fn(() => { throw new Error('EPIPE'); }) };
    expect(() => restoreTerminal(ttyStdin(), stdout)).not.toThrow();
  });
});
