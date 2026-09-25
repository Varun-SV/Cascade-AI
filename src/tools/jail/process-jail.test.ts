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
import { execFileSync } from 'node:child_process';
import { BUILT_IN_PROTECTED } from '../../config/ignore.js';
import {
  ProcessJail, bwrapArgs, collectHidden, detectJail, scrubEnv, seatbeltProfile, toPathspecs, unixSocketFilter,
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
    hiddenPatterns: (offline) => [...BUILT_IN_PROTECTED, ...(offline ? [] : privacy.localOnlyPatterns())],
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
  // Directories are hidden whole where they can be — Cascade's folder, and one
  // whose every child a pattern names — so a file created in one while a
  // command runs is hidden too, not only the files there when it started.
  it('hides Cascade\'s folder but its scratch, the secrets, and a local-only folder whole — not package fixtures', async () => {
    const hidden = (await collectHidden(policy(), false)).sort((a, b) => a.path.localeCompare(b.path));
    expect(hidden.map((h) => [path.relative(ws, h.path), h.dir])).toEqual([
      ['.cascade', true], ['.env', false], ['keys/server.pem', false], ['secret', true],
    ]);
    expect(hidden[0]!.keep).toEqual([path.join(ws, '.cascade', 'tmp')]);
  });

  it('leaves local-only paths in view of a caller that is local-only itself', async () => {
    const hidden = (await collectHidden(policy(), true)).map((h) => path.relative(ws, h.path));
    expect(hidden).not.toContain('secret');
    expect(hidden).toContain('.cascade');
  });

  it('hides a directory matched whole as a directory, and the directories outside it is given', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-global-'));
    const hidden = await collectHidden(policy({ isLocalOnly: (rel) => rel === 'secret/', hiddenDirs: [outside, '/nonexistent/x'] }), false);
    expect(hidden).toContainEqual({ path: path.join(ws, 'secret'), dir: true });
    expect(hidden).toContainEqual({ path: await fs.realpath(outside), dir: true });
    expect(hidden.some((h) => h.path.startsWith('/nonexistent'))).toBe(false);
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe('toPathspecs', () => {
  it('turns gitignore patterns into git pathspecs, anchored where the pattern is', () => {
    expect(toPathspecs(['.env', '.cascade/config.json', 'secret/**', 'build/', '!keep.md', '# note'])).toEqual([
      ':(glob)**/.env', ':(glob)**/.env/**',
      ':(glob).cascade/config.json', ':(glob).cascade/config.json/**',
      ':(glob)secret/**',
      ':(glob)**/build', ':(glob)**/build/**',
    ]);
  });
});

describe('unixSocketFilter', () => {
  it('is a cBPF program for x64 and arm64, and nothing elsewhere', () => {
    expect(unixSocketFilter('x64')?.length).toBe(13 * 8);
    expect(unixSocketFilter('arm64')?.length).toBe(13 * 8);
    expect(unixSocketFilter('ia32')).toBeNull();
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

  it('bubblewrap: a hidden directory\'s kept parts mounted back', () => {
    const args = bwrapArgs([{ path: '/w/.cascade', dir: true, keep: ['/w/.cascade/tmp'] }], false, '/w', 'sh', []);
    expect(args.join(' ')).toContain('--tmpfs /w/.cascade --bind /w/.cascade/tmp /w/.cascade/tmp');
  });

  it('sandbox-exec: the same paths denied, outbound connections too for a local-only caller', () => {
    expect(seatbeltProfile([{ path: '/w/.cascade', dir: true, keep: ['/w/.cascade/tmp'] }], false))
      .toMatch(/\(deny file-read\* file-write\* \(subpath "\/w\/.cascade"\)\)\n\(allow file-read\* file-write\* \(subpath "\/w\/.cascade\/tmp"\)\)/);
    const profile = seatbeltProfile([...hidden, { path: '/w/a "b".txt', dir: false }], true);
    expect(profile).toContain('(literal "/w/.env")');
    expect(profile).toContain('(subpath "/home/u/.cascade-ai")');
    expect(profile).toContain('(literal "/w/a \\"b\\".txt")');
    expect(profile).toContain('(deny network-outbound)');
    expect(seatbeltProfile(hidden, false)).not.toContain('network');
  });

  const layout = { writable: ['/tmp/w'], readOnly: ['/tmp/w/.git'], scratch: ['/tmp', '/home/u/.cache'] };

  it('bubblewrap, for a local-only caller: the host read-only, private scratch, the workspace writable but its git store', () => {
    const args = bwrapArgs(hidden, true, '/tmp/w', 'sh', [], layout).join(' ');
    expect(args).toContain('--ro-bind / / --tmpfs /tmp --tmpfs /home/u/.cache --bind /tmp/w /tmp/w --ro-bind /tmp/w/.git /tmp/w/.git --dev /dev');
    expect(args).not.toContain('--bind / /');
    // The read-only parts go on before the masks, so a mask over one stays on.
    const masked = bwrapArgs([{ path: '/tmp/w/.git', dir: true }], true, '/tmp/w', 'sh', [], layout);
    expect(masked.lastIndexOf('--tmpfs')).toBeGreaterThan(masked.indexOf('/tmp/w/.git'));
    expect(masked.slice(masked.lastIndexOf('--tmpfs'), masked.lastIndexOf('--tmpfs') + 2)).toEqual(['--tmpfs', '/tmp/w/.git']);
    // A working directory the scratch would hide is mounted back, read-only.
    expect(bwrapArgs(hidden, true, '/tmp/other', 'sh', [], layout).join(' ')).toContain('--ro-bind /tmp/other /tmp/other');
  });

  it('sandbox-exec: what is hidden inside a kept folder denied again after the folder is allowed', () => {
    const profile = seatbeltProfile([
      { path: '/w/.cascade', dir: true, keep: ['/w/.cascade/tmp'] },
      { path: '/w/.cascade/tmp/notes.txt', dir: false },
    ], false);
    const lines = profile.split('\n');
    const allow = lines.findIndex((l) => l.startsWith('(allow file-read* file-write* (subpath "/w/.cascade/tmp")'));
    const again = lines.findIndex((l, i) => i > allow && l.includes('(literal "/w/.cascade/tmp/notes.txt")') && l.startsWith('(deny'));
    expect(allow).toBeGreaterThan(0);
    expect(again).toBeGreaterThan(allow);
  });

  it('sandbox-exec, for a local-only caller: no writes but to the workspace and the devices, none to its git store', () => {
    const profile = seatbeltProfile(hidden, true, layout);
    const lines = profile.split('\n');
    const denyAll = lines.indexOf('(deny file-write* (subpath "/"))');
    const allow = lines.findIndex((l) => l.startsWith('(allow file-write* (subpath "/tmp/w")'));
    const gitDir = lines.indexOf('(deny file-write* (subpath "/tmp/w/.git"))');
    expect(denyAll).toBeGreaterThan(0);
    expect(allow).toBeGreaterThan(denyAll);
    expect(lines[allow]).toContain('(literal "/dev/null")');
    expect(gitDir).toBeGreaterThan(allow);
    // The hidden paths stay denied after the workspace is allowed.
    expect(lines.findIndex((l) => l.includes('(literal "/w/.env")'))).toBeGreaterThan(allow);
    expect(seatbeltProfile(hidden, true)).not.toContain('(deny file-write* (subpath "/"))');
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
    expect(r.ok && r.launch.args).toEqual(expect.arrayContaining(['--tmpfs', path.join(ws, '.cascade'), '--ro-bind', '/dev/null', path.join(ws, '.env')]));
  });

  // Created after the paths to hide were collected, the scratch folder was
  // hidden with the rest of Cascade's, and every temporary file failed.
  it('sandbox-exec: gives a local-only caller a scratch folder its profile allows', async () => {
    const w = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-seatbelt-')));
    await fs.mkdir(path.join(w, '.cascade'));
    const jail = new ProcessJail(policy({ workspaceRoot: w, detect: async () => 'sandbox-exec' }));
    const prepared = await jail.prepare('/bin/sh', ['-c', 'true'], { cwd: w, offline: true });
    if (!prepared.ok) throw new Error(prepared.reason);
    const tmp = prepared.launch.env['TMPDIR']!;
    expect(tmp.startsWith(path.join(w, '.cascade', 'tmp', 'local-only-'))).toBe(true);
    expect(prepared.launch.args[1]).toContain(`(allow file-read* file-write* (subpath "${path.join(w, '.cascade', 'tmp')}"))`);
    await prepared.launch.done?.();
    await fs.rm(w, { recursive: true, force: true });
  });

  it('loads the socket filter for a local-only caller, through a shell that opens it', async () => {
    const r = await new ProcessJail(policy({ detect: bwrap })).prepare('sh', ['-c', 'ls'], { cwd: ws, offline: true });
    expect(r.ok && r.launch.file).toBe('/bin/sh');
    expect(r.ok && r.launch.args.slice(0, 2)).toEqual(['-c', 'exec bwrap --seccomp 9 "$@" 9<"$0"']);
    expect(r.ok && r.launch.args).toContain('--unshare-net');
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

  // A command could take a rule out of `.cascadeignore`, for the next run.
  it('lets a command read .cascadeignore, but not change, remove or unmount it', async () => {
    const file = path.join(ws, '.cascadeignore');
    await fs.writeFile(file, 'private/\n');
    try {
      for (const caller of [exec, { ...exec, isOffline: () => true }]) {
        const out = await registry().execute('shell', {
          command: 'cat .cascadeignore; umount .cascadeignore 2>/dev/null; echo > .cascadeignore; rm -f .cascadeignore; mv .cascadeignore moved; true',
        }, caller);
        expect(out).toContain('private/');
        expect(await fs.readFile(file, 'utf8')).toBe('private/\n');
      }
    } finally {
      await fs.rm(file, { force: true });
      await fs.rm(path.join(ws, 'moved'), { force: true });
    }
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
      out = await registry().execute('git', { operation: 'diff', args: ['--no-index', '/dev/null', '.env'] }, exec);
    } catch (err) {
      out = String(err);
    }
    expect(out).not.toContain(SECRET);
    // It ran, and was refused the file by the jail — not by simple-git, which
    // rejects an environment handed to it that holds EDITOR or the like.
    expect(out).not.toMatch(/not permitted/);
    expect(out).toMatch(/Permission denied|unsupported file type|could not|unable/i);
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

describe.skipIf(!bwrapWorks)('in bubblewrap: what changes while a command runs, and what it can reach through a socket', () => {
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };
  const registry = () => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, ws);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]));
    reg.setSecretValues(() => [SECRET]);
    return reg;
  };

  // The masks were a snapshot of the files there when the command started:
  // a journal Cascade wrote, or a local-only file another worker wrote, while
  // it ran appeared unmasked.
  it('hides a file created in Cascade\'s folder or a local-only folder after the command started', async () => {
    const running = registry().execute('shell', {
      command: 'sleep 0.6; cat .cascade/memory.db-wal secret/new.md 2>&1; true',
    }, exec);
    await new Promise((r) => setTimeout(r, 200));
    await fs.writeFile(path.join(ws, '.cascade', 'memory.db-wal'), `wal ${SECRET}`);
    await fs.writeFile(path.join(ws, 'secret', 'new.md'), `new ${LOCAL}`);
    const out = await running;
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(LOCAL);
  });

  // A network namespace leaves loopback only, but a socket file on the host
  // reaches a daemon outside it — Docker's, say — that can do the sending.
  it('keeps a local-only caller off host Unix sockets, and leaves its own child processes working', async () => {
    const sock = path.join(os.tmpdir(), `cascade-jail-${process.pid}.sock`);
    await fs.rm(sock, { force: true });
    const server = net.createServer((s) => s.end('daemon'));
    await new Promise<void>((r) => server.listen(sock, r));
    const probe = `node -e "require('net').connect('${sock}').on('data',d=>{console.log('unix:'+d);process.exit(0)}).on('error',e=>{console.log('unix:'+e.code);process.exit(0)})"`;
    try {
      expect(await registry().execute('shell', { command: probe }, exec)).toContain('unix:daemon');
      const offline = await registry().execute('shell', { command: `${probe}; node -e "require('child_process').exec('echo child-ok',(e,o)=>console.log(o.trim()))"` }, { ...exec, isOffline: () => true });
      expect(offline).toContain('unix:EACCES');
      expect(offline).toContain('child-ok');
    } finally {
      server.close();
      await fs.rm(sock, { force: true });
    }
  });
});

describe.skipIf(!bwrapWorks)('in bubblewrap: what git history gives away', () => {
  let repo: string;
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
  const registry = () => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, repo);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]));
    return reg;
  };

  beforeAll(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-jail-git-')));
    g('init', '-q');
    await fs.writeFile(path.join(repo, 'notes.md'), 'public notes\n');
    g('add', '.'); g('commit', '-qm', 'notes');
    await fs.mkdir(path.join(repo, 'secret'));
    await fs.writeFile(path.join(repo, 'secret', 'plan.md'), `${LOCAL}\n`);
    await fs.writeFile(path.join(repo, 'notes.md'), 'public notes, revised\n');
    g('add', '.'); g('commit', '-qm', 'plan');
  });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  // The working-tree file was hidden; its blob was not.
  it('hides the git store from a cloud worker\'s commands once it holds a local-only file', async () => {
    const out = await registry().execute('shell', { command: 'git show HEAD:secret/plan.md 2>&1; git log -p 2>&1; true' }, exec);
    expect(out).not.toContain(LOCAL);
    expect(out).toMatch(/not a git repository/);
  });

  it('leaves it to a local-only worker, whose commands have no network', async () => {
    const out = await registry().execute('shell', { command: 'git show HEAD:secret/plan.md' }, { ...exec, isOffline: () => true });
    expect(out).toContain(LOCAL);
  });

  it('keeps the git tool working for a cloud worker, with the hidden paths left out of what it shows', async () => {
    const reg = registry();
    const status = await reg.execute('git', { operation: 'status' }, exec);
    expect(status).toMatch(/Branch:|Working tree clean/);
    const diff = await reg.execute('git', { operation: 'diff', args: ['HEAD~1', 'HEAD'] }, exec);
    expect(diff).toContain('public notes, revised');
    expect(diff).not.toContain(LOCAL);
    const local = await reg.execute('git', { operation: 'diff', args: ['HEAD~1', 'HEAD'] }, { ...exec, isOffline: () => true });
    expect(local).toContain(LOCAL);
  });

  it('leaves a repository with nothing to hide alone', async () => {
    const clean = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-jail-clean-')));
    execFileSync('git', ['-C', clean, 'init', '-q']);
    await fs.writeFile(path.join(clean, 'a.md'), 'a\n');
    execFileSync('git', ['-C', clean, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
    execFileSync('git', ['-C', clean, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a']);
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, clean);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]));
    expect(await reg.execute('shell', { command: 'git log --oneline' }, exec)).toMatch(/\ba\b/);
    await fs.rm(clean, { recursive: true, force: true });
  });
});

// The git tool keeps the object store in view, so a push packs whatever the
// pushed commits hold — a local-only file committed once went to the remote
// with them, with no read to move the worker local-only on the way.
describe('what git push may send', () => {
  let repo: string;
  let bare: string;
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };
  const g = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  const push = (...args: string[]) => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, repo);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]));
    return reg.execute('git', { operation: 'push', args }, exec);
  };
  const remoteHas = (ref: string) => {
    try { g(bare, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; }
  };

  beforeAll(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-push-')));
    bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-push-remote-')));
    g(bare, 'init', '-q', '--bare');
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'remote', 'add', 'origin', bare);
    await fs.writeFile(path.join(repo, 'notes.md'), 'public notes\n');
    g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'notes');
    await fs.mkdir(path.join(repo, 'secret'));
    await fs.writeFile(path.join(repo, 'secret', 'plan.md'), `${LOCAL}\n`);
    g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'plan');
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(bare, { recursive: true, force: true });
  });

  it('refuses a push that would send a commit holding a local-only file', async () => {
    await expect(push('origin', 'main')).rejects.toThrow(/refused: a commit "origin" does not have yet .* plan/);
    await expect(push()).rejects.toThrow(/refused/);
    await expect(push('origin', `${g(repo, 'rev-parse', 'HEAD')}:refs/heads/leak`)).rejects.toThrow(/refused/);
    expect(remoteHas('refs/heads/main') || remoteHas('refs/heads/leak')).toBe(false);
  });

  // `:` pushes every branch the remote also has; with no source named, the
  // check had nothing to look at and let it through.
  it('refuses the matching refspec, which pushes every branch the remote has', async () => {
    await expect(push('origin', ':')).rejects.toThrow(/refused/);
    await expect(push('origin', '+:')).rejects.toThrow(/refused/);
  });

  it('refuses one to somewhere that is not a configured remote', async () => {
    await expect(push(bare, 'main')).rejects.toThrow(/not a configured remote/);
    await expect(push('--repo', bare, 'main')).rejects.toThrow(/not a configured remote/);
    expect(remoteHas('refs/heads/main')).toBe(false);
  });

  it('lets the rest through: history without the file, and deleting', async () => {
    await push('origin', 'HEAD~1:refs/heads/public');
    expect(remoteHas('refs/heads/public')).toBe(true);
    await push('origin', '--delete', 'public');
    expect(remoteHas('refs/heads/public')).toBe(false);
  });

  it('lets a push through once the remote already has what it holds', async () => {
    // Sent some other way (the user, outside Cascade), and fetched since.
    g(repo, 'push', '-q', 'origin', 'main');
    g(repo, 'fetch', '-q', 'origin');
    await fs.writeFile(path.join(repo, 'notes.md'), 'public notes, revised\n');
    g(repo, 'commit', '-qam', 'revise');
    await push('origin', 'main');
    expect(g(bare, 'rev-parse', 'refs/heads/main')).toBe(g(repo, 'rev-parse', 'HEAD'));
  });
});

// A configured code-index database is protected where it is, not by any
// pattern — and git's checks went by patterns only: a commit holding it
// could be pushed, and diffed, and the git store stayed in commands' view.
describe('a file protected where it is, in git', () => {
  let repo: string;
  let bare: string;
  const INDEX = 'SECRET-INDEX-ROWS';
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };
  const g = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  const registry = () => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, repo);
    reg.protectFiles(['', '-wal'].map((suffix) => path.join(repo, 'data', `idx.db${suffix}`)));
    return reg;
  };

  beforeAll(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-placed-')));
    bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-placed-remote-')));
    g(bare, 'init', '-q', '--bare');
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'remote', 'add', 'origin', bare);
    await fs.writeFile(path.join(repo, 'notes.md'), 'public notes\n');
    g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'notes');
    await fs.mkdir(path.join(repo, 'data'));
    await fs.writeFile(path.join(repo, 'data', 'idx.db'), `${INDEX}\n`);
    g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'index');
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(bare, { recursive: true, force: true });
  });

  it('refuses a push that would send it, and leaves it out of a diff', async () => {
    await expect(registry().execute('git', { operation: 'push', args: ['origin', 'main'] }, exec)).rejects.toThrow(/refused/);
    expect(() => g(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/main')).toThrow();
    const diff = await registry().execute('git', { operation: 'diff', args: ['HEAD~1', 'HEAD'] }, exec);
    expect(diff).not.toContain(INDEX);
  });

  it.skipIf(!bwrapWorks)('hides the git store from commands', async () => {
    const out = await registry().execute('shell', { command: 'git show HEAD:data/idx.db 2>&1; true' }, exec);
    expect(out).not.toContain(INDEX);
  });
});

// Windows has no jail and no /bin/sh to unset variables in, so the git tool
// ran git with Cascade's whole environment — provider keys included — for
// its hooks and credential helpers to read.
describe('git on Windows gets the scrubbed environment', () => {
  it('hands git the environment with the keys taken out, and keeps the user\'s own git settings', async () => {
    const { GitTool } = await import('../git.js');
    const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-wingit-')));
    const g = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
    g('init', '-q');
    await fs.writeFile(path.join(repo, 'a.md'), 'a\n');
    g('add', '.'); g('commit', '-qm', 'a');
    await fs.writeFile(path.join(repo, 'a.md'), 'b\n');
    // git runs the external diff with its own environment: a window onto it.
    const dump = path.join(repo, 'env.out');
    const script = path.join(os.tmpdir(), `cascade-dump-env-${process.pid}.sh`);
    await fs.writeFile(script, `#!/bin/sh\nenv > '${dump}'\n`, { mode: 0o755 });
    g('config', 'diff.external', script);

    const tool = new GitTool();
    tool.setWorkspaceRoot(repo);
    tool.setProcessJail(new ProcessJail(policy({ workspaceRoot: repo, detect: async () => null })));
    const platform = process.platform;
    const savedEnv = { ...process.env };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['OPENAI_API_KEY'] = SECRET;
    process.env['EDITOR'] = 'vi';
    process.env['GIT_CONFIG_COUNT'] = '1';
    process.env['GIT_CONFIG_KEY_0'] = 'core.pager';
    process.env['GIT_CONFIG_VALUE_0'] = 'cat';
    try {
      await tool.execute({ operation: 'diff' }, { tierId: 't3', sessionId: 's' });
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
      for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
      Object.assign(process.env, savedEnv);
    }
    const seen = await fs.readFile(dump, 'utf8');
    expect(seen).not.toContain(SECRET);
    expect(seen).toMatch(/^EDITOR=vi$/m);
    expect(seen).not.toMatch(/^GIT_CONFIG_COUNT=/m);
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(script, { force: true });
  });
});

// A local-only worker's command could write what it read anywhere — a file
// in the workspace, /tmp, the home folder, a commit — for a cloud worker's
// command to read later. Now it writes only into the workspace, and what it
// changed there is local-only from then on.
describe.skipIf(!bwrapWorks)('in bubblewrap: where a local-only caller\'s writes go', () => {
  let dir: string;
  let privacy: PrivacyPaths;
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };
  const offline = { ...exec, isOffline: () => true };
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  const registry = () => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, dir);
    reg.setPrivacyPaths(privacy);
    return reg;
  };
  const probe = `cascade-offline-probe-${process.pid}`;

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-jail-writes-')));
    g('init', '-q');
    await fs.mkdir(path.join(dir, 'secret'));
    await fs.writeFile(path.join(dir, 'secret', 'plan.md'), `${LOCAL}\n`);
    await fs.writeFile(path.join(dir, 'notes.md'), 'public notes\n');
    g('add', 'notes.md'); g('commit', '-qm', 'notes');
    privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: dir });
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.join(os.tmpdir(), probe), { force: true });
    await fs.rm(path.join(os.homedir(), probe), { force: true });
  });

  it('marks what the command wrote in the workspace local-only, and hides it from a cloud worker\'s commands', async () => {
    const reg = registry();
    await reg.execute('shell', { command: 'cat secret/plan.md > summary.txt; mkdir -p out && cp summary.txt out/copy.txt' }, offline);
    expect(privacy.isLocalOnly('summary.txt')).toBe(true);
    expect(privacy.isLocalOnly('out/copy.txt')).toBe(true);
    expect(privacy.isLocalOnly('notes.md'), 'nothing it left alone').toBe(false);
    const seen = await reg.execute('shell', { command: 'cat summary.txt out/copy.txt notes.md 2>&1; true' }, exec);
    expect(seen).not.toContain(LOCAL);
    expect(seen).toContain('public notes');
    // …and in a later run, from the record.
    expect(new PrivacyPaths([], { workspaceRoot: dir }).isLocalOnly('summary.txt')).toBe(true);
  });

  // A directory's name can carry what it read as well as a file's.
  it('marks a directory it made, whole, and not each one inside it', async () => {
    await registry().execute('shell', { command: 'mkdir -p "made-$(head -c 5 secret/plan.md)/sub"' }, offline);
    expect(privacy.isLocalOnly('made-LOCAL')).toBe(true);
    expect(privacy.isLocalOnly('made-LOCAL/sub/later.txt')).toBe(true);
    const recorded = new PrivacyPaths([], { workspaceRoot: dir }).localOnlyPatterns();
    expect(recorded).toContain('/made-LOCAL');
    expect(recorded).not.toContain('/made-LOCAL/sub');
  });

  it('gives the command a private /tmp, and nowhere else to write outside the workspace', async () => {
    const out = await registry().execute('shell', {
      command: `echo x > /tmp/${probe} && cat /tmp/${probe}; echo y > "$HOME/${probe}" 2>&1; true`,
    }, offline);
    expect(out).toMatch(/^x$/m);
    expect(out).toMatch(/Read-only file system/);
    await expect(fs.stat(path.join(os.tmpdir(), probe))).rejects.toThrow();
    await expect(fs.stat(path.join(os.homedir(), probe))).rejects.toThrow();
  });

  it('keeps the command from recording anything in the repository', async () => {
    const head = g('rev-parse', 'HEAD');
    const out = await registry().execute('shell', {
      command: 'git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$(cat secret/plan.md)" 2>&1; true',
    }, offline);
    expect(out).toMatch(/Read-only file system|unable to|could not/i);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    // It can still read the history.
    expect(await registry().execute('git', { operation: 'log' }, offline)).toContain('notes');
  });

  // Cascade's scratch is mounted back whole over its hidden folder, and a
  // local-only file written there came back with it.
  it('keeps a local-only file in Cascade\'s scratch hidden from a cloud worker\'s commands', async () => {
    const reg = registry();
    await reg.execute('file_write', { path: '.cascade/tmp/notes.txt', content: LOCAL }, offline);
    expect(privacy.isLocalOnly('.cascade/tmp/notes.txt')).toBe(true);
    await fs.writeFile(path.join(dir, '.cascade', 'tmp', 'scratch.txt'), 'scratch\n');
    const seen = await reg.execute('shell', { command: 'cat .cascade/tmp/notes.txt .cascade/tmp/scratch.txt 2>&1; true' }, exec);
    expect(seen).not.toContain(LOCAL);
    expect(seen).toContain('scratch');
  });

  it('marks a file tool\'s destination local-only before it writes', async () => {
    const reg = registry();
    await reg.execute('file_write', { path: 'report.md', content: LOCAL }, offline);
    expect(privacy.isLocalOnly('report.md')).toBe(true);
    await reg.execute('file_write', { path: 'public.md', content: 'hello' }, exec);
    expect(privacy.isLocalOnly('public.md'), 'a cloud worker\'s write is its own').toBe(false);
  });

  it('runs the command alone: a cloud worker\'s read waits for it, and then finds what it wrote marked', async () => {
    const reg = registry();
    const order: string[] = [];
    const command = reg.execute('shell', { command: 'sleep 0.5; cat secret/plan.md > late.txt' }, offline)
      .then(() => { order.push('command'); });
    await new Promise((r) => setTimeout(r, 150));
    const read = reg.execute('file_read', { path: 'notes.md' }, exec).then(() => { order.push('read'); });
    await Promise.all([command, read]);
    expect(order).toEqual(['command', 'read']);
    expect(privacy.isLocalOnly('late.txt')).toBe(true);
  });
});

// Masks go on by name, and a hard link is the file under another name.
describe.skipIf(!bwrapWorks)('in bubblewrap: other names for a hidden file, and files hidden where they are', () => {
  let dir: string;
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-jail-links-')));
    await fs.writeFile(path.join(dir, '.env'), `KEY=${SECRET}\n`);
    await fs.link(path.join(dir, '.env'), path.join(dir, 'notes.txt'));
    await fs.mkdir(path.join(dir, 'secret'));
    await fs.writeFile(path.join(dir, 'secret', 'plan.md'), `${LOCAL}\n`);
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.link(path.join(dir, 'secret', 'plan.md'), path.join(dir, 'docs', 'plan.md'));
    await fs.mkdir(path.join(dir, 'data'));
    await fs.writeFile(path.join(dir, 'data', 'idx.db'), 'INDEXED-CHUNK-TEXT');
    await fs.writeFile(path.join(dir, 'readme.md'), 'public\n');
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('hides a hard link to a protected or local-only file, and a file protected where it is', async () => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, dir);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]));
    reg.protectFiles([path.join(dir, 'data', 'idx.db')]);
    const out = await reg.execute('shell', { command: 'cat notes.txt docs/plan.md data/idx.db readme.md 2>&1; true' }, exec);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(LOCAL);
    expect(out).not.toContain('INDEXED-CHUNK-TEXT');
    expect(out).toContain('public');
    // A local-only caller may see the local-only one, under either name.
    const local = await reg.execute('shell', { command: 'cat docs/plan.md notes.txt 2>&1; true' }, { ...exec, isOffline: () => true });
    expect(local).toContain(LOCAL);
    expect(local).not.toContain(SECRET);
  });
});

// A file with another name outside the workspace shares every write with it,
// and that name can be neither marked local-only nor hidden.
describe.skipIf(!bwrapWorks)('in bubblewrap: a local-only caller and files with other names', () => {
  let dir: string;
  let outside: string;
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };
  const offline = { ...exec, isOffline: () => true };
  const registry = () => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, dir);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: dir }));
    return reg;
  };

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-jail-linked-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-jail-store-')));
    await fs.mkdir(path.join(dir, 'secret'));
    await fs.writeFile(path.join(dir, 'secret', 'plan.md'), `${LOCAL}\n`);
    await fs.writeFile(path.join(outside, 'shared.txt'), 'shared\n');
    await fs.link(path.join(outside, 'shared.txt'), path.join(dir, 'shared.txt'));
    // As pnpm installs a package: linked in from a store outside.
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(outside, 'index.js'), 'module.exports = 1;\n');
    await fs.link(path.join(outside, 'index.js'), path.join(dir, 'node_modules', 'pkg', 'index.js'));
    await fs.writeFile(path.join(dir, 'notes.md'), 'public\n');
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('refuses a file tool\'s write to one, and leaves an ordinary file writable', async () => {
    const reg = registry();
    await expect(reg.execute('file_write', { path: 'shared.txt', content: LOCAL }, offline)).rejects.toThrow(/other names \(hard links\)/);
    await expect(reg.execute('file_edit', { path: 'shared.txt', old_string: 'shared', new_string: LOCAL }, offline)).rejects.toThrow(/other names/);
    expect(await fs.readFile(path.join(outside, 'shared.txt'), 'utf8')).toBe('shared\n');
    await reg.execute('file_write', { path: 'notes.md', content: 'still writable' }, offline);
    // A cloud worker's write is its own business.
    await reg.execute('file_write', { path: 'shared.txt', content: 'shared, edited\n' }, exec);
    expect(await fs.readFile(path.join(outside, 'shared.txt'), 'utf8')).toBe('shared, edited\n');
  });

  // A new link to a file outside the workspace would carry what the command
  // writes to a name nothing marks. The workspace is a mount of its own, so
  // the link cannot be made; a symlink out leads to the read-only rest.
  it('keeps a command from linking a file outside the workspace in', async () => {
    // In the home folder: /tmp is the command's own there.
    const target = path.join(os.homedir(), `cascade-link-probe-${process.pid}.txt`);
    await fs.writeFile(target, 'public\n');
    const out = await registry().execute('shell', {
      command: `ln ${target} ./linked.txt 2>&1; ln -s ${target} ./sym.txt && cat secret/plan.md > ./sym.txt 2>&1; true`,
    }, offline);
    expect(out).toMatch(/Invalid cross-device link/);
    expect(out).toMatch(/Read-only file system/);
    expect(await fs.readFile(target, 'utf8')).toBe('public\n');
    await fs.rm(path.join(dir, 'sym.txt'), { force: true });
    await fs.rm(target, { force: true });
  });

  it('keeps a command from writing through one, or into the packages it is installed with', async () => {
    const out = await registry().execute('shell', {
      command: 'cat secret/plan.md >> shared.txt 2>&1; cat secret/plan.md > node_modules/pkg/index.js 2>&1; touch node_modules/new.js 2>&1; echo ok > made.txt; true',
    }, offline);
    expect(out).toMatch(/Read-only file system/);
    expect(await fs.readFile(path.join(outside, 'shared.txt'), 'utf8')).not.toContain(LOCAL);
    expect(await fs.readFile(path.join(outside, 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    await expect(fs.stat(path.join(dir, 'node_modules', 'new.js'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'made.txt'), 'utf8')).toBe('ok\n');
  });
});

// The read-only mounts went on after the masks, so one over the git store
// took the mask back off for a local-only caller.
describe.skipIf(!bwrapWorks)('in bubblewrap: a local-only caller and a history holding a protected file', () => {
  it('keeps the git store hidden', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-jail-envrepo-')));
    const g = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
    g('init', '-q');
    await fs.writeFile(path.join(dir, '.env'), `KEY=${SECRET}\n`);
    g('add', '-f', '.env'); g('commit', '-qm', 'oops');
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, dir);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: dir }));
    const out = await reg.execute('shell', { command: 'git show HEAD:.env 2>&1; true' }, { tierId: 't3', sessionId: 's', requireApproval: false, isOffline: () => true });
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/not a git repository/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// The git tool keeps the store in view, and so did every program git
// started for it: a hook or a filter could `git show` a hidden blob and send
// it on, with the network there.
describe('the git tool where its store holds what commands may not see', () => {
  let repo: string;
  let globalConfig: string;
  const exec = { tierId: 't3', sessionId: 's', requireApproval: false };
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  const tool = (operation: string, args: string[] = []) => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, repo);
    reg.setPrivacyPaths(new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]));
    return reg.execute('git', { operation, args }, exec);
  };
  /** Run with the global configuration a command could have written. */
  const withGlobal = async <T>(fn: () => Promise<T>): Promise<T> => {
    const saved = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
    try { return await fn(); } finally {
      if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL']; else process.env['GIT_CONFIG_GLOBAL'] = saved;
    }
  };

  beforeAll(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-hermetic-')));
    g('init', '-q');
    await fs.mkdir(path.join(repo, 'secret'));
    await fs.writeFile(path.join(repo, 'secret', 'plan.md'), `${LOCAL}\n`);
    await fs.writeFile(path.join(repo, 'notes.md'), 'public\n');
    g('add', '.'); g('commit', '-qm', 'plan');
    const leak = (name: string) => `git show HEAD:secret/plan.md > ${path.join(repo, name)} 2>/dev/null`;
    await fs.writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${leak('leak-hook.txt')}\n`, { mode: 0o755 });
    globalConfig = path.join(repo, '..', `cascade-hermetic-global-${process.pid}`);
    await fs.writeFile(globalConfig, [
      '[user]', '\tname = Global Name', '\temail = global@example.com',
      // Quoted whole: an unquoted `;` starts a comment in git's config.
      '[filter "x"]', `\tclean = "sh -c '${leak('leak-filter.txt')}; cat'"`,
    ].join('\n'));
    await fs.writeFile(path.join(repo, '.gitattributes'), '*.md filter=x\n');
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(globalConfig, { force: true });
  });

  it('runs no hook and nothing the global configuration names, and keeps the name and email', async () => {
    await fs.writeFile(path.join(repo, 'notes.md'), 'public, revised\n');
    await withGlobal(async () => {
      await tool('add', ['notes.md', '.gitattributes']);
      await tool('commit', ['revise']);
    });
    await expect(fs.stat(path.join(repo, 'leak-hook.txt'))).rejects.toThrow();
    await expect(fs.stat(path.join(repo, 'leak-filter.txt'))).rejects.toThrow();
    expect(g('log', '-1', '--format=%an <%ae> %s')).toBe('Global Name <global@example.com> revise');
  });

  it('leaves a repository with nothing hidden in its store as it was', async () => {
    const clean = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-hermetic-clean-')));
    const c = (...args: string[]) => execFileSync('git', ['-C', clean, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
    c('init', '-q');
    await fs.writeFile(path.join(clean, 'a.md'), 'a\n');
    c('add', '.'); c('commit', '-qm', 'a');
    await fs.writeFile(path.join(clean, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${path.join(clean, 'hook-ran')}\n`, { mode: 0o755 });
    c('config', 'user.email', 'local@example.com'); c('config', 'user.name', 'Local');
    await fs.writeFile(path.join(clean, 'a.md'), 'b\n');
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {} } as never, clean);
    await reg.execute('git', { operation: 'add', args: ['a.md'] }, exec);
    await reg.execute('git', { operation: 'commit', args: ['b'] }, exec);
    expect((await fs.stat(path.join(clean, 'hook-ran'))).isFile()).toBe(true);
    await fs.rm(clean, { recursive: true, force: true });
  });
});
