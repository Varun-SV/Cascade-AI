import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_TOOLS as SDK_TOOLS, READ_TOOLS as SDK_READ } from '../../src/workspace/protocol.js';
import {
  CONSENT_MAX_MS, EDIT_TOOLS, PRESETS, READ_TOOLS, WORKSPACE_TOOLS, buildLabel, consentWindowMs, leaksPath, presetOf, sanitizeTools,
  summarizeCall, validateFolder, type FolderFs,
} from './workspace-consent.js';
import * as renderer from '../src/lib/workspace-tools.js';

const home = path.resolve(os.homedir());
const fsOf = (dirs: string[]): FolderFs => ({
  home: () => home,
  realpath: (p) => (dirs.includes(p) || p === home ? p : null),
  isDirectory: (p) => dirs.includes(p) || p === home,
});

describe('tool presets', () => {
  it('match the SDK\'s workspace tools exactly, here and in the window', () => {
    expect([...WORKSPACE_TOOLS].sort()).toEqual([...SDK_TOOLS].sort());
    expect([...READ_TOOLS]).toEqual([...SDK_READ]);
    expect([...renderer.ALL_TOOLS]).toEqual([...WORKSPACE_TOOLS]);
    expect([...renderer.EDIT_TOOLS]).toEqual([...EDIT_TOOLS]);
    expect([...renderer.READ_TOOLS]).toEqual([...READ_TOOLS]);
  });
  it('are read only, then plus edits, then plus programs', () => {
    expect(PRESETS.read.tools).toEqual(['file_list', 'file_read', 'glob', 'grep']);
    expect(PRESETS.edit.tools).toEqual(expect.arrayContaining(['file_write', 'file_edit', 'file_delete']));
    expect(PRESETS.edit.tools).not.toContain('shell');
    expect(PRESETS.all.tools).toEqual(expect.arrayContaining(['shell', 'git', 'run_code']));
  });
  it('keep only workspace tools, once, whatever the window sends', () => {
    expect(sanitizeTools(['shell', 'shell', 'rm_rf', 'file_read', 7, null])).toEqual(['file_read', 'shell']);
    expect(sanitizeTools('shell')).toEqual([]);
    expect(presetOf(PRESETS.edit.tools)).toBe('edit');
    expect(presetOf(['file_read'])).toBeNull();
  });
});

describe('folder validation', () => {
  it('refuses the home folder, a filesystem root, a folder holding home, a missing one and a relative one', () => {
    const f = fsOf([path.parse(home).root, path.dirname(home)]);
    expect(validateFolder(home, f)).toHaveProperty('error');
    expect(validateFolder(path.parse(home).root, f)).toHaveProperty('error');
    expect(validateFolder(path.dirname(home), f)).toHaveProperty('error');
    expect(validateFolder(path.join(home, 'missing'), f)).toHaveProperty('error');
    expect(validateFolder('relative/dir', f)).toHaveProperty('error');
    expect(validateFolder('', f)).toHaveProperty('error');
    expect(validateFolder(42, f)).toHaveProperty('error');
  });
  it('accepts a project folder, including one inside home', () => {
    const proj = path.join(home, 'projects', 'app');
    expect(validateFolder(proj, fsOf([proj]))).toEqual({ ok: true, folder: proj });
  });
});

describe('the label', () => {
  const folder = path.join(home, 'secret-client', 'repo');
  it('is "Workspace on <device>" by default and the folder\'s own name on request, never the path', () => {
    expect(buildLabel('device', 'Ana\'s laptop', folder)).toBe('Workspace on Ana\'s laptop');
    expect(buildLabel('folder', 'Ana\'s laptop', folder)).toBe('repo');
    for (const mode of ['device', 'folder'] as const) {
      const label = buildLabel(mode, 'PC', folder);
      expect(label).not.toContain('secret-client');
      expect(leaksPath(label, folder)).toBe(false);
    }
  });
  it('strips separators and control characters from a device name, and caps its length', () => {
    const label = buildLabel('device', `a/b\\c\n${'x'.repeat(200)}`, folder);
    expect(label).not.toMatch(/[\\/\n]/);
    expect(label.length).toBeLessThanOrEqual(80);
  });
  it('detects a path in text', () => {
    expect(leaksPath(`error in ${folder}/a.ts`, folder)).toBe(true);
    expect(leaksPath('fine', folder)).toBe(false);
  });
});

describe('showing a call', () => {
  it('shows the command or the path, cut short', () => {
    expect(summarizeCall('shell', { command: 'rm -rf build' })).toBe('rm -rf build');
    expect(summarizeCall('file_delete', { path: 'a/b.txt' })).toBe('a/b.txt');
    expect(summarizeCall('shell', { command: 'x'.repeat(5000) }).length).toBeLessThan(2100);
  });
});

describe('consent timing', () => {
  it('lapses with the offer, and never stays open longer than the cap', () => {
    expect(consentWindowMs(10_000, 4_000)).toBe(6_000);
    expect(consentWindowMs(1_000, 4_000)).toBe(0);
    expect(consentWindowMs(10 ** 13, 0)).toBe(CONSENT_MAX_MS);
  });
});
