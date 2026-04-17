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
        timeout: 1500,
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
