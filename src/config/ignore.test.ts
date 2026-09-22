import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CascadeIgnore, createDefaultIgnoreFile } from './ignore.js';

describe('CascadeIgnore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-ignore-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('protects the built-in secrets with no .cascadeignore present', async () => {
    const ig = new CascadeIgnore();
    await ig.load(dir);
    expect(ig.isIgnored('.env')).toBe(true);
    expect(ig.isIgnored('.env.production')).toBe(true);
    expect(ig.isIgnored('server.pem')).toBe(true);
    expect(ig.isIgnored('.cascade/keystore.enc')).toBe(true);
    expect(ig.isIgnored('src/index.ts')).toBe(false);
  });

  it('adds the workspace file\'s patterns and skips comments and blank lines', async () => {
    await fs.writeFile(
      path.join(dir, '.cascadeignore'),
      '# a comment\n\nvendor/\n*.snap\n',
      'utf-8',
    );
    const ig = new CascadeIgnore();
    await ig.load(dir);
    expect(ig.isIgnored('vendor/lib.js')).toBe(true);
    expect(ig.isIgnored('a.snap')).toBe(true);
    // The comment must not have become a pattern.
    expect(ig.getPatterns()).not.toContain('# a comment');
    expect(ig.getPatterns()).not.toContain('');
  });

  it('resolves an absolute path against the workspace before matching', async () => {
    const ig = new CascadeIgnore();
    await ig.load(dir);
    expect(ig.isIgnored(path.join(dir, '.env'), dir)).toBe(true);
    expect(ig.isIgnored(path.join(dir, 'src', 'index.ts'), dir)).toBe(false);
  });

  // getPatterns used to read `ignore`'s private `_rules`. That field stopped
  // being an array in ignore 7, so the getter threw a TypeError — silently,
  // because nothing called it. It reports what it was given instead.
  it('reports every pattern it was given, defaults and file alike', async () => {
    await fs.writeFile(path.join(dir, '.cascadeignore'), 'vendor/\n*.snap\n', 'utf-8');
    const ig = new CascadeIgnore();
    await ig.load(dir);
    const patterns = ig.getPatterns();
    expect(patterns).toContain('.env');
    expect(patterns).toContain('id_ed25519');
    expect(patterns).toContain('vendor/');
    expect(patterns).toContain('*.snap');
    // Defaults first, then the workspace file, in the order given.
    expect(patterns.indexOf('vendor/')).toBeGreaterThan(patterns.indexOf('id_ed25519'));
  });

  it('hands back a copy, so a caller cannot edit the live pattern list', async () => {
    const ig = new CascadeIgnore();
    await ig.load(dir);
    ig.getPatterns().push('nonsense');
    expect(ig.getPatterns()).not.toContain('nonsense');
  });

  it('writes a default file whose own patterns the matcher then honours', async () => {
    await createDefaultIgnoreFile(dir);
    const ig = new CascadeIgnore();
    await ig.load(dir);
    expect(ig.isIgnored('node_modules/left-pad/index.js')).toBe(true);
    expect(ig.isIgnored('dist/bundle.js')).toBe(true);
    expect(ig.isIgnored('app.min.js')).toBe(true);
    expect(ig.isIgnored('.DS_Store')).toBe(true);
    expect(ig.getPatterns()).toContain('node_modules/');
  });
});
