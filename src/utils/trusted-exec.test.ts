import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { onTrustedPath, ownTsc } from './trusted-exec.js';

describe.skipIf(process.platform === 'win32')('onTrustedPath', () => {
  it('skips PATH entries inside the workspace (through a symlink too), relative ones, and ones this user can write to', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-trusted-')));
    try {
      const ws = path.join(base, 'ws');
      const outside = path.join(base, 'tools');
      for (const dir of [path.join(ws, 'bin'), outside]) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
      }
      await fs.symlink(path.join(ws, 'bin'), path.join(base, 'alias'));
      const PATH = ['bin', path.join(ws, 'bin'), path.join(base, 'alias'), outside].join(path.delimiter);
      // `outside` is this user's to write to, as ~/.local/bin is: a jailed
      // command could put a program there.
      expect(onTrustedPath(['tool'], ws, { PATH })).toBeUndefined();
      expect(onTrustedPath(['tool'], ws, { PATH: path.join(ws, 'bin') })).toBeUndefined();
      // A system folder this user cannot write to is taken.
      if (process.getuid?.() !== 0) expect(onTrustedPath(['sh'], ws, { PATH: '/bin' })).toBe('/bin/sh');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('finds Cascade\'s own compiler where Cascade is installed', () => {
    expect(ownTsc()).toMatch(/typescript[\\/]bin[\\/]tsc$/);
  });
});
