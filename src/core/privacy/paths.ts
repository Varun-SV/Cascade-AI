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

import path from 'node:path';
import * as _ignoreModule from 'ignore';
import type { Ignore } from 'ignore';
import { realPathOf } from '../../utils/real-path.js';
// Same gitignore-style matcher used by .cascadeignore (src/config/ignore.ts),
// so privacy patterns behave exactly like ignore patterns users already know.
const ignore = (_ignoreModule as unknown as { default: () => Ignore }).default ?? (_ignoreModule as unknown as () => Ignore);

export interface PrivacyPathPolicy {
  pattern: string;
  policy: 'local-only';
}

export class PrivacyPaths {
  private localOnly: Ignore;
  private hasRules: boolean;
  private patterns: string[];

  constructor(policies: PrivacyPathPolicy[] = []) {
    this.localOnly = ignore();
    this.patterns = policies.filter((p) => p.policy === 'local-only').map((p) => p.pattern);
    if (this.patterns.length) this.localOnly.add(this.patterns);
    this.hasRules = this.patterns.length > 0;
  }

  /** The local-only patterns as configured, gitignore-style. */
  localOnlyPatterns(): string[] {
    return [...this.patterns];
  }

  /** True when any privacy rules are configured at all (cheap short-circuit). */
  hasPolicies(): boolean {
    return this.hasRules;
  }

  /** True when the given workspace-relative path falls under a local-only policy. */
  isLocalOnly(relativePath: string): boolean {
    if (!this.hasRules || !relativePath) return false;
    try {
      // The ignore matcher requires relative paths; strip any leading ./ or /.
      return this.localOnly.ignores(relativePath.replace(/^\.?\//, ''));
    } catch {
      return false;
    }
  }

  /**
   * True when the file at `absPath` falls under a local-only policy — under
   * its own name or, through a symlink, under the name of what it points to.
   * A path outside `root` is judged by the name it has inside it only.
   */
  coversFile(absPath: string, root: string): boolean {
    if (!this.hasRules) return false;
    if (this.isLocalOnly(relativeWithin(root, absPath))) return true;
    const real = realPathOf(absPath);
    return real !== absPath && this.isLocalOnly(relativeWithin(realPathOf(root), real));
  }

  /** True when ANY of the given paths falls under a local-only policy. */
  anyLocalOnly(relativePaths: string[]): boolean {
    return relativePaths.some((p) => this.isLocalOnly(p));
  }
}

/** `absPath` relative to `root` in POSIX form, or '' when it is not inside. */
function relativeWithin(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}
