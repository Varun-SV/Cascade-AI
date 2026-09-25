// ─────────────────────────────────────────────
//  Cascade AI — Workspace Path Sandbox Helper
// ─────────────────────────────────────────────

import path from 'node:path';
import fs from 'node:fs';
import { realPathOf } from '../../utils/real-path.js';

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
  // The root is dereferenced too: a workspace opened through a symlink (or
  // under macOS's /tmp and /var) has files whose real paths all lie under the
  // root's real path, not under the name it was opened by.
  // Where the path lands, symlinks followed: through its nearest existing
  // ancestor for a file not written yet, and through a symlink whose target
  // does not exist yet, which a write would create (realPathOf).
  const real = realPathOf(abs);
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* compare against the name given */ }
  const realRel = path.relative(realRoot, real);
  if (realRel !== '' && realRel !== '.' && (realRel.startsWith('..') || path.isAbsolute(realRel))) {
    throw new WorkspaceSandboxError(input, root);
  }

  return abs;
}
