// The process jail for shell, run_code and git. The unit tests run
// everywhere; the ones that launch real commands in bubblewrap run where it
// works (Linux with unprivileged user namespaces, or as root).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../registry.js';
import { PrivacyPaths } from '../../core/privacy/paths.js';
import {
  ProcessJail, bwrapArgs, collectHidden, detectJail, scrubEnv, seatbeltProfile,
  type JailKind, type JailPolicy,
} from './process-jail.js';

const SECRET = 'sk-live-JAILTEST-0123456789';
const LOCAL = 'LOCAL-ONLY-LAUNCH-PLAN';

let ws: string;
beforeAll(async () => {
  ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-jail-')));
  await fs.mkdir(path.join(ws, '.cascade', 'tmp'), { recursive: true });
  await fs.writeFile(path.join(ws, '.cascade', 'config.json'), `{ "apiKey": "${SECRET}" }`);
  await fs.writeFile(path.join(ws, '.cascade', 'audit_log.db-wal'), 'journal');
  await fs.writeFile(path.join(ws, '.env'), `KEY=${SECRET}`);
  await fs.mkdir(path.join(ws, 'keys'));
  await fs.writeFile(path.join(ws, 'keys', 'server.pem'), 'PEM');
  await fs.mkdir(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(ws, 'node_modules', 'pkg', 'fixture.pem'), 'a package test key');
  await fs.mkdir(path.join(ws, 'secret'));
  await fs.writeFile(path.join(ws, 'secret', 'plan.md'), LOCAL);
  await fs.writeFile(path.join(ws, 'notes.md'), 'public notes');
});
afterAll(async () => { await fs.rm(ws, { recursive: true, force: true }); });

function policy(over: Partial<JailPolicy> = {}): JailPolicy {
  const builtIns = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false } as never, ws);
  const privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);
  return {
    mode: 'auto',
    workspaceRoot: ws,
    isProtected: (rel) => builtIns.isProtected(path.join(ws, rel)),
    isLocalOnly: (rel) => privacy.isLocalOnly(rel),
    hiddenDirs: [],
    secretValues: () => [SECRET],
    log: () => {},
    ...over,
  };
}

describe('scrubEnv', () => {
  it('takes out provider keys by name and any variable holding a configured secret — nothing else', () => {
    const env = scrubEnv({
      PATH: '/usr/bin', ANTHROPIC_API_KEY: 'a', openai_api_key: 'b', CASCADE_DASHBOARD_SECRET: 'c',
      MY_APP_KEY: SECRET, GITHUB_TOKEN: 'ghp_for_git_push', SHORT: 'x',
    }, [SECRET, 'x']);
    expect(env).toEqual({ PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_for_git_push', SHORT: 'x' });
  });
});

describe('collectHidden', () => {
  it('hides Cascade\'s files, the secrets and local-only paths — not package fixtures, not the scratch folder', () => {
    const hidden = collectHidden(policy(), false).map((h) => path.relative(ws, h.path)).sort();
    expect(hidden).toEqual(['.cascade/audit_log.db-wal', '.cascade/config.json', '.env', 'keys/server.pem', 'secret/plan.md']);
  });

  it('leaves local-only paths in view of a caller that is local-only itself', () => {
    const hidden = collectHidden(policy(), true).map((h) => path.relative(ws, h.path));
    expect(hidden).not.toContain('secret/plan.md');
    expect(hidden).toContain('.cascade/config.json');
  });

  it('hides a directory matched whole as a directory, and the directories outside it is given', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-global-'));
    const hidden = collectHidden(policy({ isLocalOnly: (rel) => rel === 'secret/', hiddenDirs: [outside, '/nonexistent/x'] }), false);
    expect(hidden).toContainEqual({ path: path.join(ws, 'secret'), dir: true });
    expect(hidden).toContainEqual({ path: await fs.realpath(outside), dir: true });
    expect(hidden.some((h) => h.path.startsWith('/nonexistent'))).toBe(false);
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe('the launch each jailer is given', () => {
  const hidden = [{ path: '/w/.env', dir: false }, { path: '/home/u/.cascade-ai', dir: true }];

  it('bubblewrap: the host, its own processes, the hidden paths mounted over, no network for a local-only caller', () => {
    const args = bwrapArgs(hidden, true, '/w', 'sh', ['-c', 'ls']);
    expect(args.slice(0, 13)).toEqual(['--die-with-parent', '--new-session', '--unshare-pid', '--cap-drop', 'ALL', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net']);
    expect(args).toEqual(expect.arrayContaining(['--ro-bind', '/dev/null', '/w/.env', '--tmpfs', '/home/u/.cascade-ai']));
    expect(args.slice(-6)).toEqual(['--chdir', '/w', '--', 'sh', '-c', 'ls']);
    expect(bwrapArgs(hidden, false, '/w', 'sh', [])).not.toContain('--unshare-net');
  });

  it('sandbox-exec: the same paths denied, outbound connections too for a local-only caller', () => {
    const profile = seatbeltProfile([...hidden, { path: '/w/a "b".txt', dir: false }], true);
    expect(profile).toContain('(literal "/w/.env")');
    expect(profile).toContain('(subpath "/home/u/.cascade-ai")');
    expect(profile).toContain('(literal "/w/a \\"b\\".txt")');
    expect(profile).toContain('(deny network-outbound)');
    expect(seatbeltProfile(hidden, false)).not.toContain('network');
  });
});

describe('ProcessJail.prepare — which way a command runs', () => {
  const none = async (): Promise<JailKind | null> => null;
  const bwrap = async (): Promise<JailKind | null> => 'bwrap';

  it('"off" runs it as it is, environment and all', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'kept-when-off';
    const r = await new ProcessJail(policy({ mode: 'off', detect: none })).prepare('sh', ['-c', 'x'], { cwd: ws, offline: false });
    delete process.env['ANTHROPIC_API_KEY'];
    expect(r.ok && r.launch.jail).toBe(null);
    expect(r.ok && r.launch.env['ANTHROPIC_API_KEY']).toBe('kept-when-off');
  });

  it('"auto" without a jailer runs it with the keys taken out, and says so once', async () => {
    const said: string[] = [];
    const jail = new ProcessJail(policy({ detect: none, log: (m) => said.push(m) }));
    process.env['OPENAI_API_KEY'] = 'removed';
    const r = await jail.prepare('sh', [], { cwd: ws, offline: false });
    await jail.prepare('sh', [], { cwd: ws, offline: false });
    delete process.env['OPENAI_API_KEY'];
    expect(r.ok && r.launch.file).toBe('sh');
    expect(r.ok && r.launch.env['OPENAI_API_KEY']).toBeUndefined();
    expect(said).toHaveLength(1);
  });

  it('refuses a local-only caller when there is no jail to cut its network', async () => {
    const r = await new ProcessJail(policy({ detect: none })).prepare('sh', [], { cwd: ws, offline: true });
    expect(r.ok).toBe(false);
  });

  it('refuses outright when the jailer named is not there', async () => {
    const r = await new ProcessJail(policy({ mode: 'bwrap', detect: none })).prepare('sh', [], { cwd: ws, offline: false });
    expect(!r.ok && r.reason).toMatch(/"bwrap", which is not available/);
  });

  it('wraps it in the jailer there is', async () => {
    const r = await new ProcessJail(policy({ detect: bwrap })).prepare('sh', ['-c', 'ls'], { cwd: ws, offline: false });
    expect(r.ok && r.launch.file).toBe('bwrap');
    expect(r.ok && r.launch.args).toEqual(expect.arrayContaining(['--ro-bind', '/dev/null', path.join(ws, '.cascade', 'config.json')]));
  });
});

// ── Real commands, in a real jail ─────────────────────────────────────────
const bwrapWorks = (await detectJail()) === 'bwrap';

describe.skipIf(!bwrapWorks)('in bubblewrap: what shell, run_code and git can reach', () => {
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };
  function registry() {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, ws);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]));
    reg.setSecretValues(() => [SECRET]);
    return reg;
  }

  it('shell sees the workspace, but not Cascade\'s files, the secrets or a local-only path', async () => {
    const out = await registry().execute('shell', { command: 'cat notes.md; cat .cascade/config.json .env secret/plan.md 2>&1; true' }, exec);
    expect(out).toContain('public notes');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(LOCAL);
  });

  // Run as root — in a container, say — bubblewrap kept every capability, and
  // a command could unmount whatever hid a file.
  it('does not let a command take the mask off', async () => {
    const out = await registry().execute('shell', {
      command: 'umount .cascade/config.json 2>/dev/null; umount -l .cascade/config.json 2>/dev/null; cat .cascade/config.json 2>&1; true',
    }, exec);
    expect(out).not.toContain(SECRET);
  });

  // Scrubbing the child's environment is not enough on its own: a key
  // exported in the shell Cascade was started from is in Cascade's
  // /proc/<pid>/environ — the environment a process started with — for
  // anything the same user runs to read. The stand-in below started with it.
  it('shell cannot read a provider key from its own environment or from Cascade\'s', async () => {
    const { spawn } = await import('node:child_process');
    const cascade = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      env: { ...process.env, ANTHROPIC_API_KEY: SECRET }, stdio: 'ignore',
    });
    process.env['ANTHROPIC_API_KEY'] = SECRET;
    try {
      const out = await registry().execute('shell', {
        command: 'echo "env=[$ANTHROPIC_API_KEY]"; cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n" | grep -c JAILTEST; true',
      }, exec);
      expect(out).toContain('env=[]');
      expect(out).not.toContain(SECRET);
      expect(out.trim().split('\n').pop()).toBe('0');
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
      cascade.kill();
    }
  });

  it('a local-only caller sees the local-only path, and has no network to send it on', async () => {
    const server = net.createServer((s) => s.end('pong'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const probe = `node -e "require('net').connect(${port},'127.0.0.1').on('data',d=>{console.log('net:'+d);process.exit(0)}).on('error',e=>{console.log('net:'+e.code);process.exit(0)})"`;
    try {
      const online = await registry().execute('shell', { command: probe }, exec);
      expect(online).toContain('net:pong');
      const offline = await registry().execute('shell', { command: `cat secret/plan.md; ${probe}` }, { ...exec, isOffline: () => true });
      expect(offline).toContain(LOCAL);
      expect(offline).not.toContain('net:pong');
      expect(offline).toMatch(/net:E[A-Z]+/);
    } finally {
      server.close();
    }
  });

  it('run_code runs in the same jail', async () => {
    const out = await registry().execute('run_code', {
      language: 'nodejs',
      code: "const fs = require('fs'); for (const f of ['notes.md', '.cascade/config.json', 'secret/plan.md']) { try { console.log(f + '=' + fs.readFileSync(f, 'utf8')); } catch (e) { console.log(f + '=' + e.code); } }",
    }, exec);
    expect(out).toContain('notes.md=public notes');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(LOCAL);
  });

  it('git runs in the same jail', async () => {
    let out: string;
    try {
      out = await registry().execute('git', { operation: 'diff', args: ['--no-index', '/dev/null', '.cascade/config.json'] }, exec);
    } catch (err) {
      out = String(err);
    }
    expect(out).not.toContain(SECRET);
  });

  it('hides Cascade\'s global folder whole', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-home-'));
    await fs.writeFile(path.join(home, 'credentials.json'), SECRET);
    const r = await new ProcessJail(policy({ hiddenDirs: [home] })).prepare('/bin/sh', ['-c', `cat ${home}/credentials.json 2>&1; true`], { cwd: ws, offline: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(r.launch.file, r.launch.args, { env: r.launch.env, encoding: 'utf8' });
    expect(out).not.toContain(SECRET);
    await fs.rm(home, { recursive: true, force: true });
  });
});
