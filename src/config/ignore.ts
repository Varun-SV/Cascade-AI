// ─────────────────────────────────────────────
//  Cascade AI — .cascadeignore Parser
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export class CascadeIgnore {
  private ig: Ignore;
  private loaded = false;

  constructor() {
    this.ig = ignore();
    // Built-in defaults — always protected
    this.ig.add([
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

  async load(workspacePath: string): Promise<void> {
    const filePath = path.join(workspacePath, '.cascadeignore');
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      this.ig.add(lines);
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
    return (this.ig as unknown as { _rules: Array<{ pattern: string }> })._rules?.map((r) => r.pattern) ?? [];
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
