// ─────────────────────────────────────────────
//  Cascade AI — Workspace Path Sandbox Helper
// ─────────────────────────────────────────────

import path from 'node:path';

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

  if (rel === '' || rel === '.') return abs;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspaceSandboxError(input, root);
  }
  return abs;
}
