// ─────────────────────────────────────────────
//  Cascade AI — Other names for a protected file
// ─────────────────────────────────────────────
//
//  A hard link is the same file under another name, and resolving symlinks
//  does not reveal it: `notes.txt` linked to `.env` is `.env`, while every
//  check by name sees `notes.txt`. So the files a check covers are known by
//  identity too — device and inode — and a file with more than one name is
//  judged by that.

import fs from 'node:fs';
import path from 'node:path';

/** Directories not searched for covered files: git's own store, and installed packages. */
const UNSEARCHED = new Set(['.git', 'node_modules']);

/**
 * A name no pattern is likely to name: when a directory's hypothetical child
 * by this name is covered, every child is — `secret/**` — and the directory
 * is covered whole, files made in it later included.
 */
export const PROBE = '.cascade-jail-probe';

/** A file's identity: the same for all its names. */
export function fileIdentity(st: fs.Stats): string {
  return `${st.dev}:${st.ino}`;
}

/**
 * The identities of the files under `root` that `covered` names and that
 * have more than one name — the only ones another name can reach. A
 * directory covered whole is searched to the bottom.
 */
export function coveredLinkIdentities(root: string, covered: (rel: string) => boolean): Set<string> {
  const ids = new Set<string>();
  const record = (abs: string) => {
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && st.nlink > 1) ids.add(fileIdentity(st));
    } catch { /* gone meanwhile */ }
  };
  const all = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) all(abs);
      else if (e.isFile()) record(abs);
    }
  };
  const walk = (dir: string, relDir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (UNSEARCHED.has(e.name)) continue;
        if (covered(`${rel}/`) || covered(`${rel}/${PROBE}`)) all(abs);
        else walk(abs, rel);
      } else if (e.isFile() && covered(rel)) {
        record(abs);
      }
    }
  };
  walk(root, '');
  return ids;
}

/**
 * Whether a file is another name for one `covered` names. The covered
 * files' identities are found once and looked for again only when a file
 * with several names changed since: making a link changes the file's ctime.
 */
export class LinkAliases {
  private found?: { at: number; ids: Set<string> };
  /** The change a file was last looked again for: one search covers it. */
  private searchedFor = new Map<string, number>();

  constructor(private readonly root: string, private readonly covered: (rel: string) => boolean) {}

  isAlias(absPath: string): boolean {
    let st: fs.Stats;
    try { st = fs.statSync(absPath); } catch { return false; }
    if (!st.isFile() || st.nlink < 2) return false;
    const id = fileIdentity(st);
    // A second of slack, for filesystems that keep whole seconds.
    const changedSince = !this.found || st.ctimeMs >= this.found.at - 1000;
    if (changedSince && this.searchedFor.get(id) !== st.ctimeMs) {
      this.found = { at: Date.now(), ids: coveredLinkIdentities(this.root, this.covered) };
      this.searchedFor.set(id, st.ctimeMs);
    }
    return this.found!.ids.has(id);
  }
}
