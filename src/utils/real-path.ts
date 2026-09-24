// ─────────────────────────────────────────────
//  Cascade AI — A path with its symlinks resolved
// ─────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

/**
 * `absPath` with symlinks resolved. A path that does not exist yet (a file
 * about to be written) is resolved through its nearest existing ancestor, so
 * a new file under a symlinked directory is judged by where it will land.
 */
export function realPathOf(absPath: string): string {
  let existing = absPath;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absPath;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}
