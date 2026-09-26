import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeConfigFile } from './write-config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-write-'));
  dirs.push(d);
  return d;
};

describe('writeConfigFile — the save is only saved when it lands', () => {
  it('writes the config and says so', () => {
    const target = path.join(tmp(), 'nested', 'config.json');
    expect(writeConfigFile(target, { providers: [] })).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ providers: [] });
  });

  it('reports a real filesystem failure instead of swallowing it', () => {
    // A directory where the file should be: the write cannot succeed, and the
    // caller has to learn that. Swallowing it acknowledged the save, cleared
    // the keys the user had typed, and lost them at the next restart.
    const dir = tmp();
    const target = path.join(dir, 'config.json');
    fs.mkdirSync(target);

    const result = writeConfigFile(target, { providers: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/EISDIR|illegal operation|directory/i);
  });

  it('reports a failure when the path cannot be created', () => {
    // A FILE standing where a parent directory needs to be.
    const dir = tmp();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');

    const result = writeConfigFile(path.join(blocker, 'deeper', 'config.json'), {});
    expect(result.ok).toBe(false);
  });
});

// Keys live only in the global store now, so storing them is part of the save:
// a failure there is the save failing, and the project's config never holds them.
describe('writeProjectConfig — a project\'s config and its keys', () => {
  it('writes the config without the keys, and the keys where every project finds them', async () => {
    const { writeProjectConfig } = await import('./write-config.js');
    const { globalDir, statePath, STATE } = await import('./project-state.js');
    const ws = tmp();
    expect(writeProjectConfig(ws, { providers: [{ type: 'openai', apiKey: 'sk-here' }] })).toEqual({ ok: true });
    expect(fs.readFileSync(statePath(ws, STATE.config), 'utf-8')).not.toContain('sk-here');
    expect(fs.readFileSync(path.join(globalDir(), 'credentials.json'), 'utf-8')).toContain('sk-here');
  });

  it('fails the save when the keys cannot be stored', async () => {
    const { writeProjectConfig } = await import('./write-config.js');
    const ws = tmp();
    const blocked = path.join(tmp(), 'file-not-a-folder');
    fs.writeFileSync(blocked, '');
    const result = writeProjectConfig(ws, { providers: [{ type: 'openai', apiKey: 'sk-here' }] }, blocked);
    expect(result.ok).toBe(false);
  });
});
