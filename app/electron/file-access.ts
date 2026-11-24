// ─────────────────────────────────────────────
//  Cascade Desktop — Which files the Code view's previews may touch
// ─────────────────────────────────────────────
//
//  The previews can hand a file to the operating system to open, which the
//  window could not do before. That is limited to the open workspace, and a
//  program or script is never opened: handing an .exe or a .bat to the OS runs
//  it. Those are only shown in their folder.

import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

/** Extensions the OS would run rather than show. Lowercase, with the dot. */
const RUNNABLE = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.scr', '.pif', '.cpl', '.hta', '.jar',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.lnk', '.reg', '.url',
  '.sh', '.bash', '.zsh', '.command', '.app', '.pkg', '.dmg', '.run', '.bin', '.appimage', '.deb', '.rpm',
]);

/** True when handing this file to the OS would run it. */
export function isRunnable(filePath: string): boolean {
  return RUNNABLE.has(extname(filePath).toLowerCase());
}

/** True when `target` is inside `root` (or is it), after following links. */
export async function insideWorkspace(root: string, target: string): Promise<boolean> {
  if (!root || !target) return false;
  const real = async (p: string) => realpath(p).catch(() => resolve(p));
  const [r, t] = await Promise.all([real(root), real(target)]);
  const rel = relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
