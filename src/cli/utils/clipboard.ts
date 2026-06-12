// ─────────────────────────────────────────────
//  Cascade AI — Cross-platform clipboard reader
// ─────────────────────────────────────────────
//
//  Shells out to the native OS clipboard command. Used as a fallback
//  when the terminal does not translate Ctrl+V into a paste event
//  (e.g. legacy Windows console, some SSH sessions, etc.).
//
//  Returns an empty string on failure rather than throwing — the caller
//  is typing in an interactive TUI and we don't want to crash the UI.

import { spawnSync } from 'node:child_process';

type Cmd = { cmd: string; args: string[] };

function candidates(): Cmd[] {
  if (process.platform === 'win32') {
    return [
      // Prefer powershell.exe which is present on all supported Windows versions.
      { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] },
      { cmd: 'pwsh.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] },
    ];
  }
  if (process.platform === 'darwin') {
    return [{ cmd: 'pbpaste', args: [] }];
  }
  // Linux / BSD — try the common clipboard tools in order.
  const out: Cmd[] = [];
  if (process.env['WAYLAND_DISPLAY']) {
    out.push({ cmd: 'wl-paste', args: ['--no-newline'] });
  }
  out.push({ cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] });
  out.push({ cmd: 'xsel', args: ['--clipboard', '--output'] });
  // Termux on Android
  out.push({ cmd: 'termux-clipboard-get', args: [] });
  return out;
}

/**
 * Read the system clipboard. Returns an empty string if the clipboard is
 * empty or no supported clipboard tool is available. Never throws.
 *
 * The result is trimmed of a single trailing newline (which `Get-Clipboard`
 * and most X clipboard tools append) so pasted single-line values don't
 * auto-submit the current prompt.
 */
export function readClipboardSync(): string {
  for (const { cmd, args } of candidates()) {
    try {
      const result = spawnSync(cmd, args, {
        encoding: 'utf-8',
        timeout: 300,
        // Hide any stderr output — we'll fall back silently.
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      if (result.status === 0 && typeof result.stdout === 'string') {
        // PowerShell's Get-Clipboard appends a trailing CRLF; pbpaste doesn't.
        // Strip a single trailing newline so paste doesn't auto-submit.
        return result.stdout.replace(/\r\n?$/, '').replace(/\n$/, '');
      }
    } catch {
      // try next candidate
    }
  }
  return '';
}

function writeCandidates(): Cmd[] {
  if (process.platform === 'win32') {
    return [
      // clip.exe ships with every supported Windows version and reads stdin.
      { cmd: 'clip.exe', args: [] },
      { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', '$input | Set-Clipboard'] },
      { cmd: 'pwsh.exe', args: ['-NoProfile', '-Command', '$input | Set-Clipboard'] },
    ];
  }
  if (process.platform === 'darwin') {
    return [{ cmd: 'pbcopy', args: [] }];
  }
  const out: Cmd[] = [];
  if (process.env['WAYLAND_DISPLAY']) {
    out.push({ cmd: 'wl-copy', args: [] });
  }
  out.push({ cmd: 'xclip', args: ['-selection', 'clipboard', '-i'] });
  out.push({ cmd: 'xsel', args: ['--clipboard', '--input'] });
  // Termux on Android
  out.push({ cmd: 'termux-clipboard-set', args: [] });
  return out;
}

// Terminals commonly cap OSC 52 payloads around 100 KB of base64 — truncate
// rather than silently sending an escape the terminal will drop entirely.
const OSC52_MAX_CHARS = 70_000;

/**
 * Write text to the system clipboard. Tries the native OS clipboard tools
 * first; when none are available (SSH sessions, containers, minimal
 * installs) falls back to the OSC 52 terminal escape, which modern
 * terminals translate into a clipboard write on the user's local machine.
 *
 * Returns how the copy was performed, or `false` if no path was available.
 * Never throws.
 */
export function writeClipboardSync(text: string): 'native' | 'osc52' | false {
  for (const { cmd, args } of writeCandidates()) {
    try {
      const result = spawnSync(cmd, args, {
        input: text,
        timeout: 500,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      if (result.status === 0) return 'native';
    } catch {
      // try next candidate
    }
  }

  // OSC 52 fallback — only meaningful on a real terminal.
  if (process.stdout.isTTY) {
    try {
      const payload = Buffer.from(text.slice(0, OSC52_MAX_CHARS), 'utf-8').toString('base64');
      process.stdout.write(`\x1b]52;c;${payload}\x07`);
      return 'osc52';
    } catch {
      /* fall through */
    }
  }
  return false;
}
