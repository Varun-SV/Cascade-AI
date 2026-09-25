// ─────────────────────────────────────────────
//  Cascade AI — A path with its symlinks resolved
// ─────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

/**
 * `absPath` with symlinks resolved. A path that does not exist yet (a file
 * about to be written) is resolved through its nearest existing ancestor, so
 * a new file under a symlinked directory is judged by where it will land —
 * and so is one reached through a symlink whose target does not exist yet,
 * which a write would create.
 */
export function realPathOf(absPath: string): string {
  let existing = absPath;
  const rest: string[] = [];
  let hops = 0;
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...[...rest].reverse());
    } catch {
      let link: string | undefined;
      try { if (fs.lstatSync(existing).isSymbolicLink()) link = fs.readlinkSync(existing); } catch { /* not there */ }
      if (link !== undefined && hops++ < 40) {
        existing = path.resolve(path.dirname(existing), link);
        continue;
      }
      const parent = path.dirname(existing);
      if (parent === existing) return absPath;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}
