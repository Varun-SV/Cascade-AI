import fs from 'node:fs';

/**
 * Putting the terminal back the way this process found it.
 *
 * Ink takes over the tty to read keystrokes: it puts stdin into raw mode and
 * hides the cursor. On a clean unmount it undoes both. On a crash it does not
 * run at all — and the shell that gets the terminal back has no echo, no line
 * editing, and Enter no longer submits, which reads to the user as though a
 * modifier key were stuck down. `stty sane` fixes it, but only if you know to
 * type it blind.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not restore a terminal it never took. The exit handler is installed
 * for every invocation, including `--version` and headless `-p` runs that
 * never render, and termios belongs to the TTY DEVICE rather than to the
 * process — so a parent TUI that hid its own cursor and set its own raw mode
 * before shelling out here would have had both undone by a subcommand that
 * only printed a version string.
 *
 * And it does not assume `write()` reaches the terminal. On Windows, writes to
 * a TTY are asynchronous, and this runs inside `process.on('exit')`, after
 * which Node performs no more async work — so the escape sequence could be
 * dropped on exactly the crash it exists to clean up after. It is written
 * through the file descriptor instead, which is synchronous everywhere.
 */

/** The parts of stdin this needs, so a test can supply them. */
export interface RawModeStream {
  isTTY?: boolean;
  /**
   * Whether THIS process put the terminal into raw mode.
   *
   * Node initialises it to `false` and sets it only from this process's own
   * `setRawMode` calls — a tty already raw when the process started still
   * reports `false`, which is what makes it usable as "did we take this?".
   */
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
}

/** The parts of stdout this needs. */
export interface CursorStream {
  isTTY?: boolean;
  /** Written through directly, because a TTY `write()` is async on Windows. */
  fd?: number;
  write: (chunk: string) => unknown;
}

/** Show the cursor again — Ink hides it while it renders. */
const SHOW_CURSOR = '\x1b[?25h';

/** Write now, not on some later tick that a dying process will never reach. */
function writeNow(stdout: CursorStream, text: string): void {
  if (typeof stdout.fd === 'number') {
    try {
      fs.writeSync(stdout.fd, text);
      return;
    } catch { /* fall through to the stream */ }
  }
  try { stdout.write(text); } catch { /* closed — the shell redraws its own */ }
}

/**
 * Hand the terminal back in a usable state, if this process took it.
 *
 * Deliberately total: it runs on the way out of a process that may already be
 * failing, so every step is guarded and nothing here may throw. A cleanup that
 * crashes during a crash replaces a bad error message with a worse one.
 */
export function restoreTerminal(stdin: RawModeStream, stdout: CursorStream): void {
  // The one signal that says this process took the terminal over. Ink sets raw
  // mode and hides the cursor together — every render in this CLI reads input —
  // so it gates both halves of the restoration.
  if (stdin.isRaw !== true) return;

  try {
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
  } catch { /* the tty is already gone; nothing to restore it to */ }

  if (stdout.isTTY) writeNow(stdout, SHOW_CURSOR);
}
