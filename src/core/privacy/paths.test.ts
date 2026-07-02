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
