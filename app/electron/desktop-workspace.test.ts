import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopWorkspace, WORKSPACE_CONTROL_PATH, WORKSPACE_RUN_PATH,
  type DesktopWorkspaceCore, type DesktopWorkspaceDeps, type WorkspaceSettings,
} from './desktop-workspace.js';
import type { StoredDesktopDevice } from './desktop-relay.js';
import type { FolderFs } from './workspace-consent.js';

type ServeOpts = Parameters<DesktopWorkspaceCore['serveWorkspaceDevice']>[0];
const HOME = path.resolve(os.homedir());
const PROJ = path.join(HOME, 'code', 'proj');
const fsFake: FolderFs = { home: () => HOME, realpath: (p) => p, isDirectory: () => true };

const device = (over: Partial<StoredDesktopDevice> = {}): StoredDesktopDevice => ({
  serverUrl: 'https://cloud.example', accountId: 'user-a', deviceId: 'dev-1', name: 'Ana PC (desktop app)', serverId: 's1', serverKey: 'k1',
  controlPath: '/browser/c', runPath: '/browser/r', privateKeyEnc: 'enc:PEM', enabled: false, ...over,
});

function harness(over: { device?: StoredDesktopDevice | null; account?: string | null; settings?: WorkspaceSettings; callTimeoutMs?: number } = {}) {
  let account: string | null = over.account === undefined ? 'user-a' : over.account;
  let dev: StoredDesktopDevice | null = over.device === undefined ? device() : over.device;
  let settings: WorkspaceSettings = over.settings ?? { enabled: false };
  const served: ServeOpts[] = [];
  // Held open by a test to keep a folder's config loading.
  const loadGate: { wait: Promise<void> } = { wait: Promise.resolve() };
  const notes: Array<[string, any]> = [];
  const client = { stop: vi.fn() };
  const executors: any[] = [];
  const checkpoints = { list: vi.fn((): any[] => []), undo: vi.fn(async () => ({ restored: ['a'], removed: ['b'], skipped: [] as string[] })), begin: vi.fn(async () => ({ n: 3 })), end: vi.fn(async () => ({})) };
  const core = {
    relayEndpoints: (url: string, p: { controlPath: string; runPath: string }) => ({ controlUrl: url + p.controlPath, runUrl: url + p.runPath }),
    serveWorkspaceDevice: (o: ServeOpts) => {
      served.push(o);
      o.onClient?.(client);
      return new Promise<'stopped' | 'refused'>((r) => o.signal.addEventListener('abort', () => r('stopped')));
    },
    createWorkspaceExecutor: (o: unknown) => { executors.push(o); return { finish: async () => {} }; },
    ToolRegistry: class { ignored: string[] | null = null; secrets: (() => string[]) | null = null; constructor(public config: unknown, public root: string) {} setIgnoredPaths(p: string[]) { this.ignored = p; } setSecretValues(r: () => string[]) { this.secrets = r; } },
    secretValuesIn: (c: unknown) => [JSON.stringify(c).includes('apiKey') ? 'sk-from-config' : 'none'],
    ConfigManager: class { async load() { await loadGate.wait; } getConfig() { return { providers: [{ type: 'openai', apiKey: 'sk-from-config' }], tools: { x: 1 }, privacy: { paths: [{ pattern: 'secret/**', policy: 'local-only' }] } }; } getIgnore() { return { getUserPatterns: () => ['private/**', '*.csv'] }; } },
    PrivacyPaths: class { constructor(public policies: unknown) {} },
    Checkpoints: class { constructor() { return checkpoints as never; } },
    statePath: (root: string, p: string) => path.join(root, '.state', p),
    STATE: { checkpoints: 'checkpoints' },
  } as unknown as DesktopWorkspaceCore;
  const deps: DesktopWorkspaceDeps = {
    core,
    cloud: () => (account ? { userId: account, serverUrl: 'https://cloud.example' } : null),
    device: { load: () => dev },
    vault: { decrypt: (b) => b.replace(/^enc:/, '') },
    settings: { load: () => settings, save: (s) => { settings = s; } },
    notify: (c, p) => { notes.push([c, p]); },
    fs: fsFake,
    hostname: () => 'host',
    ...(over.callTimeoutMs ? { callTimeoutMs: over.callTimeoutMs } : {}),
  };
  const ws = createDesktopWorkspace(deps);
  return {
    ws, served, notes, client, executors, checkpoints, loadGate,
    settings: () => settings,
    setDevice: (d: StoredDesktopDevice | null) => { dev = d; },
    setAccount: (a: string | null) => { account = a; },
    last: (channel: string) => notes.filter((n) => n[0] === channel).at(-1)?.[1],
    connect: (i = 0) => served[i]!.log('connected: cloud runs can ask for this workspace'),
  };
}

const run = (over: Partial<{ runId: string; expiresAt: number; signal: AbortSignal }> = {}) =>
  ({ runId: 'run-1', userId: 'user-a', expiresAt: Date.now() + 5 * 60_000, signal: new AbortController().signal, ...over });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('serving state', () => {
  it('is off by default, serves nothing, and says when this app is not paired', () => {
    const h = harness({ device: null });
    expect(h.ws.status()).toMatchObject({ paired: false, enabled: false, connected: false, serving: null });
    expect(() => h.ws.enable()).toThrow(/not paired/i);
    h.ws.resume();
    expect(h.served).toHaveLength(0);
  });

  it('serves with the browser relay\'s stored key and pinned server, at the workspace paths', () => {
    const h = harness();
    expect(h.ws.enable()).toMatchObject({ paired: true, enabled: true, connected: false });
    expect(h.served[0]!.stored).toEqual({ deviceId: 'dev-1', privateKeyPem: 'PEM', serverId: 's1', serverKey: 'k1' });
    expect(h.served[0]!.endpoints).toEqual({
      controlUrl: `https://cloud.example${WORKSPACE_CONTROL_PATH}`, runUrl: `https://cloud.example${WORKSPACE_RUN_PATH}`,
    });
    h.connect();
    expect(h.ws.status().connected).toBe(true);
    expect(h.settings().enabled).toBe(true);
  });

  it('disables: the connection is closed and the choice is kept off', () => {
    const h = harness();
    h.ws.enable(); h.connect();
    expect(h.ws.disable()).toMatchObject({ enabled: false, connected: false });
    expect(h.served[0]!.signal.aborted).toBe(true);
    expect(h.settings().enabled).toBe(false);
  });

  it('resumes only when left on and the pairing\'s own account is signed in', () => {
    const on = harness({ settings: { enabled: true } });
    on.ws.resume();
    expect(on.served).toHaveLength(1);
    const other = harness({ settings: { enabled: true }, account: 'user-b' });
    other.ws.resume();
    expect(other.served).toHaveLength(0);
    expect(other.ws.status().error).toMatch(/another Cascade Cloud account/);
    const out = harness({ settings: { enabled: true }, account: null });
    expect(out.ws.status().error).toMatch(/Sign in/);
  });

  it('stops when the account changes, and when the pairing is removed', () => {
    const h = harness({ settings: { enabled: true } });
    h.ws.resume();
    h.setAccount('user-b');
    h.ws.accountChanged();
    expect(h.served[0]!.signal.aborted).toBe(true);
    expect(h.served).toHaveLength(1);
    h.setAccount('user-a');
    h.ws.accountChanged();
    expect(h.served).toHaveLength(2);
    h.setDevice(null);
    h.ws.deviceChanged();
    expect(h.served[1]!.signal.aborted).toBe(true);
    expect(h.settings().enabled).toBe(false);
  });
});

describe('the consent question', () => {
  it('asks in the window, and a yes gives the tools and a label that is not the path', async () => {
    const h = harness();
    h.ws.enable();
    const p = h.served[0]!.askUser(run());
    const ask = h.last('workspace:ask');
    expect(ask).toMatchObject({ runId: 'run-1', device: 'Ana PC (desktop app)' });
    expect(h.ws.answer(ask.id, { folder: PROJ, tools: ['file_read', 'shell', 'bogus'], labelMode: 'folder' })).toEqual({ ok: true });
    const consent = await p;
    expect(consent).toEqual({ tools: ['file_read', 'shell'], label: 'proj' });
    expect(JSON.stringify(consent)).not.toContain(HOME);
    // Remembered as the next default.
    expect(h.settings()).toMatchObject({ folder: PROJ, tools: ['file_read', 'shell'], labelMode: 'folder' });
    expect(h.ws.status().defaults.folder).toBe(PROJ);
  });

  it('refuses the home folder and asks again; no tools asks again too', async () => {
    const h = harness();
    h.ws.enable();
    const p = h.served[0]!.askUser(run());
    const id = h.last('workspace:ask').id;
    expect(h.ws.answer(id, { folder: HOME, tools: ['file_read'] })).toHaveProperty('error');
    expect(h.ws.answer(id, { folder: path.parse(HOME).root, tools: ['file_read'] })).toHaveProperty('error');
    expect(h.ws.answer(id, { folder: PROJ, tools: ['rm'] })).toHaveProperty('error');
    expect(h.ws.answer(id, null)).toEqual({ ok: true });
    expect(await p).toBeNull();
  });

  it('is a no when unanswered within the offer\'s time', async () => {
    const h = harness();
    h.ws.enable();
    const p = h.served[0]!.askUser(run({ expiresAt: Date.now() + 60_000 }));
    const id = h.last('workspace:ask').id;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await p).toBeNull();
    expect(h.last('workspace:ask-closed')).toEqual({ id });
    expect(h.ws.answer(id, { folder: PROJ, tools: ['file_read'] })).toHaveProperty('error');
  });

  it('closes when the offer is withdrawn, and when serving is turned off', async () => {
    const h = harness();
    h.ws.enable();
    const ac = new AbortController();
    const p = h.served[0]!.askUser(run({ signal: ac.signal }));
    ac.abort();
    expect(await p).toBeNull();
    const q = h.served[0]!.askUser(run());
    h.ws.disable();
    expect(await q).toBeNull();
  });
});

describe('a served run', () => {
  async function opened(h: ReturnType<typeof harness>, tools = ['file_read', 'file_write', 'shell']) {
    h.ws.enable();
    const s = h.served.at(-1)!;
    const p = s.askUser(run());
    h.ws.answer(h.last('workspace:ask').id, { folder: PROJ, tools });
    const consent = (await p)!;
    const executor = await s.open(consent, run());
    const exec = h.executors.at(-1);
    return { s, consent, executor, exec };
  }

  it('builds the executor over the chosen folder with its own privacy rules and checkpoints, and only the allowed tools', async () => {
    const h = harness();
    const { exec } = await opened(h);
    expect(exec.tools).toEqual(['file_read', 'file_write', 'shell']);
    expect(exec.registry.root).toBe(PROJ);
    expect(exec.registry.config).toMatchObject({ x: 1, enabledTools: ['file_read', 'file_write', 'shell'], browserEnabled: false });
    expect(exec.privacy().policies).toEqual([{ pattern: 'secret/**', policy: 'local-only' }]);
    // The folder's .cascadeignore protects what it lists from the run, as in a local run.
    expect(exec.registry.ignored).toEqual(['private/**', '*.csv']);
    // Its configured credentials are scrubbed from commands' environment.
    expect(exec.registry.secrets()).toEqual(['sk-from-config']);
    expect(await exec.checkpoints.begin('x')).toEqual({ n: 3 });
  });

  it('shows "Serving a Cloud run" once claimed, and Stop closes the session through the client', async () => {
    const h = harness();
    const { s } = await opened(h);
    expect(h.ws.status().serving).toBeNull(); // opened, not yet claimed
    s.onServing!({ runId: 'run-1', userId: 'user-a', expiresAt: 1, label: 'Workspace on Ana PC (desktop app)' });
    expect(h.ws.status().serving).toMatchObject({ runId: 'run-1', label: 'Workspace on Ana PC (desktop app)' });
    expect(h.ws.stop()).toEqual({ ok: true });
    expect(h.client.stop).toHaveBeenCalledOnce();
    s.onServing!(null);
    expect(h.ws.status().serving).toBeNull();
    expect(h.ws.stop()).toHaveProperty('error');
  });

  it('refuses to open without a chosen folder, or when the folder is no longer allowed', async () => {
    const h = harness();
    h.ws.enable();
    await expect(h.served[0]!.open({ tools: ['file_read'], label: 'x' }, run())).rejects.toThrow(/no folder/);
  });

  it('asks about a risky call in the window; Allow runs it, Deny and no answer refuse it', async () => {
    const h = harness({ callTimeoutMs: 30_000 });
    const { exec } = await opened(h);
    const q = (tool = 'shell') => exec.ask({ tool, input: { command: 'rm -rf build' }, risk: { level: 'risky', reason: 'deletes files' }, signal: new AbortController().signal });
    let p = q();
    const first = h.last('workspace:call-ask');
    expect(first).toMatchObject({ tool: 'shell', summary: 'rm -rf build', risk: 'risky' });
    h.ws.answerCall(first.id, 'allow');
    expect(await p).toBe(true);
    p = q();
    h.ws.answerCall(h.last('workspace:call-ask').id, 'deny');
    expect(await p).toBe(false);
    p = q();
    const id = h.last('workspace:call-ask').id;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await p).toBe(false);
    expect(h.last('workspace:call-ask-closed')).toEqual({ id });
  });

  it('refuses a call the run withdrew, and one pending when Stop is pressed', async () => {
    const h = harness();
    const { exec, s } = await opened(h);
    const ac = new AbortController();
    const p = exec.ask({ tool: 'shell', input: { command: 'x' }, risk: { level: 'risky', reason: 'r' }, signal: ac.signal });
    ac.abort();
    expect(await p).toBe(false);
    s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'l' });
    const p2 = exec.ask({ tool: 'shell', input: { command: 'x' }, risk: { level: 'risky', reason: 'r' }, signal: new AbortController().signal });
    h.ws.stop();
    expect(await p2).toBe(false);
  });

  it('"Allow everything for this run" answers later questions of that run, and not the next run\'s', async () => {
    const h = harness();
    const { exec, s } = await opened(h);
    s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'l' });
    const sig = new AbortController().signal;
    const a = exec.ask({ tool: 'shell', input: { command: 'a' }, risk: { level: 'risky', reason: 'r' }, signal: sig });
    h.ws.answerCall(h.last('workspace:call-ask').id, 'all');
    expect(await a).toBe(true);
    expect(await exec.ask({ tool: 'shell', input: { command: 'b' }, risk: { level: 'risky', reason: 'r' }, signal: sig })).toBe(true);
    s.onServing!(null);
    const next = await opened(h);
    const c = next.exec.ask({ tool: 'shell', input: { command: 'c' }, risk: { level: 'risky', reason: 'r' }, signal: sig });
    expect(h.last('workspace:call-ask').summary).toBe('c');
    h.ws.answerCall(h.last('workspace:call-ask').id, 'deny');
    expect(await c).toBe(false);
  });

  it('offers to undo the run\'s changes from its checkpoint, once', async () => {
    const h = harness();
    const { exec, s } = await opened(h);
    s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'proj' });
    await exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }]);
    s.onServing!(null);
    expect(h.ws.status().lastRun).toMatchObject({ label: 'Workspace on Ana PC (desktop app)', changed: 2, canUndo: true, undone: false });
    expect(await h.ws.undoLastRun()).toEqual({ ok: true, restored: 1, removed: 1, skipped: 0 });
    expect(h.checkpoints.undo).toHaveBeenCalledWith(1);
    expect(h.ws.status().lastRun).toMatchObject({ undone: true, canUndo: false });
    expect(await h.ws.undoLastRun()).toHaveProperty('error');
  });

  it('does not undo when a newer checkpoint exists, and offers nothing for a run that changed nothing', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'proj' });
    await a.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }, { n: 4, changed: 1, after: 's' }]);
    a.s.onServing!(null);
    expect(await h.ws.undoLastRun()).toMatchObject({ error: expect.stringMatching(/newer checkpoint/) });
    expect(h.checkpoints.undo).not.toHaveBeenCalled();

    const b = await opened(h);
    b.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'proj' });
    b.s.onServing!(null);
    expect(h.ws.status().lastRun).toMatchObject({ canUndo: false, changed: 0 });
  });

  it('never undoes another run: not once this run was undone from Cascade, and not past a newer one undone', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'proj' });
    await a.exec.checkpoints.begin('run');
    // Undone with /undo elsewhere: the newest is still n 3, and undo(1) would pick n 2.
    h.checkpoints.list.mockReturnValue([{ n: 2, changed: 5, after: 's' }, { n: 3, changed: 2, after: 's' }]);
    a.s.onServing!(null);
    h.checkpoints.list.mockReturnValue([{ n: 2, changed: 5, after: 's' }, { n: 3, changed: 2, after: 's', undone: true }]);
    expect(await h.ws.undoLastRun()).toMatchObject({ error: expect.stringMatching(/already undone/) });
    expect(h.checkpoints.undo).not.toHaveBeenCalled();
    expect(h.ws.status().lastRun).toMatchObject({ undone: true, canUndo: false });

    // A newer run that was itself undone: undo(1) picks this run's, so it may.
    const b = await opened(h);
    b.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'proj' });
    await b.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }]);
    b.s.onServing!(null);
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 's' }, { n: 4, changed: 1, after: 's', undone: true }]);
    expect(await h.ws.undoLastRun()).toMatchObject({ ok: true });
  });

  it('a service turned off and on again: the old one finishing late never ends the new run, nor opens one', async () => {
    const h = harness();
    const first = await opened(h);
    first.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'l' });
    // Turned off while a call drains, and on again; the new service opens a run.
    h.ws.disable();
    const second = await opened(h);
    expect(second.s).not.toBe(first.s);
    second.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'l' });
    expect(h.ws.status().serving).not.toBeNull();
    // The old service finishes now: the new run is untouched, and Stop still reaches it.
    first.s.onServing!(null);
    expect(h.ws.status().serving).not.toBeNull();
    await expect(first.s.open(first.consent, run())).rejects.toThrow(/turned off/);
    expect(h.ws.stop()).toEqual({ ok: true });
  });

  it("a service turned off while the folder's config loads never replaces the new service's run", async () => {
    const h = harness();
    h.ws.enable();
    const old = h.served.at(-1)!;
    const p = old.askUser(run());
    h.ws.answer(h.last('workspace:ask').id, { folder: PROJ, tools: ['file_read'] });
    const consent = (await p)!;
    let release!: () => void;
    h.loadGate.wait = new Promise<void>((r) => { release = r; });
    const late = old.open(consent, run());
    // Off and on again while that load waits; the new service opens its run.
    h.ws.disable();
    h.loadGate.wait = Promise.resolve();
    const fresh = await opened(h);
    fresh.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'l' });
    release();
    await expect(late).rejects.toThrow(/turned off/);
    old.onServing!(null);
    expect(h.ws.status().serving).not.toBeNull();
    expect(h.ws.stop()).toEqual({ ok: true });
  });

  it('an incomplete checkpoint is never reported as undone', async () => {
    const h = harness();
    const a = await opened(h);
    a.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'proj' });
    await a.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2, after: 'snap' }]);
    a.s.onServing!(null);
    expect(h.ws.status().lastRun).toMatchObject({ canUndo: true });
    // Its last snapshot failed after the banner showed: undo puts nothing back.
    h.checkpoints.undo.mockResolvedValueOnce({ restored: [], removed: [], skipped: [], incomplete: [{ n: 3 }] } as never);
    expect(await h.ws.undoLastRun()).toMatchObject({ error: expect.stringMatching(/incomplete/) });
    expect(h.ws.status().lastRun).toMatchObject({ undone: false });

    // Seen as incomplete when the run ends: no Undo is offered.
    const b = await opened(h);
    b.s.onServing!({ runId: 'run-1', userId: 'u', expiresAt: 1, label: 'proj' });
    await b.exec.checkpoints.begin('run');
    h.checkpoints.list.mockReturnValue([{ n: 3, changed: 2 }]);
    b.s.onServing!(null);
    expect(h.ws.status().lastRun).toMatchObject({ canUndo: false, note: expect.stringMatching(/incomplete/) });
  });

  it('keeps open questions for a window that opens later, and drops them once answered or closed', async () => {
    const h = harness();
    h.ws.enable();
    h.connect();
    const s = h.served[0]!;
    const asked = s.askUser(run());
    expect(h.ws.pending().asks).toEqual([expect.objectContaining({ runId: 'run-1', device: expect.any(String) })]);
    const id = (h.ws.pending().asks[0] as { id: number }).id;
    h.ws.answer(id, null);
    expect(await asked).toBeNull();
    expect(h.ws.pending()).toEqual({ asks: [], calls: [] });
  });
});
