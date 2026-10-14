// ─────────────────────────────────────────────
//  Cascade AI — Programs Cascade runs itself, outside the process jail
// ─────────────────────────────────────────────
//
//  Checking an agent's artifact runs a compiler with Cascade's own
//  permissions, and the jailer, ripgrep and the git calls the jail makes
//  run outside any jail; the git tool's git, and what it starts (ssh, gpg),
//  run with the credentials it keeps in view. Which program runs must not
//  be an approved command's to decide: a `node_modules/.bin/tsc` that `npx`
//  prefers, or a `git` a command left in ~/.local/bin, would run with
//  everything Cascade can reach.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isWithin } from './real-path.js';

/**
 * Cascade's own TypeScript compiler script, resolved from where Cascade is
 * installed — never from the workspace; undefined when Cascade was installed
 * without it.
 */
export function ownTsc(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('typescript/bin/tsc');
  } catch {
    return undefined;
  }
}

/** Where programs are installed for every user; as root, the only folders taken (see `alterable`). */
const SYSTEM_BIN = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

/**
 * PATH's entries a program may be taken from, in order: not relative (they
 * resolve against the working directory), not inside any of `untrusted`, by
 * real path, and not ones this user can change — a folder such as
 * ~/.local/bin — since a jailed command, which runs as this user, could put
 * its own program there.
 */
export function trustedDirs(untrusted: string | string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = (Array.isArray(untrusted) ? untrusted : [untrusted]).map(realOr);
  const out: string[] = [];
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || out.includes(dir)) continue;
    const real = realOr(dir);
    if (roots.some((root) => isWithin(real, root)) || alterable(dir, true)) continue;
    out.push(dir);
  }
  return out;
}

/**
 * The first of `names` found in `trustedDirs`, itself one this user cannot
 * change, where it really is; undefined when there is none.
 */
export function onTrustedPath(names: string[], untrusted: string | string[] = [], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const roots = (Array.isArray(untrusted) ? untrusted : [untrusted]).map(realOr);
  const exts = process.platform === 'win32'
    ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of trustedDirs(untrusted, env)) {
    for (const name of names) {
      for (const ext of exts) {
        const file = path.join(dir, name + ext);
        try {
          if (!fs.statSync(file).isFile()) continue;
          // Where it really is decides, as for the folder.
          const real = realOr(file);
          if (roots.some((root) => isWithin(real, root)) || alterable(file, false) || alterable(path.dirname(real), true)) continue;
          if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
          return file;
        } catch { /* not here */ }
      }
    }
  }
  return undefined;
}

/**
 * Whether a command running as this user could change `p`. On Windows,
 * where access() says little, never taken as so. Root can write to every
 * folder, so there only the system's own program folders count as not:
 * the process jail shows a command run as root the system read-only
 * (`rootLayout`), and runs none as root where it can't (macOS).
 */
function alterable(p: string, dir: boolean): boolean {
  if (process.platform === 'win32') return false;
  if (process.getuid?.() === 0) {
    const real = realOr(p);
    return !SYSTEM_BIN.includes(dir ? real : path.dirname(real));
  }
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function realOr(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}
