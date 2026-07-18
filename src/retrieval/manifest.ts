// ─────────────────────────────────────────────
//  Cascade AI — File manifest (Phase 3)
// ─────────────────────────────────────────────
//
// A content-hash manifest of the indexed files. Comparing a fresh manifest to
// the stored one yields exactly which files changed, so re-indexing only
// re-embeds those (Cursor's Merkle-diff idea, flattened: per-file hashes plus a
// single root fingerprint over the whole set for a cheap "anything changed?"
// check).

import { createHash } from 'node:crypto';

export interface FileManifest {
  /** repo-relative path → content hash (hex). */
  files: Record<string, string>;
  /** Fingerprint over the whole (sorted) manifest — equal roots ⇒ no changes. */
  root: string;
}

export interface ManifestDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildManifest(entries: Array<{ path: string; hash: string }>): FileManifest {
  const files: Record<string, string> = {};
  for (const e of entries) files[e.path] = e.hash;
  const root = createHash('sha256')
    .update(Object.keys(files).sort().map((p) => `${p}:${files[p]}`).join('\n'))
    .digest('hex');
  return { files, root };
}

export function diffManifest(oldManifest: FileManifest | null, next: FileManifest): ManifestDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  const old = oldManifest?.files ?? {};
  for (const [p, h] of Object.entries(next.files)) {
    if (!(p in old)) added.push(p);
    else if (old[p] !== h) changed.push(p);
    else unchanged.push(p);
  }
  for (const p of Object.keys(old)) if (!(p in next.files)) removed.push(p);
  return { added, changed, removed, unchanged };
}
