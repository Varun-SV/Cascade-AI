// ─────────────────────────────────────────────
//  Cascade AI — Workspace Path Sandbox Helper
// ─────────────────────────────────────────────

import path from 'node:path';
import fs from 'node:fs';

export class WorkspaceSandboxError extends Error {
  constructor(attempted: string, workspaceRoot: string) {
    super(`Refusing access to "${attempted}" — outside workspace root "${workspaceRoot}".`);
    this.name = 'WorkspaceSandboxError';
  }
}

/**
 * Resolve a user-supplied path and guarantee it stays inside the workspace.
 *
 * Fails closed on any escape attempt (e.g. "..", absolute paths pointing
 * outside the workspace, or symlink-style traversal from the caller).
 *
 * Call this in every file-touching tool BEFORE any fs operation.
 */
export function resolveInWorkspace(workspaceRoot: string, input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new WorkspaceSandboxError(String(input), workspaceRoot);
  }

  const root = path.resolve(workspaceRoot);
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const rel = path.relative(root, abs);

  if (rel === '' || rel === '.') {
    // still verify symlink target for the root itself
  } else if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspaceSandboxError(input, root);
  }

  // Dereference symlinks so a link inside the workspace pointing outside is caught.
  try {
    const real = fs.realpathSync(abs);
    const realRel = path.relative(root, real);
    if (realRel !== '' && realRel !== '.' && (realRel.startsWith('..') || path.isAbsolute(realRel))) {
      throw new WorkspaceSandboxError(input, root);
    }
  } catch (e) {
    if (e instanceof WorkspaceSandboxError) throw e;
    // Path doesn't exist yet (new file being created) — symlink check not applicable.
  }

  return abs;
}
