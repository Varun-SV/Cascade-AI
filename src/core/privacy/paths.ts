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

import * as _ignoreModule from 'ignore';
import type { Ignore } from 'ignore';
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

  constructor(policies: PrivacyPathPolicy[] = []) {
    this.localOnly = ignore();
    const patterns = policies.filter((p) => p.policy === 'local-only').map((p) => p.pattern);
    if (patterns.length) this.localOnly.add(patterns);
    this.hasRules = patterns.length > 0;
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

  /** True when ANY of the given paths falls under a local-only policy. */
  anyLocalOnly(relativePaths: string[]): boolean {
    return relativePaths.some((p) => this.isLocalOnly(p));
  }
}
