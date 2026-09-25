// ─────────────────────────────────────────────
//  Cascade AI — .cascadeignore Parser
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import * as _ignoreModule from 'ignore';
import type { Ignore } from 'ignore';
import { LinkAliases } from '../utils/link-aliases.js';
// ignore is a CJS package — access .default under NodeNext ESM interop
const ignore = (_ignoreModule as unknown as { default: () => Ignore }).default ?? (_ignoreModule as unknown as () => Ignore);

/**
 * Paths no agent tool may read or write, whatever `.cascadeignore` says.
 * Cascade's own files come first: `.cascade/config.json` holds provider keys
 * in plain JSON, `dashboard-secret` signs dashboard sessions, the audit trail
 * and the project's world state are databases with their keys beside them,
 * and the code index holds the text of every file it embedded. A SQLite
 * database's `-wal`/`-shm` files hold the same data as the database itself.
 */
export const BUILT_IN_PROTECTED: readonly string[] = [
  '.cascade/config.json',
  '.cascade/dashboard-secret',
  '.cascade/keystore.enc',
  '.cascade/memory.db*',
  '.cascade/audit_log.db*',
  '.cascade/audit_log.key',
  '.cascade/audit.log',
  '.cascade/world_state.db*',
  '.cascade/world_state.key',
  '.cascade/code-index.db*',
  '.cascade/privacy-derived.json',
  '.cascade/resume/',
  '.cascade/gate/',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
];

/**
 * Files agents may read but not change, workspace-relative: what they say
 * decides what is protected in the next run, and a line taken out of one
 * would unprotect a path then. Not hidden: `.cascadeignore` is commonly
 * committed, and a protected file in git's history hides the git store from
 * commands (tools/jail/process-jail.ts).
 */
export const READ_ONLY_POLICY: readonly string[] = ['.cascadeignore'];

export class CascadeIgnore {
  /** The built-ins, apart: a `!.env` line in `.cascadeignore` must not undo them. */
  private readonly builtIn: Ignore = ignore().add([...BUILT_IN_PROTECTED]);
  private ig: Ignore;
  private loaded = false;
  // Every pattern this matcher was given, in the order it was given them.
  // `getPatterns` used to read `ignore`'s private `_rules` instead, which
  // stopped being an array in ignore 7 and turned the getter into a
  // TypeError. What the caller wants is what we put in, and we know that
  // without asking the library.
  private readonly patterns: string[] = [];
  /** Other names — hard links — for the files matched, per workspace asked about. */
  private readonly aliases = new Map<string, LinkAliases>();

  constructor() {
    this.ig = ignore();
  }

  /** The one place a pattern enters the matcher, so the record cannot drift. */
  private add(patterns: string[]): void {
    this.patterns.push(...patterns);
    this.ig.add(patterns);
    this.aliases.clear();
  }

  async load(workspacePath: string): Promise<void> {
    const filePath = path.join(workspacePath, '.cascadeignore');
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      this.add(lines);
      this.loaded = true;
    } catch {
      // No .cascadeignore file — only built-in defaults apply
    }
  }

  isIgnored(filePath: string, workspacePath?: string): boolean {
    try {
      const native = workspacePath
        ? path.relative(workspacePath, filePath)
        : filePath;
      // gitignore paths are slash-separated. `ignore` converts Windows
      // separators itself, but only by sniffing the platform; the registry
      // hands it POSIX paths explicitly, and so does this.
      const relative = native.split(path.sep).join('/');
      if (this.builtIn.ignores(relative) || this.ig.ignores(relative)) return true;
      // A hard link to a matched file is that file under another name — the
      // code index would otherwise read `.env` as `src/config.ts`.
      if (!workspacePath) return false;
      let aliases = this.aliases.get(workspacePath);
      if (!aliases) {
        aliases = new LinkAliases(workspacePath, (rel) => this.builtIn.ignores(rel) || this.ig.ignores(rel));
        this.aliases.set(workspacePath, aliases);
      }
      return aliases.isAlias(path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath));
    } catch {
      return false;
    }
  }

  /** Every pattern in force: the built-ins, then the workspace file's. */
  getPatterns(): string[] {
    return [...BUILT_IN_PROTECTED, ...this.patterns];
  }

  /** The workspace `.cascadeignore`'s own patterns, without the built-ins. */
  getUserPatterns(): string[] {
    return [...this.patterns];
  }
}

export async function createDefaultIgnoreFile(workspacePath: string): Promise<void> {
  const filePath = path.join(workspacePath, '.cascadeignore');
  const content = `# .cascadeignore — Files Cascade agents cannot read or modify
# Syntax identical to .gitignore

# Secrets
.env
.env.*
*.pem
*.key
*.cert
id_rsa
id_ed25519

# Cascade keeps its own files — settings, sessions, the audit trail, the
# code index — outside the project, in ~/.cascade-ai/projects/, and your
# provider keys in ~/.cascade-ai/credentials.json. Agents never reach either.

# Build artifacts
node_modules/
dist/
build/
*.min.js

# OS files
.DS_Store
Thumbs.db
`;
  await fs.writeFile(filePath, content, 'utf-8');
}
