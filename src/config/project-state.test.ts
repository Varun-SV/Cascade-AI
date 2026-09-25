import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from './index.js';
import { globalDir, migrateProjectState, projectStateDir, stateNotices, statePath, statePathFor, STATE, useProjectStateDir } from './project-state.js';
import { writeProjectConfig } from './write-config.js';

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const credentials = () => JSON.parse(fs.readFileSync(path.join(globalDir(), 'credentials.json'), 'utf-8')) as {
  providers: Array<{ type: string; apiKey?: string }>;
  projects?: Record<string, Array<{ type: string; apiKey?: string }>>;
};

describe('a project\'s state folder', () => {
  it('is under the global folder, one per project, whatever name the project is opened by', () => {
    const a = tempDir('cascade-state-a-');
    const b = tempDir('cascade-state-b-');
    const link = `${a}-link`;
    fs.symlinkSync(a, link);
    made.push(link);
    expect(projectStateDir(a).startsWith(path.join(globalDir(), 'projects', path.basename(a)))).toBe(true);
    expect(projectStateDir(link)).toBe(projectStateDir(a));
    expect(projectStateDir(b)).not.toBe(projectStateDir(a));
    // A host that must not write the global folder names its own — outside
    // the workspace, whose tools would read it there.
    expect(() => useProjectStateDir(b, path.join(b, '.cascade'))).toThrow(/must be apart/);
    expect(() => useProjectStateDir(b, b)).toThrow(/must be apart/);
    // Nor around it, where the whole workspace would be taken for state.
    expect(() => useProjectStateDir(b, path.dirname(b))).toThrow(/must be apart/);
    // A name beginning with two dots is inside, not a way out.
    expect(() => useProjectStateDir(b, path.join(b, '..state'))).toThrow(/must be apart/);
    const own = `${b}-state`;
    made.push(own);
    useProjectStateDir(b, own);
    expect(statePath(b, STATE.config)).toBe(path.join(own, 'config.json'));
  });

  // The hosted server named a state folder for every tenant that ever ran,
  // and never forgot one.
  it('is forgotten once the last run a host holds it for ends', () => {
    const ws = tempDir('cascade-state-held-');
    const own = `${ws}-state`;
    made.push(own);
    const one = useProjectStateDir(ws, own);
    const two = useProjectStateDir(ws, own);
    one();
    one();
    expect(projectStateDir(ws), 'another run still holds it').toBe(own);
    two();
    expect(projectStateDir(ws).startsWith(path.join(globalDir(), 'projects'))).toBe(true);
  });

  it('is where @private/ and @screenshots/ tool paths lead, and nothing else is', () => {
    const ws = tempDir('cascade-state-prefix-');
    expect(statePathFor(ws, '@private/notes/a.md')).toBe(path.join(projectStateDir(ws), 'private', 'notes', 'a.md'));
    expect(statePathFor(ws, '@screenshots/s.png')).toBe(path.join(projectStateDir(ws), 'screenshots', 's.png'));
    expect(statePathFor(ws, '@privateer/a.md')).toBeNull();
    expect(statePathFor(ws, 'src/@private/a.md')).toBeNull();
  });
});

// Everything Cascade kept about a project sat in the project's own
// .cascade/ — the config with the provider keys in it included.
describe('moving a project\'s state out of its .cascade/', () => {
  it('moves each entry, takes the keys out of the config into the global store, and removes the folder', async () => {
    const ws = tempDir('cascade-legacy-');
    const legacy = path.join(ws, '.cascade');
    fs.mkdirSync(path.join(legacy, 'resume'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ providers: [{ type: 'anthropic', apiKey: 'sk-project' }] }));
    fs.writeFileSync(path.join(legacy, 'resume', 'run-1.json'), '{}');
    fs.writeFileSync(path.join(legacy, 'privacy-derived.json'), JSON.stringify({ version: 1, paths: ['summary.md'] }));

    const mgr = new ConfigManager(ws);
    await mgr.load();

    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(statePath(ws, 'resume', 'run-1.json'))).toBe(true);
    expect(fs.existsSync(statePath(ws, STATE.privacyDerived))).toBe(true);
    expect(fs.readFileSync(statePath(ws, STATE.config), 'utf-8')).not.toContain('sk-project');
    // The key is the project's own, and the machine-wide one as there was none.
    const store = credentials();
    expect(store.providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-project');
    expect(store.projects?.[path.basename(projectStateDir(ws))]?.[0]?.apiKey).toBe('sk-project');
    expect(mgr.getConfig().providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-project');
  });

  it('keeps a project\'s own key when the machine-wide one differs, and uses it there only', async () => {
    fs.mkdirSync(globalDir(), { recursive: true });
    fs.writeFileSync(path.join(globalDir(), 'credentials.json'), JSON.stringify({ version: 1, providers: [{ type: 'anthropic', apiKey: 'sk-machine' }] }));
    const ws = tempDir('cascade-legacy-own-');
    const other = tempDir('cascade-legacy-other-');
    fs.mkdirSync(path.join(ws, '.cascade'));
    fs.writeFileSync(path.join(ws, '.cascade', 'config.json'), JSON.stringify({ providers: [{ type: 'anthropic', apiKey: 'sk-own' }] }));

    const mine = new ConfigManager(ws);
    await mine.load();
    const elsewhere = new ConfigManager(other);
    await elsewhere.load();

    expect(mine.getConfig().providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-own');
    expect(elsewhere.getConfig().providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-machine');
    expect(credentials().providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-machine');
  });

  it('leaves an entry the state folder already has, and the folder with it', () => {
    const ws = tempDir('cascade-legacy-both-');
    fs.writeFileSync(statePath(ws, STATE.deadModels), 'new');
    fs.mkdirSync(path.join(ws, '.cascade'));
    fs.writeFileSync(path.join(ws, '.cascade', 'dead-models.json'), 'old');
    expect(migrateProjectState(ws)).toEqual([]);
    expect(fs.readFileSync(statePath(ws, STATE.deadModels), 'utf-8')).toBe('new');
    expect(fs.existsSync(path.join(ws, '.cascade', 'dead-models.json'))).toBe(true);
  });
});

// Whatever opens the state folder first — `cascade identity list` opens the
// session store and nothing else — has to find what was in `.cascade/`: a
// new, empty file there would keep the old one from ever moving in.
describe('moving it on first use', () => {
  it('happens for whatever opens the state folder first, not only a config load', () => {
    const ws = tempDir('cascade-legacy-first-');
    fs.mkdirSync(path.join(ws, '.cascade'));
    fs.writeFileSync(path.join(ws, '.cascade', 'memory.db'), 'sessions');
    expect(fs.readFileSync(statePath(ws, STATE.memoryDb), 'utf-8')).toBe('sessions');
    expect(fs.existsSync(path.join(ws, '.cascade'))).toBe(false);
    // Reported once, to whoever asks first.
    expect(migrateProjectState(ws)).toEqual(['memory.db']);
    expect(migrateProjectState(ws)).toEqual([]);
  });

  // Across filesystems the move is a copy; one cut short left a partial
  // entry that every later attempt took as moved, stranding the real one.
  it('retries a cross-device move that was cut short, never taking the partial copy as moved', () => {
    const ws = tempDir('cascade-legacy-exdev-');
    fs.mkdirSync(path.join(ws, '.cascade'));
    fs.writeFileSync(path.join(ws, '.cascade', 'memory.db'), 'sessions');
    const rename = fs.renameSync;
    const crossDevice = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith(path.join('.cascade', 'memory.db'))) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      return rename(from, to);
    });
    const cutShort = vi.spyOn(fs, 'cpSync').mockImplementationOnce((_from, to) => {
      fs.writeFileSync(String(to), 'sess');
      throw new Error('ENOSPC');
    });
    try {
      expect(fs.existsSync(statePath(ws, STATE.memoryDb))).toBe(false);
      expect(fs.readFileSync(path.join(ws, '.cascade', 'memory.db'), 'utf-8')).toBe('sessions');
      expect(migrateProjectState(ws)).toEqual(['memory.db']);
      expect(fs.readFileSync(statePath(ws, STATE.memoryDb), 'utf-8')).toBe('sessions');
      expect(fs.readdirSync(projectStateDir(ws)).filter((f) => f.includes('partial'))).toEqual([]);
    } finally {
      crossDevice.mockRestore();
      cutShort.mockRestore();
    }
  });

  it('leaves a .cascade that is a symlink, and what it points at, alone', () => {
    const ws = tempDir('cascade-legacy-link-');
    const elsewhere = tempDir('cascade-legacy-target-');
    fs.writeFileSync(path.join(elsewhere, 'id_rsa'), 'key');
    fs.symlinkSync(elsewhere, path.join(ws, '.cascade'));
    expect(migrateProjectState(ws)).toEqual([]);
    expect(fs.readFileSync(path.join(elsewhere, 'id_rsa'), 'utf-8')).toBe('key');
    expect(fs.existsSync(statePath(ws, 'id_rsa'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('makes the folder, and those above it, readable by this user alone', () => {
    fs.mkdirSync(globalDir(), { recursive: true });
    fs.chmodSync(globalDir(), 0o755);
    const dir = projectStateDir(tempDir('cascade-state-mode-'));
    for (const d of [globalDir(), path.join(globalDir(), 'projects'), dir]) {
      expect(fs.statSync(d).mode & 0o777, d).toBe(0o700);
    }
  });
});

// A project's state is found by its path: renamed or moved, it started
// afresh — its local-only rules and the record of what local-only subtasks
// wrote left behind, and the files that record covered readable again.
describe('a project that moves', () => {
  it('takes its state along when renamed or moved on its disk, its own keys included', async () => {
    const before = tempDir('cascade-moving-');
    fs.writeFileSync(path.join(before, 'notes.md'), 'x');
    fs.writeFileSync(statePath(before, STATE.privacyDerived), JSON.stringify({ version: 1, paths: ['notes.md'] }));
    fs.mkdirSync(path.join(before, '.cascade'));
    fs.writeFileSync(path.join(before, '.cascade', 'config.json'), JSON.stringify({ providers: [{ type: 'anthropic', apiKey: 'sk-own' }] }));
    await new ConfigManager(before).load();
    const oldDir = projectStateDir(before);
    const after = `${before}-renamed`;
    fs.renameSync(before, after);
    made.push(after);

    expect(fs.readFileSync(statePath(after, STATE.privacyDerived), 'utf-8')).toContain('notes.md');
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(credentials().projects?.[path.basename(projectStateDir(after))]?.[0]?.apiKey).toBe('sk-own');
    expect(stateNotices(after).join(' ')).toMatch(/where it was before it moved/);
    const mgr = new ConfigManager(after);
    await mgr.load();
    expect(mgr.getConfig().providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-own');
  });

  // The folder moved but its own keys stayed filed under the old name, for
  // good, when the store could not take the change the first time.
  it('files its own keys under the new name once the store takes the change', async () => {
    const before = tempDir('cascade-moving-keys-');
    fs.mkdirSync(path.join(before, '.cascade'));
    fs.writeFileSync(path.join(before, '.cascade', 'config.json'), JSON.stringify({ providers: [{ type: 'anthropic', apiKey: 'sk-own' }] }));
    await new ConfigManager(before).load();
    const oldName = path.basename(projectStateDir(before));
    const store = path.join(globalDir(), 'credentials.json');
    const good = fs.readFileSync(store, 'utf-8');
    fs.writeFileSync(store, '{"version":1,');
    const after = `${before}-renamed`;
    fs.renameSync(before, after);
    made.push(after);

    const newName = path.basename(projectStateDir(after));
    expect(stateNotices(after).join(' ')).toMatch(/could not yet file this project's own provider keys/);
    fs.writeFileSync(store, good);
    migrateProjectState(after);
    expect(credentials().projects?.[newName]?.[0]?.apiKey).toBe('sk-own');
    expect(credentials().projects?.[oldName]).toBeUndefined();
    expect(fs.readFileSync(path.join(projectStateDir(after), 'project.json'), 'utf-8')).not.toContain('keysFrom');
  });

  // Its state is found by path: a folder deleted and another made in its
  // place inherited all of it — sessions and memories that then surfaced in
  // an unrelated project.
  it('sets aside what an earlier folder at the same path did and knew, and keeps its settings', async () => {
    const ws = tempDir('cascade-same-path-');
    await new ConfigManager(ws).load();
    fs.writeFileSync(statePath(ws, STATE.config), JSON.stringify({ privacy: { paths: [{ pattern: 'secret/**', policy: 'local-only' }] } }));
    fs.writeFileSync(statePath(ws, STATE.privacyDerived), JSON.stringify({ version: 1, paths: ['a.md'] }));
    fs.writeFileSync(statePath(ws, STATE.memoryDb), 'old sessions');
    fs.mkdirSync(statePath(ws, STATE.private), { recursive: true });
    fs.writeFileSync(statePath(ws, STATE.private, 'out.md'), 'old output');
    const config = fs.readFileSync(statePath(ws, STATE.config), 'utf-8');
    // Another folder takes its place — made before the old one goes, so it
    // cannot be given the old one's inode.
    fs.mkdirSync(`${ws}-new`);
    fs.rmSync(ws, { recursive: true });
    fs.renameSync(`${ws}-new`, ws);

    migrateProjectState(ws);
    expect(fs.existsSync(statePath(ws, STATE.memoryDb))).toBe(false);
    expect(fs.existsSync(statePath(ws, STATE.private, 'out.md'))).toBe(false);
    expect(fs.readFileSync(statePath(ws, STATE.config), 'utf-8')).toBe(config);
    expect(fs.readFileSync(statePath(ws, STATE.privacyDerived), 'utf-8')).toContain('a.md');
    const aside = /set aside in (\S+)\.$/.exec(stateNotices(ws).join(' '))?.[1];
    expect(aside && fs.readFileSync(path.join(aside, STATE.memoryDb), 'utf-8')).toBe('old sessions');
    made.push(aside!);
    // The same folder, opened again, keeps what it has since.
    fs.writeFileSync(statePath(ws, STATE.memoryDb), 'new sessions');
    migrateProjectState(ws);
    expect(fs.readFileSync(statePath(ws, STATE.memoryDb), 'utf-8')).toBe('new sessions');
  });

  it('starts a copy afresh, saying where the state of the one that is gone is', () => {
    const parent = tempDir('cascade-copying-');
    const original = path.join(parent, 'app');
    fs.mkdirSync(original);
    fs.writeFileSync(statePath(original, STATE.privacyDerived), JSON.stringify({ version: 1, paths: ['a.md'] }));
    const elsewhere = tempDir('cascade-copied-');
    const copy = path.join(elsewhere, 'app');
    fs.cpSync(original, copy, { recursive: true });
    fs.rmSync(original, { recursive: true });

    expect(fs.existsSync(statePath(copy, STATE.privacyDerived))).toBe(false);
    expect(stateNotices(copy).join(' ')).toMatch(/was not taken as this one's/);
  });

  // The same folder seen at a second path — a bind mount — while it is
  // still at the first: each keeps its own state, and neither takes the other's.
  it('leaves the state of a folder still at its own path where it is', () => {
    const first = tempDir('cascade-bound-');
    const firstDir = projectStateDir(first);
    const second = tempDir('cascade-bound-');
    const stat = fs.statSync;
    const same = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: fs.StatSyncOptions) =>
      stat(String(p) === second ? first : p, opts)) as typeof fs.statSync);
    try {
      expect(projectStateDir(second)).not.toBe(firstDir);
      expect(fs.existsSync(firstDir)).toBe(true);
    } finally {
      same.mockRestore();
    }
  });

  it('leaves a project that is still where it was alone', () => {
    const one = tempDir('cascade-staying-');
    const oneDir = projectStateDir(one);
    const two = tempDir('cascade-staying-');
    expect(projectStateDir(two)).not.toBe(oneDir);
    expect(fs.existsSync(oneDir)).toBe(true);
    expect(stateNotices(two)).toEqual([]);
  });
});

describe('saving a project\'s config', () => {
  it('writes no key into it, whoever writes it, and the key reaches every project', async () => {
    const ws = tempDir('cascade-save-');
    const other = tempDir('cascade-save-other-');
    const mgr = new ConfigManager(ws);
    await mgr.load();
    await mgr.save({ ...mgr.getConfig(), providers: [{ type: 'openai', apiKey: 'sk-saved' }] });
    expect(fs.readFileSync(statePath(ws, STATE.config), 'utf-8')).not.toContain('sk-saved');
    expect(fs.existsSync(path.join(ws, '.cascade'))).toBe(false);

    expect(writeProjectConfig(ws, { providers: [{ type: 'openai', apiKey: 'sk-written' }] }).ok).toBe(true);
    expect(fs.readFileSync(statePath(ws, STATE.config), 'utf-8')).not.toContain('sk-written');

    const elsewhere = new ConfigManager(other);
    await elsewhere.load();
    expect(elsewhere.getConfig().providers.find((p) => p.type === 'openai')?.apiKey).toBe('sk-written');
  });

  it('updates a project\'s own key there, and drops it when the key is removed', async () => {
    fs.mkdirSync(globalDir(), { recursive: true });
    fs.writeFileSync(path.join(globalDir(), 'credentials.json'), JSON.stringify({ version: 1, providers: [{ type: 'anthropic', apiKey: 'sk-machine' }] }));
    const ws = tempDir('cascade-own-save-');
    fs.mkdirSync(path.join(ws, '.cascade'));
    fs.writeFileSync(path.join(ws, '.cascade', 'config.json'), JSON.stringify({ providers: [{ type: 'anthropic', apiKey: 'sk-own' }] }));
    const mgr = new ConfigManager(ws);
    await mgr.load();
    const id = path.basename(projectStateDir(ws));

    await mgr.save({ ...mgr.getConfig(), providers: [{ type: 'anthropic', apiKey: 'sk-own-2' }] });
    expect(credentials().projects?.[id]?.[0]?.apiKey).toBe('sk-own-2');

    await mgr.save({ ...mgr.getConfig(), providers: [{ type: 'anthropic' }] });
    expect(credentials().projects?.[id]).toBeUndefined();
  });

  // The config keeps no key now, so a key that is not stored is lost.
  it('fails, and leaves the config as it was, when the keys cannot be stored', async () => {
    const ws = tempDir('cascade-save-fail-');
    const mgr = new ConfigManager(ws);
    await mgr.load();
    await mgr.save({ ...mgr.getConfig(), providers: [{ type: 'openai', apiKey: 'sk-first' }] });
    const before = fs.readFileSync(statePath(ws, STATE.config), 'utf-8');
    const store = path.join(globalDir(), 'credentials.json');
    fs.rmSync(store, { force: true });
    fs.mkdirSync(store);
    try {
      const next = { ...mgr.getConfig(), providers: [{ type: 'openai', apiKey: 'sk-first' }, { type: 'anthropic', apiKey: 'sk-second' }] } as never;
      await expect(mgr.save(next)).rejects.toThrow(/provider keys could not be saved/);
      expect(writeProjectConfig(ws, next).ok).toBe(false);
      expect(fs.readFileSync(statePath(ws, STATE.config), 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  // The keys are written first; a config that then could not be written left
  // their change standing — for every project — under a save reported failed.
  it('takes the keys\' change back when the config cannot be written after it', async () => {
    const ws = tempDir('cascade-config-fail-');
    const mgr = new ConfigManager(ws);
    await mgr.load();
    await mgr.save({ ...mgr.getConfig(), providers: [{ type: 'openai', apiKey: 'sk-kept' }] });
    const store = fs.readFileSync(path.join(globalDir(), 'credentials.json'), 'utf-8');
    const config = statePath(ws, STATE.config);
    fs.rmSync(config);
    fs.mkdirSync(config);
    try {
      const next = { ...mgr.getConfig(), providers: [{ type: 'openai', apiKey: 'sk-replaced' }] } as never;
      await expect(mgr.save(next)).rejects.toThrow();
      expect(writeProjectConfig(ws, next).ok).toBe(false);
      expect(fs.readFileSync(path.join(globalDir(), 'credentials.json'), 'utf-8')).toBe(store);
    } finally {
      fs.rmSync(config, { recursive: true, force: true });
    }
  });

  it('keeps a moved config\'s keys in it while the store cannot take them', async () => {
    const ws = tempDir('cascade-adopt-fail-');
    fs.mkdirSync(path.join(ws, '.cascade'));
    fs.writeFileSync(path.join(ws, '.cascade', 'config.json'), JSON.stringify({ providers: [{ type: 'anthropic', apiKey: 'sk-kept' }] }));
    const store = path.join(globalDir(), 'credentials.json');
    fs.rmSync(store, { force: true });
    fs.mkdirSync(store, { recursive: true });
    try {
      const mgr = new ConfigManager(ws);
      await mgr.load();
      expect(mgr.getConfig().providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-kept');
      expect(fs.readFileSync(statePath(ws, STATE.config), 'utf-8')).toContain('sk-kept');
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});
