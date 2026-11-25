// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT: open the system browser
// ─────────────────────────────────────────────

import { spawn } from 'node:child_process';

/**
 * Open `url` in the user's own browser. Never an embedded webview: the sign-in
 * happens where the user already is signed in to ChatGPT. Best effort; a
 * headless machine just returns false and the caller says what to do.
 */
export function openSystemBrowser(url: string): boolean {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
    return true;
  } catch {
    return false;
  }
}
