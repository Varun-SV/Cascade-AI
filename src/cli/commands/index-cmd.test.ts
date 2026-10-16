import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceGate } from '../../tools/workspace-gate.js';
import { whileReadingIn } from './index-cmd.js';

// With no privacy.paths rules, `cascade index` read files without taking
// the gate against other processes: a command in a run could swap a file
// it had checked for a symlink to `.env` before it read it.
describe('cascade index', () => {
  it('reads each file in the workspace gate, against other processes too', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-index-gate-')));
    const enter = vi.spyOn(WorkspaceGate.prototype, 'enter');
    try {
      expect(await whileReadingIn(dir)(async () => 'read')).toBe('read');
      expect(enter).toHaveBeenCalledWith('tools', true);
    } finally {
      enter.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
