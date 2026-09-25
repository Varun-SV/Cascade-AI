import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from './index.js';
import { globalDir, migrateProjectState, projectStateDir, statePath, statePathFor, STATE, useProjectStateDir } from './project-state.js';
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
    // A host that must not write the global folder names its own.
    useProjectStateDir(b, path.join(b, 'state'));
    expect(statePath(b, STATE.config)).toBe(path.join(b, 'state', 'config.json'));
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
    fs.mkdirSync(path.join(ws, '.cascade'));
    fs.writeFileSync(path.join(ws, '.cascade', 'dead-models.json'), 'old');
    fs.mkdirSync(projectStateDir(ws), { recursive: true });
    fs.writeFileSync(statePath(ws, STATE.deadModels), 'new');
    expect(migrateProjectState(ws)).toEqual([]);
    expect(fs.readFileSync(statePath(ws, STATE.deadModels), 'utf-8')).toBe('new');
    expect(fs.existsSync(path.join(ws, '.cascade', 'dead-models.json'))).toBe(true);
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
});
