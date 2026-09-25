// ─────────────────────────────────────────────
//  Cascade AI — Per-path Privacy Tiers
// ─────────────────────────────────────────────
//
//  Users can declare privacy policies for parts of the workspace:
//
//    "privacy": { "paths": [{ "pattern": "src/core/crypto/**", "policy": "local-only" }] }
//
//  A subtask whose target files match a `local-only` pattern is forced onto
//  LOCAL models (never cloud), and its raw output is withheld from the tiers
//  above — T2/T1 receive only a success/fail signal, not the content.
//
//  What such a subtask writes is local-only too: it may carry what the
//  subtask read. Those files — and the directories it made, whose names can
//  carry as much — are recorded as they are written, in
//  the project's state folder (privacy-derived.json, config/project-state.ts),
//  so they stay local-only across runs. Runs
//  sharing a workspace share the record: each merges into it under a lock,
//  and looks at it again when another has changed it.

import fs from 'node:fs';
import path from 'node:path';
import * as _ignoreModule from 'ignore';
import type { Ignore } from 'ignore';
import { realPathOf } from '../../utils/real-path.js';
import { LinkAliases } from '../../utils/link-aliases.js';
import { statePath, STATE } from '../../config/project-state.js';
import { stripTrailingSlashes } from '../../utils/net.js';
// Same gitignore-style matcher used by .cascadeignore (src/config/ignore.ts),
// so privacy patterns behave exactly like ignore patterns users already know.
const ignore = (_ignoreModule as unknown as { default: () => Ignore }).default ?? (_ignoreModule as unknown as () => Ignore);

export interface PrivacyPathPolicy {
  pattern: string;
  policy: 'local-only';
}


/** Saves of any record made in this process, for `PrivacyPaths.sync`. */
let saves = 0;

/** How long a save waits for another run's to finish before giving up. */
const LOCK_WAIT_MS = 5_000;
/** A lock older than this was left by a run that ended holding it. */
const STALE_LOCK_MS = 30_000;

export class PrivacyPaths {
  private localOnly: Ignore;
  private patterns: string[];
  /** Workspace-relative POSIX paths a local-only subtask wrote: files, and the directories it made. */
  private derived = new Set<string>();
  /** The same paths as a tree of their segments, to find one a path is or lies in with one walk. */
  private derivedTree: SegmentNode = treeOf([]);
  private readonly derivedFile?: string;
  /** Recorded here but not yet on disk: a save that could not take the lock. */
  private unsaved = new Set<string>();
  /** The record's file as last read or written here, to tell when another run changed it. */
  private seen = '';
  /** Whether the record was looked at in the current job, and how many saves this process had made then (see `sync`). */
  private synced = false;
  private savesSeen = 0;
  /** Other names — hard links — for the local-only files, per workspace root asked about. */
  private aliases = new Map<string, LinkAliases>();

  /**
   * @param opts.workspaceRoot where the record of what local-only subtasks
   *        wrote is kept; without it, that record lasts only this process.
   */
  constructor(policies: PrivacyPathPolicy[] = [], opts: { workspaceRoot?: string } = {}) {
    this.localOnly = ignore();
    this.patterns = policies.filter((p) => p.policy === 'local-only').map((p) => p.pattern);
    if (this.patterns.length) this.localOnly.add(this.patterns);
    if (opts.workspaceRoot) {
      this.derivedFile = statePath(opts.workspaceRoot, STATE.privacyDerived);
      this.sync();
    }
  }

  /**
   * The local-only patterns, gitignore-style: the configured ones, and one
   * for each file a local-only subtask wrote.
   */
  localOnlyPatterns(): string[] {
    this.sync();
    return [...this.patterns, ...[...this.derived].map(literalPattern)];
  }

  /** True when any privacy rules are configured, or a local-only subtask has written anything. */
  hasPolicies(): boolean {
    this.sync();
    return this.patterns.length > 0 || this.derived.size > 0;
  }

  /**
   * True when the given workspace-relative path falls under a local-only
   * policy — or is, or lies in, something a local-only subtask wrote.
   */
  isLocalOnly(relativePath: string): boolean {
    if (!relativePath) return false;
    const rel = relativePath.replace(/^\.?\//, '');
    this.sync();
    if (this.derived.size) {
      let node = this.derivedTree;
      for (const segment of stripTrailingSlashes(rel).split('/')) {
        const next = node.children.get(segment);
        if (!next) break;
        if (next.recorded) return true;
        node = next;
      }
    }
    if (this.patterns.length === 0) return false;
    try {
      // The ignore matcher requires relative paths; strip any leading ./ or /.
      return this.localOnly.ignores(rel);
    } catch {
      return false;
    }
  }

  /**
   * Record files a local-only subtask wrote (workspace-relative), so they are
   * local-only from now on, in this run and the next. Recorded even when a
   * configured pattern covers them now: the pattern may be narrowed later,
   * and what they hold came from private inputs all the same. Returns the
   * ones newly recorded.
   */
  addDerived(relativePaths: string[]): string[] {
    this.sync();
    const added: string[] = [];
    for (const raw of relativePaths) {
      const rel = stripTrailingSlashes(raw.split(path.sep).join('/').replace(/^\.?\//, ''));
      if (!rel || rel.startsWith('../') || this.derived.has(rel) || added.includes(rel)) continue;
      added.push(rel);
    }
    if (added.length) this.saveDerived(added, []);
    return added;
  }

  /** Forget records made for a write that did not happen. */
  removeDerived(relativePaths: string[]): void {
    this.sync();
    const removed = relativePaths.filter((rel) => this.derived.has(rel));
    if (removed.length) this.saveDerived([], removed);
  }

  /**
   * Apply a change to the record: to what is on disk now, not to what this
   * run read earlier — another run may have added to it since — under a
   * lock, so two runs' changes cannot overwrite each other. Kept here as
   * well when the record cannot be written, for this run at least; the
   * write tool asking fails then, and the write with it.
   */
  private saveDerived(added: string[], removed: string[]): void {
    for (const rel of added) this.derived.add(rel);
    for (const rel of removed) this.derived.delete(rel);
    for (const rel of removed) this.unsaved.delete(rel);
    this.setDerived(this.derived);
    const file = this.derivedFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      withLock(`${file}.lock`, () => {
        const next = new Set(readDerived(file));
        for (const rel of [...this.unsaved, ...added]) next.add(rel);
        for (const rel of removed) next.delete(rel);
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, paths: [...next].sort() }, null, 2));
        fs.renameSync(tmp, file);
        saves++;
        this.unsaved.clear();
        this.setDerived(next);
        this.seen = stampOf(file);
      });
    } catch (err) {
      for (const rel of added) this.unsaved.add(rel);
      throw err;
    }
  }

  /**
   * Read the record again when another run has changed it. Looked at once
   * per job, and again after a save in this process: a walk over the
   * workspace costs one look, not one per file.
   */
  private sync(): void {
    const file = this.derivedFile;
    if (!file || (this.synced && this.savesSeen === saves)) return;
    if (!this.synced) queueMicrotask(() => { this.synced = false; });
    this.synced = true;
    this.savesSeen = saves;
    const now = stampOf(file);
    if (now === this.seen) return;
    this.seen = now;
    this.setDerived(new Set([...readDerived(file), ...this.unsaved]));
  }

  private setDerived(paths: Set<string>): void {
    this.derived = paths;
    this.derivedTree = treeOf(paths);
    this.aliases.clear();
  }

  /**
   * True when the file at `absPath` falls under a local-only policy — under
   * its own name, through a symlink under the name of what it points to, or
   * as a hard link to a local-only file. A path outside `root` is judged by
   * the name it has inside it only.
   */
  coversFile(absPath: string, root: string): boolean {
    if (!this.hasPolicies()) return false;
    if (this.isLocalOnly(relativeWithin(root, absPath))) return true;
    const real = realPathOf(absPath);
    if (real !== absPath && this.isLocalOnly(relativeWithin(realPathOf(root), real))) return true;
    // A hard link to a local-only file is that file under another name.
    let aliases = this.aliases.get(root);
    if (!aliases) this.aliases.set(root, aliases = new LinkAliases(root, (rel) => this.isLocalOnly(rel)));
    return aliases.isAlias(absPath);
  }

  /** True when ANY of the given paths falls under a local-only policy. */
  anyLocalOnly(relativePaths: string[]): boolean {
    return relativePaths.some((p) => this.isLocalOnly(p));
  }
}

interface SegmentNode { recorded: boolean; children: Map<string, SegmentNode> }

/** Paths as a tree of their segments; a recorded path's last node is marked. */
function treeOf(paths: Iterable<string>): SegmentNode {
  const root: SegmentNode = { recorded: false, children: new Map() };
  for (const p of paths) {
    let node = root;
    for (const segment of p.split('/')) {
      let next = node.children.get(segment);
      if (!next) node.children.set(segment, next = { recorded: false, children: new Map() });
      node = next;
    }
    node.recorded = true;
  }
  return root;
}

/** The file's identity and last change, or '' when there is none. */
function stampOf(file: string): string {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st ? `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}` : '';
}

/**
 * Run `fn` holding a lock file other processes respect. A lock left by a
 * process that ended holding it is taken over once stale; waiting longer
 * than `LOCK_WAIT_MS` throws.
 */
function withLock<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = fs.statSync(lock, { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`Could not record a local-only file: ${lock} has been held for over ${LOCK_WAIT_MS / 1000}s.`);
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/** The recorded paths, or none when there is no record or it cannot be read. */
function readDerived(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { paths?: unknown };
    return Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === 'string' && p !== '') : [];
  } catch {
    return [];
  }
}

/**
 * A gitignore pattern (and git glob) naming exactly this path: anchored, with
 * each wildcard character, and a trailing space, in a class of its own.
 */
export function literalPattern(rel: string): string {
  return `/${rel.replace(/[*?[\\]/g, (c) => `[${c}]`).replace(/ $/, '[ ]')}`;
}

/** `absPath` relative to `root` in POSIX form, or '' when it is not inside. */
function relativeWithin(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}
