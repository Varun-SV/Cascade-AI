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
//  subtask read. Those files are recorded as they are written, in
//  .cascade/privacy-derived.json, so they stay local-only across runs.

import fs from 'node:fs';
import path from 'node:path';
import * as _ignoreModule from 'ignore';
import type { Ignore } from 'ignore';
import { realPathOf } from '../../utils/real-path.js';
import { LinkAliases } from '../../utils/link-aliases.js';
// Same gitignore-style matcher used by .cascadeignore (src/config/ignore.ts),
// so privacy patterns behave exactly like ignore patterns users already know.
const ignore = (_ignoreModule as unknown as { default: () => Ignore }).default ?? (_ignoreModule as unknown as () => Ignore);

export interface PrivacyPathPolicy {
  pattern: string;
  policy: 'local-only';
}

/** Where the files a local-only subtask wrote are recorded, relative to the workspace. */
export const DERIVED_FILE = '.cascade/privacy-derived.json';

export class PrivacyPaths {
  private localOnly: Ignore;
  private patterns: string[];
  /** Workspace-relative POSIX paths a local-only subtask wrote. */
  private derived = new Set<string>();
  private readonly derivedFile?: string;
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
      this.derivedFile = path.join(opts.workspaceRoot, DERIVED_FILE);
      for (const rel of readDerived(this.derivedFile)) this.derived.add(rel);
    }
  }

  /** Whether a workspace holds a record of files local-only subtasks wrote. */
  static hasDerived(workspaceRoot: string): boolean {
    return readDerived(path.join(workspaceRoot, DERIVED_FILE)).length > 0;
  }

  /**
   * The local-only patterns, gitignore-style: the configured ones, and one
   * for each file a local-only subtask wrote.
   */
  localOnlyPatterns(): string[] {
    return [...this.patterns, ...[...this.derived].map(literalPattern)];
  }

  /** True when any privacy rules are configured, or a local-only subtask has written anything. */
  hasPolicies(): boolean {
    return this.patterns.length > 0 || this.derived.size > 0;
  }

  /** True when the given workspace-relative path falls under a local-only policy. */
  isLocalOnly(relativePath: string): boolean {
    if (!relativePath) return false;
    const rel = relativePath.replace(/^\.?\//, '');
    if (this.derived.has(rel)) return true;
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
   * local-only from now on, in this run and the next. Returns the ones that
   * were not local-only already.
   */
  addDerived(relativePaths: string[]): string[] {
    const added: string[] = [];
    for (const raw of relativePaths) {
      const rel = raw.split(path.sep).join('/').replace(/^\.?\//, '');
      if (!rel || rel.startsWith('../') || this.isLocalOnly(rel)) continue;
      this.derived.add(rel);
      added.push(rel);
    }
    if (added.length) this.aliases.clear();
    if (added.length && this.derivedFile) {
      fs.mkdirSync(path.dirname(this.derivedFile), { recursive: true });
      const tmp = `${this.derivedFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, paths: [...this.derived].sort() }, null, 2));
      fs.renameSync(tmp, this.derivedFile);
    }
    return added;
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
function literalPattern(rel: string): string {
  return `/${rel.replace(/[*?[\\]/g, (c) => `[${c}]`).replace(/ $/, '[ ]')}`;
}

/** `absPath` relative to `root` in POSIX form, or '' when it is not inside. */
function relativeWithin(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}
