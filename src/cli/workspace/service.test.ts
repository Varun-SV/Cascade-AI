import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCliWorkspace, WORKSPACE_CONTROL_PATH, WORKSPACE_RUN_PATH,
  type CallQuestion, type CliWorkspaceCore, type ConsentQuestion, type PairedDevice, type WorkspaceRunSummary, type WorkspaceUi,
} from './service.js';
import {
  CONSENT_MAX_MS, EDIT_TOOLS, READ_TOOLS, WORKSPACE_TOOLS, activityText, buildLabel, consentWindowMs, displayText, leaksPath,
  presetOf, sanitizeTools, validateFolder, type FolderFs,
} from './consent.js';
import { WORKSPACE_TOOLS as SDK_TOOLS } from '../../workspace/protocol.js';

type ServeOpts = Parameters<CliWorkspaceCore['serveWorkspaceDevice']>[0];
const HOME = path.resolve(os.homedir());
const PROJ = path.join(HOME, 'code', 'proj');
const fsFake: FolderFs = { home: () => HOME, realpath: (p) => p, isDirectory: () => true };

const device: PairedDevice = { serverUrl: 'https://cloud.example', deviceId: 'dev-1', name: 'Ana PC', privateKeyPem: 'PEM', serverId: 's1', serverKey: 'k1' };

interface Pending<Q, A> { q: Q; resolve(a: A): void }
type ConsentAnswer = { tools: string[]; labelMode: 'device' | 'folder' } | null;

function harness(over: { folder?: string; callTimeoutMs?: number; defaults?: { tools?: string[]; labelMode?: 'device' | 'folder' } } = {}) {
  const served: ServeOpts[] = [];
  const loadGate: { wait: Promise<void> } = { wait: Promise.resolve() };
  const client = { stop: vi.fn() };
  const executors: any[] = [];
  const consents: Array<Pending<ConsentQuestion, ConsentAnswer>> = [];
  const calls: Array<Pending<CallQuestion, 'allow' | 'deny' | 'all'>> = [];
  const lines: string[] = [];
  const ended: WorkspaceRunSummary[] = [];
  const servedUi: Array<{ label: string } | null> = [];
  const checkpoints = { list: vi.fn((): any[] => []), undo: vi.fn(async () => ({ restored: ['a'], removed: ['b'], skipped: [] as string[] })), begin: vi.fn(async () => ({ n: 3 })), end: vi.fn(async () => ({})) };
  const core = {
    relayEndpoints: (url: string, p: { controlPath: string; runPath: string }) => ({ controlUrl: url + p.controlPath, runUrl: url + p.runPath }),
    serveWorkspaceDevice: (o: ServeOpts) => {
      served.push(o);
      o.onClient?.(client);
      return new Promise<'stopped' | 'refused'>((r) => o.signal.addEventListener('abort', () => r('stopped')));
    },
    createWorkspaceExecutor: (o: unknown) => {
      const e = { run: vi.fn(async () => ({ ok: true, output: 'x' })), definitions: () => [], finish: vi.fn(async () => {}) };
      executors.push({ ...(o as object), inner: e });
      return e;
    },
    ToolRegistry: class { ignored: string[] | null = null; secrets: (() => string[]) | null = null; constructor(public config: unknown, public root: string) {} setIgnoredPaths(p: string[]) { this.ignored = p; } setSecretValues(r: () => string[]) { this.secrets = r; } },
    secretValuesIn: (c: unknown) => [JSON.stringify(c).includes('apiKey') ? 'sk-from-config' : 'none'],
    ConfigManager: class { async load() { await loadGate.wait; } getConfig() { return { providers: [{ type: 'openai', apiKey: 'sk-from-config' }], tools: { x: 1 }, privacy: { paths: [{ pattern: 'secret/**', policy: 'local-only' }] } }; } getIgnore() { return { getUserPatterns: () => ['private/**', '*.csv'] }; } },
    PrivacyPaths: class { constructor(public policies: unknown) {} },
    Checkpoints: class { constructor() { return checkpoints as never; } },
    statePath: (root: string, p: string) => path.join(root, '.state', p),
    STATE: { checkpoints: 'checkpoints' },
  } as unknown as CliWorkspaceCore;
  const ui: WorkspaceUi = {
    askConsent: (q) => new Promise((resolve) => { consents.push({ q, resolve }); }),
    askCall: (q) => new Promise((resolve) => { calls.push({ q, resolve }); }),
    served: (r) => { servedUi.push(r); },
    activity: (l) => { lines.push(l); },
    runEnded: (s) => { ended.push(s); },
    notice: () => {},
  };
  const make = (fs: FolderFs) => createCliWorkspace({
    core, folder: over.folder ?? PROJ, device, ui, fs, hostname: () => 'host',
    ...(over.defaults ? { defaults: over.defaults } : {}),
    ...(over.callTimeoutMs ? { callTimeoutMs: over.callTimeoutMs } : {}),
  });
  return { ws: make(fsFake), make, served, client, executors, checkpoints, loadGate, consents, calls, lines, ended, servedUi, core };
}

const run = (over: Record<string, unknown> = {}) =>
  ({ runId: 'run-1', userId: 'user-a', expiresAt: Date.now() + 5 * 60_000, signal: new AbortController().signal, ...over }) as Parameters<ServeOpts['askUser']>[0];
const call = (tool: string, input: Record<string, unknown> = { command: 'rm -rf build' }, signal = new AbortController().signal) =>
  ({ tool, input, risk: { level: 'risky', reason: 'deletes files' }, signal });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the pure rules', () => {
  it('keep the tool list equal to the SDK\'s, presets exact, and only workspace tools through', () => {
    expect([...WORKSPACE_TOOLS]).toEqual([...SDK_TOOLS]);
    expect(presetOf(READ_TOOLS)).toBe('read');
    expect(presetOf(EDIT_TOOLS)).toBe('edit');
    expect(presetOf(WORKSPACE_TOOLS)).toBe('all');
    expect(presetOf(['file_read'])).toBeNull();
    expect(sanitizeTools(['shell', 'rm', 'file_read', 'file_read', 7])).toEqual(['file_read', 'shell']);
    expect(sanitizeTools('file_read')).toEqual([]);
  });

  it('refuses a root, the home folder, a parent of home, a missing folder and nonsense', () => {
    expect(validateFolder(PROJ, fsFake)).toEqual({ ok: true, folder: PROJ });
    for (const bad of [HOME, path.parse(HOME).root, path.dirname(HOME), '', 'relative/dir', 7, `${PROJ}\0x`]) {
      expect(validateFolder(bad, fsFake), String(bad)).toHaveProperty('error');
    }
    expect(validateFolder(PROJ, { ...fsFake, realpath: () => null })).toMatchObject({ error: expect.stringMatching(/not there/) });
    expect(validateFolder(PROJ, { ...fsFake, isDirectory: () => false })).toHaveProperty('error');
    // A link into the home folder is judged by where it leads.
    expect(validateFolder(PROJ, { ...fsFake, realpath: (p) => (p === PROJ ? HOME : p) })).toHaveProperty('error');
  });

  it('labels a run by the device or the folder\'s name, never a path', () => {
    expect(buildLabel('device', 'Ana PC', PROJ)).toBe('Workspace on Ana PC');
    expect(buildLabel('folder', 'Ana PC', PROJ)).toBe('proj');
    expect(buildLabel('device', 'a/b\\c\n', PROJ)).toBe('Workspace on a b c');
    expect(buildLabel('device', '', PROJ)).toBe('Workspace on this computer');
    expect(leaksPath(buildLabel('device', 'Ana PC', PROJ), PROJ)).toBe(false);
    expect(leaksPath(`see ${PROJ}/x`, PROJ)).toBe(true);
  });

  it('the consent window is the offer\'s, and never over ten minutes', () => {
    expect(consentWindowMs(1000 + 60_000, 1000)).toBe(60_000);
    expect(consentWindowMs(1000 + 3_600_000, 1000)).toBe(CONSENT_MAX_MS);
    expect(consentWindowMs(500, 1000)).toBe(0);
  });

  it('shows a call on one printable line, with credentials masked and no escape sequences', () => {
    expect(displayText('echo \u001b[31mhi\u001b[0m\nsecond sk-live-123456', { secrets: ['sk-live-123456'] })).toBe('echo [31mhi [0m ⏎ second ***');
    expect(displayText('x'.repeat(500), { max: 20 })).toHaveLength(21);
    // The live line: a path or a command; run_code's code and a write's content are never in it.
    expect(activityText('file_read', { path: 'src/a.ts' }, PROJ)).toBe('file_read src/a.ts');
    expect(activityText('file_write', { path: 'a.txt', content: 'SECRET BODY' }, PROJ)).toBe('file_write a.txt');
    expect(activityText('run_code', { language: 'python', code: 'print(open("/etc/passwd"))' }, PROJ)).toBe('run_code python');
    expect(activityText('shell', { command: `cat ${PROJ}/a.txt` }, PROJ)).toBe('shell cat ./a.txt');
    expect(activityText('shell', { command: 'curl -H sk-from-config x' }, PROJ, ['sk-from-config'])).toBe('shell curl -H *** x');
  });
});

describe('serving state', () => {
  it('serves with the paired device\'s key and pinned server, at the workspace paths', () => {
    const h = harness();
    void h.ws.start();
    expect(h.served[0]!.stored).toEqual({ deviceId: 'dev-1', privateKeyPem: 'PEM', serverId: 's1', serverKey: 'k1' });
    expect(h.served[0]!.endpoints).toEqual({
      controlUrl: `https://cloud.example${WORKSPACE_CONTROL_PATH}`, runUrl: `https://cloud.example${WORKSPACE_RUN_PATH}`,
    });
    expect(h.ws.status().connected).toBe(false);
    h.served[0]!.log('connected: cloud runs can ask for this workspace');
    expect(h.ws.status().connected).toBe(true);
  });

  it('will not start for a folder a run may not have', () => {
    expect(() => harness({ folder: HOME }).ws.start()).toThrow(/home folder/);
    expect(() => harness({ folder: path.parse(HOME).root }).ws.start()).toThrow(/drive/);
  });

  it('stop closes the connection and resolves the loop', async () => {
    const h = harness();
    const p = h.ws.start();
    h.served[0]!.log('connected: x');
    h.ws.stop();
    expect(h.served[0]!.signal.aborted).toBe(true);
    await expect(p).resolves.toBe('stopped');
    expect(h.ws.status().connected).toBe(false);
  });

  it('says so when the server turns the device away', async () => {
    const h = harness();
    h.core.serveWorkspaceDevice = async () => 'refused';
    await expect(h.ws.start()).resolves.toBe('refused');
    expect(h.ws.status().error).toMatch(/does not accept this device/);
  });
});

describe('the consent question', () => {
  it('asks here, and a yes gives the tools and a label that is not the path', async () => {
    const h = harness();
    void h.ws.start();
    const p = h.served[0]!.askUser(run({ hint: { chat: 'Fix the build' } }));
    expect(h.consents[0]!.q).toMatchObject({ runId: 'run-1', chat: 'Fix the build', device: 'Ana PC', folderName: 'proj', defaults: { tools: ['file_list', 'file_read', 'glob', 'grep'], labelMode: 'device' } });
    expect(JSON.stringify(h.consents[0]!.q)).not.toContain(HOME);
    h.consents[0]!.resolve({ tools: ['file_read', 'shell', 'bogus'], labelMode: 'folder' });
    const consent = await p;
    expect(consent).toEqual({ tools: ['file_read', 'shell'], label: 'proj' });
    expect(JSON.stringify(consent)).not.toContain(HOME);
  });

  it('the default label is "Workspace on <device name>"', async () => {
    const h = harness();
    void h.ws.start();
    const p = h.served[0]!.askUser(run());
    h.consents[0]!.resolve({ tools: ['file_read'], labelMode: 'device' });
    expect(await p).toEqual({ tools: ['file_read'], label: 'Workspace on Ana PC' });
  });

  it('no usable tools, or a no, is a no', async () => {
    const h = harness();
    void h.ws.start();
    const a = h.served[0]!.askUser(run());
    h.consents[0]!.resolve({ tools: ['rm'], labelMode: 'device' });
    expect(await a).toBeNull();
    const b = h.served[0]!.askUser(run());
    h.consents[1]!.resolve(null);
    expect(await b).toBeNull();
  });

  it('is a no if the folder stopped being one a run may have while the question was open', async () => {
    let ok = true;
    const h = harness();
    const ws = h.make({ home: () => HOME, realpath: (p) => (ok ? p : null), isDirectory: () => true });
    void ws.start();
    const p = h.served.at(-1)!.askUser(run());
    ok = false;
    h.consents.at(-1)!.resolve({ tools: ['file_read'], labelMode: 'device' });
    expect(await p).toBeNull();
  });

  it('is a no when unanswered within the offer\'s time, and the prompt is taken down', async () => {
    const h = harness();
    void h.ws.start();
    const p = h.served[0]!.askUser(run({ expiresAt: Date.now() + 60_000 }));
    expect(h.consents[0]!.q.windowMs).toBe(60_000);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await p).toBeNull();
    expect(h.consents[0]!.q.signal.aborted).toBe(true);
  });

  it('never waits past ten minutes whatever the offer allows', async () => {
    const h = harness();
    void h.ws.start();
    const p = h.served[0]!.askUser(run({ expiresAt: Date.now() + 60 * 60_000 }));
    expect(h.consents[0]!.q.windowMs).toBe(CONSENT_MAX_MS);
    await vi.advanceTimersByTimeAsync(CONSENT_MAX_MS + 1);
    expect(await p).toBeNull();
  });

  it('closes when the offer is withdrawn, and when serving is stopped', async () => {
    const h = harness();
    void h.ws.start();
    const ac = new AbortController();
    const p = h.served[0]!.askUser(run({ signal: ac.signal }));
    ac.abort();
    expect(await p).toBeNull();
    expect(h.consents[0]!.q.signal.aborted).toBe(true);
    const q = h.served[0]!.askUser(run());
    h.ws.stop();
    expect(await q).toBeNull();
  });
});

describe('a served run', () => {
  async function opened(h: ReturnType<typeof harness>, tools = ['file_read', 'file_write', 'shell'], runId = 'run-1') {
    void h.ws.start();
    const s = h.served.at(-1)!;
    const p = s.askUser(run({ runId }));
    h.consents.at(-1)!.resolve({ tools, labelMode: 'device' });
    const consent = (await p)!;
    const executor = (await s.open(consent, run({ runId }))) as { run: (...a: any[]) => Promise<unknown> };
    const exec = h.executors.at(-1);
    return { s, consent, executor, exec };
  }
  const info = (runId = 'run-1', label = 'Workspace on Ana PC') => ({ runId, userId: 'u', expiresAt: 1, label });
  const q = (h: ReturnType<typeof harness>) => h.calls.at(-1)!;

  it('builds the executor over the folder with its own privacy rules and checkpoints, and only the allowed tools', async () => {
    const h = harness();
    const { exec } = await opened(h);
    expect(exec.tools).toEqual(['file_read', 'file_write', 'shell']);
    expect(exec.registry.root).toBe(PROJ);
    expect(exec.registry.config).toMatchObject({ x: 1, enabledTools: ['file_read', 'file_write', 'shell'], browserEnabled: false });
    expect(exec.privacy().policies).toEqual([{ pattern: 'secret/**', policy: 'local-only' }]);
    // .cascadeignore protects what it lists from the run, as in a local run.
    expect(exec.registry.ignored).toEqual(['private/**', '*.csv']);
    // Configured credentials are scrubbed from commands' environment.
    expect(exec.registry.secrets()).toEqual(['sk-from-config']);
    expect(await exec.checkpoints.begin('x')).toEqual({ n: 3 });
    expect(exec.label).toBe('Workspace on Ana PC');
  });

  it('shows a live line for each call, and hands the call to the executor unchanged', async () => {
    const h = harness();
    const { executor, exec } = await opened(h);
    const opts = { signal: new AbortController().signal };
    await executor.run('file_read', { path: 'src/a.ts' }, opts);
    await executor.run('run_code', { language: 'python', code: 'print(1)' }, opts);
    expect(h.lines).toEqual(['file_read src/a.ts', 'run_code python']);
    expect(exec.inner.run).toHaveBeenCalledWith('file_read', { path: 'src/a.ts' }, opts);
  });

  it('is serving once claimed, and Stop closes the session through the client', async () => {
    const h = harness();
    const { s } = await opened(h);
    expect(h.ws.status().serving).toBeNull(); // opened, not yet claimed
    s.onServing!(info());
    expect(h.ws.status().serving).toMatchObject({ runId: 'run-1', label: 'Workspace on Ana PC' });
    expect(h.servedUi).toEqual([{ label: 'Workspace on Ana PC' }]);
    expect(h.ws.stopRun()).toEqual({ ok: true });
    expect(h.client.stop).toHaveBeenCalledOnce();
    s.onServing!(null);
    expect(h.ws.status().serving).toBeNull();
    expect(h.ws.stopRun()).toHaveProperty('error');
  });

  it('refuses to open without a consent for the run', async () => {
    const h = harness();
    void h.ws.start();
    await expect(h.served[0]!.open({ tools: ['file_read'], label: 'x' }, run())).rejects.toThrow(/no consent/);
  });

  it('asks about a risky call here; allow runs it, deny and no answer refuse it', async () => {
    const h = harness({ callTimeoutMs: 30_000 });
    const { exec } = await opened(h);
    let p = exec.ask(call('shell'));
    expect(q(h).q).toMatchObject({ tool: 'shell', summary: 'rm -rf build', risk: 'risky', reason: 'deletes files', timeoutMs: 30_000 });
    q(h).resolve('allow');
    expect(await p).toBe(true);
    p = exec.ask(call('shell'));
    q(h).resolve('deny');
    expect(await p).toBe(false);
    p = exec.ask(call('shell'));
    const pending = q(h);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await p).toBe(false);
    expect(pending.q.signal.aborted).toBe(true);
  });

  it('times a question about a call out to a refusal after two minutes by default', async () => {
    const h = harness();
    const { exec } = await opened(h);
    const p = exec.ask(call('shell'));
    expect(q(h).q.timeoutMs).toBe(120_000);
    let done = false;
    void p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await p).toBe(false);
  });

  it('masks configured credentials in the call it shows, and strips escape sequences', async () => {
    const h = harness();
    const { exec } = await opened(h);
    const p = exec.ask(call('shell', { command: 'curl -H "Authorization: Bearer sk-from-config" x\u001b[2J' }));
    expect(q(h).q.summary).not.toContain('sk-from-config');
    expect(q(h).q.summary).not.toContain('\u001b');
    q(h).resolve('deny');
    await p;
  });

  it('refuses a call the run withdrew, and one pending when Stop is pressed', async () => {
    const h = harness();
    const { exec, s } = await opened(h);
    const ac = new AbortController();
    const p = exec.ask(call('shell', { command: 'x' }, ac.signal));
    ac.abort();
    expect(await p).toBe(false);
    s.onServing!(info());
    const p2 = exec.ask(call('shell', { command: 'x' }));
    h.ws.stopRun();
    expect(await p2).toBe(false);
  });

  it('"all" answers what else is waiting and later questions of that run, and not the next run\'s', async () => {
    const h = harness();
    const { exec, s } = await opened(h);
    s.onServing!(info());
    const a = exec.ask(call('shell', { command: 'a' }));
    const waiting = exec.ask(call('shell', { command: 'a2' }));
    h.calls[0]!.resolve('all');
    expect(await a).toBe(true);
    expect(await waiting).toBe(true);
    expect(await exec.ask(call('shell', { command: 'b' }))).toBe(true);
    expect(h.ws.status().serving).toMatchObject({ allowAll: true });
    s.onServing!(null);
    const next = await opened(h, undefined, 'run-2');
    const c = next.exec.ask(call('shell', { command: 'c' }));
    expect(h.calls.at(-1)!.q.summary).toBe('c');
    h.calls.at(-1)!.resolve('deny');
    expect(await c).toBe(false);
  });

  it('questions still open when the run ends are refused', async () => {
    const h = harness();
    const { exec, s } = await opened(h);
    s.onServing!(info());
    const p = exec.ask(call('shell'));
    s.onServing!(null);
    expect(await p).toBe(false);
  });

  it('offers to undo the run\'s changes from its checkpoint, once', async () => {
    const h = harness();
    const { exec, s } = await opened(h);
    s.onServing!(info());
    await exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }]);
    s.onServing!(null);
    expect(h.ended).toEqual([{ label: 'Workspace on Ana PC', changed: 2, canUndo: true, undone: false, note: null }]);
    expect(await h.ws.undoLastRun()).toEqual({ ok: true, restored: 1, removed: 1, skipped: 0 });
    expect(h.checkpoints.undo).toHaveBeenCalledWith(1);
    expect(h.ws.status().lastRun).toMatchObject({ undone: true, canUndo: false });
    expect(await h.ws.undoLastRun()).toHaveProperty('error');
  });

  it('does not undo when a newer checkpoint exists, and offers nothing for a run that changed nothing', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!(info());
    await a.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }, { n: 4, changed: 1, after: 's' }]);
    a.s.onServing!(null);
    expect(await h.ws.undoLastRun()).toMatchObject({ error: expect.stringMatching(/newer checkpoint/) });
    expect(h.checkpoints.undo).not.toHaveBeenCalled();

    const b = await opened(h, undefined, 'run-2');
    b.s.onServing!(info('run-2'));
    b.s.onServing!(null);
    expect(h.ws.status().lastRun).toMatchObject({ canUndo: false, changed: 0 });
  });

  it('never undoes another run: not once this run was undone from Cascade, and not past a newer one undone', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!(info());
    await a.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 2, changed: 5, after: 's' }, { n: 3, changed: 2, after: 's' }]);
    a.s.onServing!(null);
    h.checkpoints.list.mockReturnValue([{ n: 2, changed: 5, after: 's' }, { n: 3, changed: 2, after: 's', undone: true }]);
    expect(await h.ws.undoLastRun()).toMatchObject({ error: expect.stringMatching(/already undone/) });
    expect(h.checkpoints.undo).not.toHaveBeenCalled();
    expect(h.ws.status().lastRun).toMatchObject({ undone: true, canUndo: false });

    const b = await opened(h, undefined, 'run-2');
    b.s.onServing!(info('run-2'));
    await b.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }]);
    b.s.onServing!(null);
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }, { n: 4, changed: 1, after: 's', undone: true }]);
    expect(await h.ws.undoLastRun()).toMatchObject({ ok: true });
  });

  it('refuses an undo while a run is using the folder', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!(info());
    await a.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }]);
    a.s.onServing!(null);
    // A second run opens (the first's summary is replaced once it is served).
    const b = await opened(h, undefined, 'run-2');
    expect(await h.ws.undoLastRun()).toMatchObject({ error: expect.stringMatching(/using the folder/) });
    b.s.onServing!(info('run-2'));
    expect(await h.ws.undoLastRun()).toHaveProperty('error');
    expect(h.checkpoints.undo).not.toHaveBeenCalled();
  });

  it('a service stopped and started again: no new run opens until the old one has finished, and the old one opens none', async () => {
    const h = harness();
    const first = await opened(h);
    first.s.onServing!(info());
    // Stopped while a call drains, and started again; a new run is asked for.
    h.ws.stop();
    void h.ws.start();
    const next = h.served.at(-1)!;
    expect(next).not.toBe(first.s);
    const p = next.askUser(run({ runId: 'run-2' }));
    h.consents.at(-1)!.resolve({ tools: ['file_read'], labelMode: 'device' });
    const consent = (await p)!;
    // The old run's last calls and checkpoint aren't done: the new run waits.
    await expect(next.open(consent, run({ runId: 'run-2' }))).rejects.toThrow(/still finishing/);
    await expect(first.s.open(first.consent, run())).rejects.toThrow(/turned off/);
    // The old run finishes: now it opens, and Stop reaches it.
    first.s.onServing!(null);
    const p2 = next.askUser(run({ runId: 'run-3' }));
    h.consents.at(-1)!.resolve({ tools: ['file_read'], labelMode: 'device' });
    await expect(next.open((await p2)!, run({ runId: 'run-3' }))).resolves.toBeDefined();
    next.onServing!(info('run-3'));
    expect(h.ws.status().serving).not.toBeNull();
    expect(h.ws.stopRun()).toEqual({ ok: true });
  });

  it("a service stopped while the folder's config loads never replaces the new service's run", async () => {
    const h = harness();
    void h.ws.start();
    const old = h.served.at(-1)!;
    const p = old.askUser(run());
    h.consents.at(-1)!.resolve({ tools: ['file_read'], labelMode: 'device' });
    const consent = (await p)!;
    let release!: () => void;
    h.loadGate.wait = new Promise<void>((r) => { release = r; });
    const late = old.open(consent, run());
    h.ws.stop();
    h.loadGate.wait = Promise.resolve();
    const fresh = await opened(h, undefined, 'run-2');
    fresh.s.onServing!(info('run-2'));
    release();
    await expect(late).rejects.toThrow(/turned off/);
    // The old service's report about its own run doesn't end the new one's.
    old.onServing!(null);
    expect(h.ws.status().serving).not.toBeNull();
    expect(h.ws.stopRun()).toEqual({ ok: true });
  });

  it('an incomplete checkpoint is never reported as undone', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!(info());
    await a.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 'snap' }]);
    a.s.onServing!(null);
    expect(h.ws.status().lastRun).toMatchObject({ canUndo: true });
    // Its last snapshot failed after the offer showed: undo puts nothing back.
    h.checkpoints.undo.mockResolvedValueOnce({ restored: [], removed: [], skipped: [], incomplete: [{ n: 3 }] } as never);
    expect(await h.ws.undoLastRun()).toMatchObject({ error: expect.stringMatching(/incomplete/) });
    expect(h.ws.status().lastRun).toMatchObject({ undone: false });

    // Seen as incomplete when the run ends: no undo is offered.
    const b = await opened(h, undefined, 'run-2');
    b.s.onServing!(info('run-2'));
    await b.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2 }]);
    b.s.onServing!(null);
    expect(h.ws.status().lastRun).toMatchObject({ canUndo: false, note: expect.stringMatching(/incomplete/) });
  });

  it('an undo still working updates only the summary it was started for', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!(info());
    await a.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }]);
    a.s.onServing!(null);
    let finish!: (v: { restored: string[]; removed: string[]; skipped: string[] }) => void;
    h.checkpoints.undo.mockReturnValueOnce(new Promise((r) => { finish = r; }) as never);
    const undoing = h.ws.undoLastRun();
    expect(await h.ws.undoLastRun()).toMatchObject({ error: expect.stringMatching(/already running/) });
    // Dismissed while the undo works: it doesn't come back as "undone".
    h.ws.dismissLastRun();
    finish({ restored: ['a'], removed: [], skipped: [] });
    expect(await undoing).toMatchObject({ ok: true });
    expect(h.ws.status().lastRun).toBeNull();
  });

  it('no run opens the folder while an undo is putting files back, not even one whose config was still loading', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!(info());
    await a.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }]);
    a.s.onServing!(null);
    const s = h.served.at(-1)!;
    const p1 = s.askUser(run({ runId: 'run-2' }));
    h.consents.at(-1)!.resolve({ tools: ['file_read'], labelMode: 'device' });
    const c1 = (await p1)!;
    let release!: () => void;
    h.loadGate.wait = new Promise<void>((r) => { release = r; });
    const loading = s.open(c1, run({ runId: 'run-2' }));
    let finish!: (v: { restored: string[]; removed: string[]; skipped: string[] }) => void;
    h.checkpoints.undo.mockReturnValueOnce(new Promise((r) => { finish = r; }) as never);
    const undoing = h.ws.undoLastRun();
    release();
    await expect(loading).rejects.toThrow(/undo/);
    // And one asked for while the undo runs.
    h.loadGate.wait = Promise.resolve();
    const p2 = s.askUser(run({ runId: 'run-3' }));
    h.consents.at(-1)!.resolve({ tools: ['file_read'], labelMode: 'device' });
    await expect(s.open((await p2)!, run({ runId: 'run-3' }))).rejects.toThrow(/undo/);
    finish({ restored: ['a'], removed: [], skipped: [] });
    expect(await undoing).toMatchObject({ ok: true });
    // Once it is done, runs open again.
    const p3 = s.askUser(run({ runId: 'run-4' }));
    h.consents.at(-1)!.resolve({ tools: ['file_read'], labelMode: 'device' });
    await expect(s.open((await p3)!, run({ runId: 'run-4' }))).resolves.toBeDefined();
  });
});
