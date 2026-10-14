import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coveredLinkIdentities, LinkAliases } from './link-aliases.js';

const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));

describe('coveredLinkIdentities', () => {
  // A covered name that is a symlink was skipped: the file it leads to,
  // under another name, read as public.
  it.skipIf(process.platform === 'win32')('follows a covered symlink to the file it leads to, and that file\'s other names', () => {
    const root = tmp('cascade-links-symlink-');
    try {
      fs.mkdirSync(path.join(root, 'private'));
      fs.mkdirSync(path.join(root, 'data'));
      fs.writeFileSync(path.join(root, 'data', 'key.txt'), 'KEY');
      fs.linkSync(path.join(root, 'data', 'key.txt'), path.join(root, 'public.txt'));
      fs.symlinkSync('../data/key.txt', path.join(root, 'private', 'key.txt'));
      const covered = (rel: string) => rel.startsWith('private/');
      expect(coveredLinkIdentities(root, covered).ids.size).toBe(1);
      expect(new LinkAliases(root, covered).isAlias(path.join(root, 'public.txt'))).toBe(true);
      // A link back to a folder already searched ends there.
      fs.symlinkSync('..', path.join(root, 'private', 'loop'));
      expect(coveredLinkIdentities(root, covered).ids.size).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A folder that could not be listed left a covered file in it unfound.
  it('says so when a folder could not be listed, and takes a file with several names for covered then', () => {
    const root = tmp('cascade-links-unlistable-');
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
    const real = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (String(p) === locked) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (real as (p: fs.PathLike, o?: unknown) => unknown)(p, o);
    }) as typeof real);
    try {
      const covered = (rel: string) => rel.startsWith('locked/');
      expect(coveredLinkIdentities(root, covered).complete).toBe(false);
      expect(new LinkAliases(root, covered).isAlias(path.join(root, 'b.txt'))).toBe(true);
    } finally {
      spy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
    const clean = tmp('cascade-links-clean-');
    try {
      fs.writeFileSync(path.join(clean, 'a.txt'), 'A');
      fs.linkSync(path.join(clean, 'a.txt'), path.join(clean, 'b.txt'));
      expect(new LinkAliases(clean, (rel) => rel.startsWith('locked/')).isAlias(path.join(clean, 'b.txt'))).toBe(false);
    } finally {
      fs.rmSync(clean, { recursive: true, force: true });
    }
  });
});
