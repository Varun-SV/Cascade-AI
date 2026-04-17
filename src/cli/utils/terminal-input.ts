// ─────────────────────────────────────────────
//  Cascade AI — Terminal input sanitizers & modes
// ─────────────────────────────────────────────
//
//  Centralizes the terminal-control escape sequences that would otherwise
//  pollute Ink text inputs:
//    - SGR mouse reports (`\x1b[<b;x;yM` / `\x1b[<b;x;ym`) from mouse moves,
//      wheel scroll, and right-click events.
//    - Bracketed-paste markers (`\x1b[200~…\x1b[201~`) — these are handled
//      at a higher level but stripped as a safety net.
//    - CSI / SS3 / OSC / DCS sequences and stray C0 control characters.
//
//  The REPL and the setup wizard both need the same behaviour, so the
//  logic lives here in one place and is referenced by both.

/**
 * Matches SGR-encoded mouse reports (xterm 1006 mode):
 *   ESC [ < Pb ; Px ; Py (M|m)
 * We match lazily to avoid eating unrelated CSI sequences that happen to
 * contain semicolons.
 */
export const MOUSE_SGR_RE = /\x1b\[<\d+;\d+;\d+[Mm]/g;

/**
 * Matches x10/legacy mouse reports:
 *   ESC [ M Cb Cx Cy  (three raw bytes follow)
 * Uses a tolerant character class so we swallow the trailing bytes safely.
 */
export const MOUSE_LEGACY_RE = /\x1b\[M[\s\S]{3}/g;

/** Bracketed-paste start / end markers. */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/**
 * Broad escape-sequence stripper used as a final safety net on anything
 * that reaches the text input's onChange. Preserves \x7F (backspace/delete)
 * because Ink's TextInput relies on it.
 */
// Order matters: put the legacy 3-byte mouse sequence BEFORE any shorter
// pattern that could match `\x1b[M` alone, otherwise the trailing raw
// bytes leak through.
const ESC_SANITIZER_RE =
  /(?:\x1b\[<\d+;\d+;\d+[Mm])|(?:\x1b\[M[\s\S]{3})|(?:\x1b\[\d+[Mm])|(?:\x1b\[\?[0-9;]*[a-zA-Z])|(?:\x1b\[[0-9;?]*[\x40-\x7E])|(?:\x1bO[\x40-\x7E])|(?:\x1b[PX^_][\s\S]*?\x1b\\)|(?:\x1b\][\s\S]*?(?:\x07|\x1b\\))|[\x00-\x08\x0B-\x1F]/g;

export function sanitizeTerminalInput(value: string): string {
  return value.replace(ESC_SANITIZER_RE, '');
}

/** True if the chunk contains a mouse report (SGR or legacy). */
export function containsMouseSequence(chunk: string): boolean {
  return /\x1b\[<\d+;\d+;\d+[Mm]/.test(chunk) || /\x1b\[M[\s\S]{3}/.test(chunk);
}

/**
 * Enable xterm-compatible bracketed paste mode. Terminals that support it
 * will wrap pasted content in ESC[200~ / ESC[201~ so we can distinguish
 * pasted bytes from typed keystrokes.
 */
export function enableBracketedPaste(): void {
  try { process.stdout.write('\x1b[?2004h'); } catch { /* non-TTY */ }
}

export function disableBracketedPaste(): void {
  try { process.stdout.write('\x1b[?2004l'); } catch { /* non-TTY */ }
}

/** Disable any mouse reporting that a prior run or terminal may have left on. */
export function disableMouseReporting(): void {
  try {
    // 1000 = press/release, 1002 = button-motion, 1003 = any-motion,
    // 1006 = SGR encoding, 1015 = urxvt encoding.
    process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l');
  } catch {
    /* non-TTY */
  }
}

/** Enable SGR mouse reporting (used only by the REPL for scroll handling). */
export function enableMouseReporting(): void {
  try { process.stdout.write('\x1b[?1000h\x1b[?1006h'); } catch { /* non-TTY */ }
}
