import { describe, expect, it } from 'vitest';
import { PrivacyPaths } from './paths.js';

describe('PrivacyPaths', () => {
  const policy = new PrivacyPaths([
    { pattern: 'src/core/crypto/**', policy: 'local-only' },
    { pattern: 'secrets.json', policy: 'local-only' },
  ]);

  it('matches files under a local-only directory pattern', () => {
    expect(policy.isLocalOnly('src/core/crypto/keys.ts')).toBe(true);
    expect(policy.isLocalOnly('src/core/crypto/deep/nested/mod.ts')).toBe(true);
  });

  it('matches an exact-file pattern anywhere gitignore semantics place it', () => {
    expect(policy.isLocalOnly('secrets.json')).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(policy.isLocalOnly('src/core/router/index.ts')).toBe(false);
    expect(policy.isLocalOnly('README.md')).toBe(false);
  });

  it('normalizes leading ./ before matching', () => {
    expect(policy.isLocalOnly('./src/core/crypto/keys.ts')).toBe(true);
  });

  it('anyLocalOnly is true when at least one path matches', () => {
    expect(policy.anyLocalOnly(['README.md', 'src/core/crypto/a.ts'])).toBe(true);
    expect(policy.anyLocalOnly(['README.md', 'src/utils/net.ts'])).toBe(false);
  });

  it('is inert with no policies', () => {
    const empty = new PrivacyPaths([]);
    expect(empty.hasPolicies()).toBe(false);
    expect(empty.isLocalOnly('src/core/crypto/keys.ts')).toBe(false);
  });
});

describe('PrivacyPaths.coversFile — a file on disk, under any name it has', () => {
  it('covers a file by its path in the workspace, and one reached through a symlink', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-covers-'));
    await fs.mkdir(path.join(root, 'secret'));
    await fs.writeFile(path.join(root, 'secret', 'plan.md'), 'x');
    await fs.symlink(path.join(root, 'secret', 'plan.md'), path.join(root, 'innocent.md'));
    await fs.symlink(path.join(root, 'secret'), path.join(root, 'docs'));
    const policy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);

    expect(policy.coversFile(path.join(root, 'secret', 'plan.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'innocent.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'docs', 'plan.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'docs', 'not-yet-written.md'), root)).toBe(true);
    expect(policy.coversFile(path.join(root, 'README.md'), root)).toBe(false);
    // Outside the workspace no pattern speaks to it; the file tools refuse it anyway.
    expect(policy.coversFile(path.join(os.tmpdir(), 'elsewhere.md'), root)).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });
});
