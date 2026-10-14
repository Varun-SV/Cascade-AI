// ─────────────────────────────────────────────
//  Cascade AI — Programs Cascade runs itself, outside the process jail
// ─────────────────────────────────────────────
//
//  Checking an agent's artifact runs a compiler with Cascade's own
//  permissions. Which one runs must not be the workspace's to decide: a
//  `node_modules/.bin/tsc` that `npx` prefers, or a `python` the agent left
//  on a PATH entry inside the workspace, would run with everything Cascade
//  can reach.

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

/**
 * The first of `names` found on PATH, skipping entries that are relative
 * (they resolve against the working directory), that lie inside
 * `untrusted`, by real path, or that this user can write to — a folder
 * such as ~/.local/bin, or the program itself — since a jailed command,
 * which runs as this user, could put its own program there; undefined when
 * there is none.
 */
export function onTrustedPath(names: string[], untrusted: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = realOr(untrusted);
  const exts = process.platform === 'win32'
    ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    if (isWithin(realOr(dir), root) || writable(dir)) continue;
    for (const name of names) {
      for (const ext of exts) {
        const file = path.join(dir, name + ext);
        try {
          if (!fs.statSync(file).isFile()) continue;
          // Where it really is decides, as for the folder.
          if (isWithin(realOr(file), root) || writable(file) || writable(path.dirname(realOr(file)))) continue;
          if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
          return file;
        } catch { /* not here */ }
      }
    }
  }
  return undefined;
}

/** Whether this user may write to `p` (on Windows, where access() says little, never taken as so). */
function writable(p: string): boolean {
  if (process.platform === 'win32') return false;
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
