import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPlainGitSetting, parseScopedConfig, unjailedSettings } from './git-hermetic.js';
import { ToolRegistry } from './registry.js';
import type { JailKind, JailPolicy } from './jail/process-jail.js';

const listing = (...entries: Array<[string, string, string | null]>) =>
  entries.map(([scope, key, value]) => `${scope}\0${key}${value === null ? '' : `\n${value}`}\0`).join('');

const carried = (env: Record<string, string>) => {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < Number(env['GIT_CONFIG_COUNT'] ?? 0); i++) out.push([env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!]);
  return out;
};

describe('which git settings are words', () => {
  it('takes line endings, names, remotes and URL rewrites; not drivers, helpers or commands', () => {
    for (const key of ['core.autocrlf', 'user.name', 'remote.origin.url', 'remote.up stream.fetch', 'branch.main.merge',
      'url.git@github.com:.insteadof', 'color.diff.meta', 'color.ui', 'http.https://x/.extraheader', 'diff.md.xfuncname', 'commit.gpgsign']) {
      expect(isPlainGitSetting(key), key).toBe(true);
    }
    for (const key of ['diff.external', 'diff.md.textconv', 'diff.md.command', 'filter.lfs.clean', 'filter.lfs.process',
      'merge.ours.driver', 'credential.helper', 'credential.https://x.helper', 'core.sshcommand', 'core.fsmonitor', 'core.pager',
      'core.editor', 'core.worktree', 'core.hookspath', 'remote.origin.uploadpack', 'remote.origin.receivepack', 'remote.origin.vcs',
      'submodule.lib.update', 'include.path', 'includeif.gitdir:~/x.path', 'gpg.program', 'gpg.ssh.program', 'alias.x',
      'protocol.ext.allow', 'uploadpack.packobjectshook', 'log.showsignature', 'something.new']) {
      expect(isPlainGitSetting(key), key).toBe(false);
    }
  });

  it('reads git\'s scoped listing, a bare key included', () => {
    expect(parseScopedConfig(listing(['global', 'user.name', 'A B'], ['local', 'core.bare', null], ['local', 'x.y', 'multi\nline']))).toEqual([
      { scope: 'global', key: 'user.name', value: 'A B' },
      { scope: 'local', key: 'core.bare', value: null },
      { scope: 'local', key: 'x.y', value: 'multi\nline' },
    ]);
  });
});

describe('git without a jail', () => {
  it('refuses while the repository\'s own configuration names a program, and says which', () => {
    const r = unjailedSettings(listing(['local', 'core.bare', 'false'], ['local', 'diff.external', '/tmp/x'], ['worktree', 'core.sshcommand', 'ssh -i k']), {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/diff\.external, core\.sshcommand/);
    expect(!r.ok && r.reason).toMatch(/tools\.processJail to "off"/);
    // The value is not repeated: it can be a secret.
    expect(!r.ok && r.reason).not.toContain('/tmp/x');
  });

  it('reads no global or system file, and hands on what they set that is a word', () => {
    const r = unjailedSettings(listing(
      ['system', 'core.autocrlf', 'true'],
      ['system', 'credential.helper', 'manager'],
      ['global', 'user.name', 'Ada'],
      ['global', 'core.autocrlf', 'input'],
      ['global', 'diff.external', 'difftool'],
      ['global', 'core.sshcommand', 'ssh -i key'],
      ['local', 'user.name', 'Local Ada'],
    ), { PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'less', GIT_CONFIG_PARAMETERS: "'core.editor'='vi'" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env['GIT_CONFIG_GLOBAL']).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
    expect(r.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(r.env['GIT_CONFIG_PARAMETERS']).toBeUndefined();
    expect(r.env['PATH']).toBe('/bin');
    const given = carried(r.env);
    // Words, in the order git read them, the last one winning; the repository's own name is read as it is.
    expect(given.filter(([k]) => ['core.autocrlf', 'user.name'].includes(k))).toEqual([['core.autocrlf', 'true'], ['core.autocrlf', 'input']]);
    // Programs are left out.
    for (const program of ['credential.helper', 'diff.external', 'core.sshcommand', 'core.pager']) {
      expect(given.some(([k]) => k === program), program).toBe(false);
    }
    // And git is told to start none of its own.
    expect(given).toEqual(expect.arrayContaining([['core.fsmonitor', 'false'], ['protocol.ext.allow', 'never'], ['commit.gpgSign', 'false']]));
  });

  it('marks a filter the left-out files define as required, so a file that needs it is not added unfiltered', () => {
    const r = unjailedSettings(listing(['global', 'filter.lfs.clean', 'git-lfs clean -- %f'], ['global', 'filter.lfs.smudge', 'git-lfs smudge -- %f'], ['global', 'filter.a.b.process', 'x']), {});
    expect(r.ok && carried(r.env).filter(([k]) => k.startsWith('filter.'))).toEqual([['filter.lfs.required', 'true'], ['filter.a.b.required', 'true']]);
  });

  it('says when commits are to be signed, as the last setting read has it', () => {
    const signs = (...e: Array<[string, string, string | null]>) => { const r = unjailedSettings(listing(...e), {}); return r.ok && r.signsCommits; };
    expect(signs(['global', 'commit.gpgsign', 'true'])).toBe(true);
    expect(signs(['global', 'commit.gpgsign', 'true'], ['local', 'commit.gpgsign', 'false'])).toBe(false);
    expect(signs(['local', 'commit.gpgsign', null])).toBe(true);
    expect(signs()).toBe(false);
  });
});

// The same, end to end: the git tool through the registry, on a machine with
// no jailer (as on Windows, or a Linux without working bubblewrap), with a
// real repository and git.
describe('the git tool without a jail', () => {
  const none = async (): Promise<JailKind | null> => null;
  const exec = { tierId: 't3', sessionId: 's' };
  let ws: string;
  let home: string;
  let marker: string;
  let program: string;
  const saved = { ...process.env };
  const g = (...args: string[]) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8', env: process.env });

  function registry(): ToolRegistry {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {}, processJail: 'auto' } as never, ws);
    (reg as unknown as { processJail: { policy: JailPolicy } }).processJail.policy.detect = none;
    return reg;
  }

  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-hermetic-ws-')));
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-hermetic-home-')));
    marker = path.join(home, 'program-ran');
    program = path.join(home, 'program.sh');
    fs.writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o755 });
    // A global file of the test's own, and nothing from this machine's.
    for (const name of Object.keys(process.env)) if (/^GIT_/.test(name)) delete process.env[name];
    process.env['GIT_CONFIG_GLOBAL'] = path.join(home, 'gitconfig');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    fs.writeFileSync(process.env['GIT_CONFIG_GLOBAL'], '[user]\n\tname = Global Ada\n\temail = ada@example.com\n');
    g('init', '-q');
    fs.writeFileSync(path.join(ws, 'a.md'), 'a\n');
    g('add', '.');
    g('commit', '-qm', 'a');
    fs.writeFileSync(path.join(ws, 'a.md'), 'b\n');
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('refuses a repository whose configuration names a program, and runs none', async () => {
    g('config', 'diff.external', program);
    await expect(registry().execute('git', { operation: 'diff' }, exec)).rejects.toThrow(/configuration has one: diff\.external/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('runs git with the global file\'s words and none of its programs', async () => {
    fs.appendFileSync(process.env['GIT_CONFIG_GLOBAL']!, `[diff]\n\texternal = ${program}\n[core]\n\tpager = ${program}\n\tfsmonitor = ${program}\n`);
    const diff = await registry().execute('git', { operation: 'diff' }, exec);
    expect(diff).toContain('+b');
    await registry().execute('git', { operation: 'add', args: ['a.md'] }, exec);
    await registry().execute('git', { operation: 'commit', args: ['b'] }, exec);
    // The name came from the global file, handed on as a word.
    expect(g('log', '-1', '--format=%an <%ae>').trim()).toBe('Global Ada <ada@example.com>');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not add a file unfiltered when the filter it needs was left out', async () => {
    fs.appendFileSync(process.env['GIT_CONFIG_GLOBAL']!, `[filter "lfs"]\n\tclean = ${program}\n\tsmudge = ${program}\n`);
    fs.writeFileSync(path.join(ws, '.gitattributes'), '*.bin filter=lfs\n');
    fs.writeFileSync(path.join(ws, 'big.bin'), 'binary\n');
    await expect(registry().execute('git', { operation: 'add', args: ['big.bin'] }, exec)).rejects.toThrow(/clean filter 'lfs' failed/);
    expect(g('diff', '--cached', '--name-only').trim()).toBe('');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('makes no commit the user\'s configuration would sign', async () => {
    fs.appendFileSync(process.env['GIT_CONFIG_GLOBAL']!, `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${program}\n`);
    await registry().execute('git', { operation: 'add', args: ['a.md'] }, exec);
    await expect(registry().execute('git', { operation: 'commit', args: ['b'] }, exec)).rejects.toThrow(/signs commits/);
    expect(g('log', '--format=%s').trim()).toBe('a');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
