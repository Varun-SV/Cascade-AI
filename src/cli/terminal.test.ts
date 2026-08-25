import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreTerminal } from './terminal.js';

/** A stdin this process put into raw mode — the case there is something to undo. */
function ownedStdin() {
  return { isTTY: true, isRaw: true, setRawMode: vi.fn() };
}
/** A stdin this process never touched. */
function borrowedStdin() {
  return { isTTY: true, isRaw: false, setRawMode: vi.fn() };
}
function ttyStdout() {
  return { isTTY: true, write: vi.fn() };
}

const opened: number[] = [];
afterEach(() => {
  for (const fd of opened.splice(0)) { try { fs.closeSync(fd); } catch { /* already closed */ } }
});

/** A stdout backed by a real file descriptor, so a synchronous write is observable. */
function fdStdout(): { stdout: { isTTY: boolean; fd: number; write: ReturnType<typeof vi.fn> }; read: () => string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-tty-')), 'out');
  const fd = fs.openSync(file, 'w+');
  opened.push(fd);
  return {
    stdout: { isTTY: true, fd, write: vi.fn() },
    read: () => fs.readFileSync(file, 'utf8'),
  };
}

describe('restoreTerminal', () => {
  it('takes stdin back out of raw mode', () => {
    // The whole point. Ink puts stdin into raw mode to read keystrokes and
    // restores it on a clean unmount; a crash skips that, and the shell that
    // inherits the terminal has no echo and no line editing — which reads as a
    // stuck modifier key rather than as a dead program.
    const stdin = ownedStdin();
    restoreTerminal(stdin, ttyStdout());
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  it('shows the cursor again', () => {
    const stdout = ttyStdout();
    restoreTerminal(ownedStdin(), stdout);
    expect(stdout.write).toHaveBeenCalledWith('\x1b[?25h');
  });

  it('touches nothing when this process never took the terminal', () => {
    // termios belongs to the TTY DEVICE, not to the process. This handler runs
    // for `--version` and headless `-p` runs too, so restoring unconditionally
    // would undo the raw mode and hidden cursor of a parent TUI that shelled
    // out here — state this process never owned.
    const stdin = borrowedStdin();
    const stdout = ttyStdout();
    restoreTerminal(stdin, stdout);
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it('treats an absent isRaw as not ours', () => {
    // A non-tty stdin reports `undefined`, and a tty that was already raw when
    // the process started still reports `false` — Node sets it only from this
    // process's own calls, which is what makes it a safe ownership signal.
    const stdin = { isTTY: false, setRawMode: vi.fn() };
    restoreTerminal(stdin, ttyStdout());
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });

  it('writes the escape sequence synchronously, through the descriptor', () => {
    // On Windows a TTY `write()` is asynchronous, and this runs inside
    // `process.on('exit')`, after which Node does no more async work — so the
    // sequence could be dropped on exactly the crash it cleans up after.
    // Asserted by reading the file back with no await anywhere: if the write
    // were deferred, nothing would be there yet.
    const { stdout, read } = fdStdout();
    restoreTerminal(ownedStdin(), stdout);
    expect(read()).toBe('\x1b[?25h');
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it('falls back to the stream when the descriptor write fails', () => {
    const stdout = { isTTY: true, fd: 999_999, write: vi.fn() };
    expect(() => restoreTerminal(ownedStdin(), stdout)).not.toThrow();
    expect(stdout.write).toHaveBeenCalledWith('\x1b[?25h');
  });

  it('writes no escape sequence into a redirected stdout', () => {
    // Otherwise a `cascade -p … > out.txt` ends with a stray control sequence
    // in the file.
    const stdout = { isTTY: false, write: vi.fn() };
    restoreTerminal(ownedStdin(), stdout);
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it('survives a stdin with no setRawMode at all', () => {
    expect(() => restoreTerminal({ isTTY: true, isRaw: true }, ttyStdout())).not.toThrow();
  });

  it('still shows the cursor when leaving raw mode throws', () => {
    // Runs while the process may already be dying, so one failing step must
    // not skip the next — and must not replace the real error with its own.
    const stdin = {
      isTTY: true,
      isRaw: true,
      setRawMode: vi.fn(() => { throw new Error('tty is gone'); }),
    };
    const stdout = ttyStdout();
    expect(() => restoreTerminal(stdin, stdout)).not.toThrow();
    expect(stdout.write).toHaveBeenCalledWith('\x1b[?25h');
  });

  it('survives a stdout that is already closed', () => {
    const stdout = { isTTY: true, write: vi.fn(() => { throw new Error('EPIPE'); }) };
    expect(() => restoreTerminal(ownedStdin(), stdout)).not.toThrow();
  });
});
