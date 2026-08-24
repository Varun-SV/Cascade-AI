/**
 * Putting the terminal back the way it was found.
 *
 * Ink takes over the tty to read keystrokes: it puts stdin into raw mode and
 * hides the cursor. On a clean unmount it undoes both. On a crash it does not
 * run at all — and the shell that gets the terminal back has no echo, no line
 * editing, and Enter no longer submits, which reads to the user as though a
 * modifier key were stuck down. `stty sane` fixes it, but only if you know to
 * type it blind.
 *
 * The alt screen was already restored on exit; raw mode and the cursor were
 * not, so a crash left the terminal in the one state the user cannot easily
 * get out of.
 */

/** The parts of stdin this needs, so a test can supply them. */
export interface RawModeStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

/** The parts of stdout this needs. */
export interface CursorStream {
  isTTY?: boolean;
  write: (chunk: string) => unknown;
}

/** Show the cursor again — Ink hides it while it renders. */
const SHOW_CURSOR = '\x1b[?25h';

/**
 * Hand the terminal back in a usable state.
 *
 * Deliberately total: it runs on the way out of a process that may already be
 * failing, so every step is guarded and nothing here may throw. A cleanup that
 * crashes during a crash replaces a bad error message with a worse one.
 */
export function restoreTerminal(stdin: RawModeStream, stdout: CursorStream): void {
  try {
    // `setRawMode` exists only on a TTY stdin; a piped or redirected stdin has
    // no raw mode to leave, and was never put into one.
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
  } catch { /* the tty is already gone; nothing to restore it to */ }

  try {
    if (stdout.isTTY) stdout.write(SHOW_CURSOR);
  } catch { /* the stream is closed — the shell will redraw its own cursor */ }
}
