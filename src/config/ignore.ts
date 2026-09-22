// ─────────────────────────────────────────────
//  Cascade AI — .cascadeignore Parser
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import * as _ignoreModule from 'ignore';
import type { Ignore } from 'ignore';
// ignore is a CJS package — access .default under NodeNext ESM interop
const ignore = (_ignoreModule as unknown as { default: () => Ignore }).default ?? (_ignoreModule as unknown as () => Ignore);

export class CascadeIgnore {
  private ig: Ignore;
  private loaded = false;
  // Every pattern this matcher was given, in the order it was given them.
  // `getPatterns` used to read `ignore`'s private `_rules` instead, which
  // stopped being an array in ignore 7 and turned the getter into a
  // TypeError. What the caller wants is what we put in, and we know that
  // without asking the library.
  private readonly patterns: string[] = [];

  constructor() {
    this.ig = ignore();
    // Built-in defaults — always protected
    this.add([
      '.cascade/keystore.enc',
      '.cascade/memory.db',
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'id_rsa',
      'id_ed25519',
    ]);
  }

  /** The one place a pattern enters the matcher, so the record cannot drift. */
  private add(patterns: string[]): void {
    this.patterns.push(...patterns);
    this.ig.add(patterns);
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
      const relative = workspacePath
        ? path.relative(workspacePath, filePath)
        : filePath;
      return this.ig.ignores(relative);
    } catch {
      return false;
    }
  }

  getPatterns(): string[] {
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

# Cascade internals
.cascade/keystore.enc
.cascade/memory.db

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
