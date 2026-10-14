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
 * directory covered whole is searched to the bottom. `complete` is false
 * when a folder could not be listed: a covered file in it could not be
 * found, and its other names not known.
 */
export function coveredLinkIdentities(root: string, covered: (rel: string) => boolean): { ids: Set<string>; complete: boolean } {
  const ids = new Set<string>();
  let complete = true;
  const list = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      return [];
    }
  };
  // A covered name that is a symlink covers what it leads to: the file
  // there, under any other name it has, or a folder, whole. Each folder is
  // entered once, so a link back to one already searched ends there.
  const entered = new Set<string>();
  const record = (abs: string) => {
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.nlink > 1) ids.add(fileIdentity(st));
      else if (st.isDirectory()) all(abs);
    } catch { /* gone meanwhile, or a link to nothing */ }
  };
  const all = (dir: string) => {
    let real: string;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (entered.has(real)) return;
    entered.add(real);
    for (const e of list(dir)) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) all(abs);
      else if (e.isFile() || e.isSymbolicLink()) record(abs);
    }
  };
  const walk = (dir: string, relDir: string) => {
    for (const e of list(dir)) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (UNSEARCHED.has(e.name)) continue;
        if (covered(`${rel}/`) || covered(`${rel}/${PROBE}`)) all(abs);
        else walk(abs, rel);
      } else if ((e.isFile() || e.isSymbolicLink()) && (covered(rel) || covered(`${rel}/`))) {
        record(abs);
      }
    }
  };
  walk(root, '');
  return { ids, complete };
}

/**
 * Whether a file is another name for one `covered` names. The covered
 * files' identities are found once and looked for again only when a file
 * with several names changed since: making a link changes the file's ctime.
 */
export class LinkAliases {
  private found?: { at: number; ids: Set<string>; complete: boolean };
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
      this.found = { at: Date.now(), ...coveredLinkIdentities(this.root, this.covered) };
      this.searchedFor.set(id, st.ctimeMs);
    }
    // A search that could not look everywhere cannot say this file with
    // several names is none of the covered ones: it is taken as one.
    return this.found!.ids.has(id) || !this.found!.complete;
  }
}
