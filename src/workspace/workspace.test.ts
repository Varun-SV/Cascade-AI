// A cloud run's tools, run in a folder on the user's machine: the hub, the device
// and the run's side over real sockets, with Cascade's own tool registry on the device.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BROWSER_FAMILY, type Identity, claimAtServer, createDeviceApprovals, createIdentity, createMemoryNonceStore, issueGrant, verifyGrant,
} from '../browser/relay/capability.js';
import { RelayRefused, authenticateControl, createRelayHub } from '../browser/relay/hub.js';
import { PrivacyPaths } from '../core/privacy/paths.js';
import { ToolRegistry } from '../tools/registry.js';
import { type WorkspaceConsent, type WorkspaceDeviceClient, connectWorkspaceDevice } from './device.js';
import { type WorkspaceCheckpoints, type WorkspaceQuestion, createWorkspaceExecutor } from './executor.js';
import { MAX_CHANGED, MAX_IN_FLIGHT, MAX_RESULT_CHARS, WORKSPACE_FAMILY, WORKSPACE_TOOLS, readDeviceFrame, readServerFrame } from './protocol.js';
import { openRemoteWorkspace } from './remote.js';

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

async function world() {
  const server = createIdentity('server');
  const keys = new Map<string, Identity>();
  const owners = new Map<string, string>();
  const hub = createRelayHub({
    server, store: createMemoryNonceStore(Date.now), deviceKey: (id) => keys.get(id)?.publicKey ?? null, family: WORKSPACE_FAMILY,
  });
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/control') {
      void authenticateControl(ws, {
        serverId: server.id, timeoutMs: 1000,
        device: (id) => (owners.has(id) && keys.has(id) ? { userId: owners.get(id)!, key: keys.get(id)!.publicKey } : null),
      }).then((who) => { if (who) hub.attachDevice(who, ws); });
    } else if (url.pathname === '/run') hub.attachRun(ws);
    else if (url.pathname.startsWith('/agent/')) hub.attachAgent(url.pathname.slice('/agent/'.length), ws);
    else ws.close();
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  closers.push(() => { hub.close(); httpServer.closeAllConnections(); httpServer.close(); });
  const register = (userId: string, id: string): Identity => { const d = createIdentity(id); keys.set(id, d); owners.set(id, userId); return d; };
  /**
   * The run's connection, handed over by token. Not awaited open: the machine's
   * `ready` can arrive in the same read as the connection opening, so whoever
   * reads it must be listening from the start.
   */
  const agent = (token: string): WebSocket => new WebSocket(`${base}/agent/${token}`);
  return { hub, server, base, register, agent };
}

/** A folder on "the machine", with a file in it. */
function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ws-'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello from the machine\n');
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function registryFor(dir: string): ToolRegistry {
  return new ToolRegistry({
    shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, processJail: 'off',
    enabledTools: [...WORKSPACE_TOOLS],
  } as never, dir);
}

interface DeviceSetup {
  answer?: WorkspaceConsent | null;
  ask?: (q: WorkspaceQuestion) => Promise<boolean>;
  checkpoints?: WorkspaceCheckpoints;
  privacy?: PrivacyPaths;
}

async function machine(w: Awaited<ReturnType<typeof world>>, dir: string, setup: DeviceSetup = {}) {
  const id = w.register('user-1', 'dev-1');
  const asked: string[] = [];
  const questions: WorkspaceQuestion[] = [];
  const client: WorkspaceDeviceClient = connectWorkspaceDevice({
    controlUrl: `${w.base}/control`, runUrl: `${w.base}/run`,
    device: id, serverId: w.server.id, serverKey: w.server.publicKey,
    askUser: async (run) => { asked.push(run.runId); return setup.answer === undefined ? { tools: ['file_read', 'file_write', 'file_list', 'shell', 'file_delete'], label: 'my-project' } : setup.answer; },
    open: async (consent) => createWorkspaceExecutor({
      registry: registryFor(dir), tools: consent.tools,
      ask: async (q) => { questions.push(q); return setup.ask ? setup.ask(q) : false; },
      ...(setup.checkpoints ? { checkpoints: setup.checkpoints } : {}),
      privacy: () => setup.privacy,
    }),
  });
  closers.push(() => client.close());
  await client.ready;
  await vi.waitFor(() => expect(w.hub.deviceOnline('user-1', 'dev-1')).toBe(true));
  return { client, asked, questions };
}

/** A run asks for the workspace, and gets its tools. */
async function runWorkspace(w: Awaited<ReturnType<typeof world>>, runId = 'run-1') {
  const lease = await w.hub.requestBrowser({ userId: 'user-1', deviceId: 'dev-1', runId });
  const socket = w.agent(lease.token);
  const ws = await openRemoteWorkspace(socket);
  closers.push(() => ws.close());
  const tool = (name: string) => {
    const t = ws.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no ${name}`);
    return (input: Record<string, unknown>, signal?: AbortSignal) => t.execute(input, { tierId: 't3', sessionId: 's', requireApproval: false, ...(signal ? { signal } : {}) });
  };
  return { lease, ws, tool, socket };
}

describe('a cloud run working in a folder on the user\'s machine', () => {
  it('gets exactly the tools the user allowed, reads and writes in the folder, and never learns its path', async () => {
    const w = await world();
    const dir = folder();
    const frames: string[] = [];
    await machine(w, dir, { checkpoints: { begin: async () => ({ n: 1 }), end: async () => undefined } });
    const lease = await w.hub.requestBrowser({ userId: 'user-1', deviceId: 'dev-1', runId: 'run-1' });
    const socket = w.agent(lease.token);
    socket.on('message', (raw) => frames.push(String(raw)));
    const ws = await openRemoteWorkspace(socket);
    closers.push(() => ws.close());
    expect(ws.label).toBe('my-project');
    expect(ws.tools.map((t) => t.name).sort()).toEqual(['file_delete', 'file_list', 'file_read', 'file_write', 'shell']);
    expect(ws.tools.every((t) => t.remote)).toBe(true);
    const run = (name: string, input: Record<string, unknown>) => ws.tools.find((t) => t.name === name)!.execute(input, { tierId: 't3', sessionId: 's', requireApproval: false });

    expect(await run('file_read', { path: 'README.md' })).toContain('hello from the machine');
    await run('file_write', { path: 'src/new.ts', content: 'export const x = 1;\n' });
    expect(fs.readFileSync(path.join(dir, 'src/new.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(await run('shell', { command: 'ls' })).toContain('README.md');
    // Nothing the machine sent names where the folder is.
    expect(frames.join('\n')).not.toContain(dir);
  });

  it('refuses on the machine a tool the user did not allow, whatever the server sends', async () => {
    const w = await world();
    const dir = folder();
    await machine(w, dir, { answer: { tools: ['file_read'], label: 'ro' } });
    const { ws, socket } = await runWorkspace(w);
    expect(ws.tools.map((t) => t.name)).toEqual(['file_read']);
    // A server that sends a call for a tool the run was never given.
    const reply = new Promise<string>((res) => socket.on('message', (raw) => res(String(raw))));
    socket.send(JSON.stringify({ v: 1, t: 'call', id: 'x1', tool: 'shell', input: { command: 'touch pwned' } }));
    const f = readDeviceFrame(await reply);
    expect(f).toMatchObject({ t: 'result', id: 'x1', ok: false });
    expect((f as { error: string }).error).toMatch(/not allowed on this machine/);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });

  it('asks on the machine before a risky call, tells the run it is waiting, and a no refuses it', async () => {
    const w = await world();
    const dir = folder();
    let answer = false;
    const m = await machine(w, dir, { ask: async () => answer });
    const { ws, tool } = await runWorkspace(w);
    const waiting: string[] = [];
    ws.onWaiting((c) => waiting.push(c.tool));
    await expect(tool('file_delete')({ path: 'README.md' })).rejects.toThrow(/Declined on the machine: file_delete deletes README\.md/);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    expect(waiting).toEqual(['file_delete']);
    expect(m.questions[0]!.risk.level).toBe('risky');
    answer = true;
    await tool('file_delete')({ path: 'README.md' });
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(false);
    // A read is never asked about.
    await tool('file_list')({ path: '.' });
    expect(m.questions).toHaveLength(2);
  });

  it('checkpoints the folder before the run\'s first change, once, and closes it when the session ends', async () => {
    const w = await world();
    const dir = folder();
    const events: string[] = [];
    const checkpoints: WorkspaceCheckpoints = {
      begin: async (label) => { events.push(`begin ${label}`); return { n: 1 }; },
      end: async (cp) => { events.push(`end ${cp.n}`); },
    };
    await machine(w, dir, { checkpoints });
    const { ws, tool } = await runWorkspace(w);
    await tool('file_read')({ path: 'README.md' });
    expect(events).toEqual([]);
    await tool('file_write')({ path: 'a.txt', content: 'a' });
    await tool('file_write')({ path: 'b.txt', content: 'b' });
    expect(events).toEqual(['begin A Cascade Cloud run']);
    ws.close();
    await vi.waitFor(() => expect(events).toEqual(['begin A Cascade Cloud run', 'end 1']));
  });

  it('with no checkpoint, every change is asked about, since none could be undone', async () => {
    const w = await world();
    const dir = folder();
    const m = await machine(w, dir, { checkpoints: { begin: async () => null, end: async () => undefined } });
    const { tool } = await runWorkspace(w);
    await expect(tool('file_write')({ path: 'a.txt', content: 'a' })).rejects.toThrow(/Declined on the machine: file_write changes a\.txt in the project, and no checkpoint of the folder could be taken/);
    expect(m.questions[0]!.risk.level).toBe('recoverable');
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false);
  });

  it('never reads a local-only file (privacy.paths) for the run: its models are cloud models', async () => {
    const w = await world();
    const dir = folder();
    fs.mkdirSync(path.join(dir, 'secret'));
    fs.writeFileSync(path.join(dir, 'secret', 'keys.txt'), 'sk-live-123');
    const privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: dir });
    await machine(w, dir, { privacy });
    const { tool } = await runWorkspace(w);
    const read = tool('file_read')({ path: 'secret/keys.txt' }).then((out) => out, (e: Error) => e.message);
    expect(await read).not.toContain('sk-live-123');
    expect(await tool('file_read')({ path: 'README.md' })).toContain('hello');
  });

  it('a no on the machine refuses the run, and the run is told', async () => {
    const w = await world();
    await machine(w, folder(), { answer: null });
    await expect(w.hub.requestBrowser({ userId: 'user-1', deviceId: 'dev-1', runId: 'run-1' })).rejects.toThrow(RelayRefused);
  });

  it('Stop on the machine ends the run\'s access at once, and the run is not given it again', async () => {
    const w = await world();
    const dir = folder();
    const m = await machine(w, dir);
    const { ws, tool } = await runWorkspace(w);
    await tool('file_read')({ path: 'README.md' });
    m.client.stop();
    expect(await ws.closed).toMatch(/closed/);
    await expect(tool('file_read')({ path: 'README.md' })).rejects.toThrow(/no longer available/);
    await expect(w.hub.requestBrowser({ userId: 'user-1', deviceId: 'dev-1', runId: 'run-1' })).rejects.toThrow(/declined/);
    // Another run asks afresh.
    await runWorkspace(w, 'run-2');
    expect(m.asked).toEqual(['run-1', 'run-2']);
  });

  it('a cancelled call is withdrawn on the machine, question included', async () => {
    const w = await world();
    const dir = folder();
    let questionSignal: AbortSignal | null = null;
    await machine(w, dir, { ask: (q) => { questionSignal = q.signal; return new Promise(() => {}); } });
    const { tool } = await runWorkspace(w);
    const ac = new AbortController();
    const call = tool('file_delete')({ path: 'README.md' }, ac.signal);
    await vi.waitFor(() => expect(questionSignal).not.toBeNull());
    ac.abort();
    await expect(call).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(questionSignal!.aborted).toBe(true));
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
  });

  it('one run at a time: a second is refused without asking while one is served', async () => {
    const w = await world();
    const m = await machine(w, folder());
    await runWorkspace(w, 'run-1');
    await expect(w.hub.requestBrowser({ userId: 'user-1', deviceId: 'dev-1', runId: 'run-2' })).rejects.toThrow(/declined/);
    expect(m.asked).toEqual(['run-1']);
  });

  it("through a cloud run's own registry, which has no shell or files of its own", async () => {
    const w = await world();
    const dir = folder();
    await machine(w, dir, { checkpoints: { begin: async () => ({ n: 1 }), end: async () => undefined } });
    const { ws } = await runWorkspace(w);
    // As a hosted run's registry is: rooted at a scratch folder, built-ins left out.
    const scratch = folder();
    const hosted = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, enabledTools: [] } as never, scratch);
    expect(hosted.hasTool('file_write')).toBe(false);
    for (const t of ws.tools) hosted.register(t);
    const opts = { tierId: 't3', sessionId: 's', requireApproval: false };
    await hosted.execute('file_write', { path: 'from-cloud.txt', content: 'hi' }, opts);
    expect(fs.readFileSync(path.join(dir, 'from-cloud.txt'), 'utf8')).toBe('hi');
    expect(fs.existsSync(path.join(scratch, 'from-cloud.txt'))).toBe(false);
    expect(await hosted.execute('file_read', { path: 'from-cloud.txt' }, opts)).toContain('hi');
    // What happens to the run's own scratch folder says nothing of the machine's: the
    // calls are the machine's, checked by its registry, not this one's.
    fs.rmSync(scratch, { recursive: true, force: true });
    await hosted.execute('file_write', { path: 'docs/guide.md', content: '# guide' }, opts);
    expect(fs.readFileSync(path.join(dir, 'docs/guide.md'), 'utf8')).toBe('# guide');
  });

  it('a large result is cut, and the cut is said', async () => {
    const w = await world();
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_RESULT_CHARS + 5000));
    await machine(w, dir);
    const { tool } = await runWorkspace(w);
    const out = await tool('file_read')({ path: 'big.txt' });
    expect(out.length).toBeLessThan(MAX_RESULT_CHARS + 500);
    expect(out).toMatch(/output cut/);
  });
});

describe('Codex on 596e50e', () => {
  it('a command can\'t read a local-only file: with the process jail off, commands are refused for the cloud run', async () => {
    const w = await world();
    const dir = folder();
    fs.mkdirSync(path.join(dir, 'secret'));
    fs.writeFileSync(path.join(dir, 'secret', 'keys.txt'), 'sk-live-123');
    const privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: dir });
    await machine(w, dir, { privacy, ask: async () => true });
    const { tool } = await runWorkspace(w);
    const out = await tool('shell')({ command: 'cat secret/keys.txt' }).then((o) => o, (e: Error) => e.message);
    expect(out).not.toContain('sk-live-123');
    expect(out).toMatch(/local-only files.*process jail off/);
  });

  it('the folder\'s privacy rules reach the registry\'s process jail, which hides local-only paths from commands', async () => {
    const privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }]);
    const given: unknown[] = [];
    const registry = {
      getWorkspaceRoot: () => '/w', getToolDefinitions: () => [],
      execute: async () => 'ran',
      setPrivacyPaths: (p: unknown) => { given.push(p); },
      processJailMode: () => 'auto',
    };
    const ex = createWorkspaceExecutor({ registry, tools: ['shell'], ask: async () => true, privacy: () => privacy, checkpoints: { begin: async () => ({ n: 1 }), end: async () => undefined } });
    expect(await ex.run('shell', { command: 'ls' }, { signal: new AbortController().signal })).toEqual({ ok: true, output: 'ran' });
    expect(given).toEqual([privacy]);
  });

  it('a write the checkpoint doesn\'t record is asked about, since undo couldn\'t put it back', async () => {
    const w = await world();
    const dir = folder();
    let covered = false;
    const m = await machine(w, dir, { checkpoints: { begin: async () => ({ n: 1 }), end: async () => undefined, covers: async () => covered } });
    const { tool } = await runWorkspace(w);
    await expect(tool('file_write')({ path: 'data.db', content: 'x' })).rejects.toThrow(/Declined on the machine: file_write changes data\.db in the project, a file the checkpoint doesn't record/);
    expect(fs.existsSync(path.join(dir, 'data.db'))).toBe(false);
    covered = true;
    await tool('file_write')({ path: 'data.db', content: 'x' });
    expect(m.questions).toHaveLength(1);
  });

  it('an error never names the folder\'s path', async () => {
    const w = await world();
    const dir = folder();
    await machine(w, dir);
    const { tool } = await runWorkspace(w);
    const err = await tool('file_read')({ path: 'missing.txt' }).then(() => '', (e: Error) => e.message);
    expect(err).toMatch(/missing\.txt/);
    expect(err).not.toContain(dir);
    expect(err).not.toContain(fs.realpathSync(dir));
  });

  it('cancelling a call whose question is still open frees its slot', async () => {
    const w = await world();
    const dir = folder();
    await machine(w, dir, { ask: () => new Promise(() => {}) });
    const { tool } = await runWorkspace(w);
    for (let i = 0; i < MAX_IN_FLIGHT; i++) {
      const ac = new AbortController();
      const call = tool('file_delete')({ path: 'README.md' }, ac.signal);
      ac.abort();
      await expect(call).rejects.toThrow(/cancelled/);
    }
    // Every slot would be taken by a question nobody answers.
    await vi.waitFor(async () => expect(await tool('file_read')({ path: 'README.md' })).toContain('hello'));
  });

  it('the checkpoint closes after a call still running when the session ends', async () => {
    const w = await world();
    const id = w.register('user-1', 'dev-1');
    const events: string[] = [];
    let release!: () => void;
    const client = connectWorkspaceDevice({
      controlUrl: `${w.base}/control`, runUrl: `${w.base}/run`, device: id, serverId: w.server.id, serverKey: w.server.publicKey,
      askUser: async () => ({ tools: ['file_write'], label: 'p' }),
      open: async () => ({
        definitions: () => [{ name: 'file_write', description: 'Write a file', inputSchema: {} }],
        run: () => new Promise((resolve) => { release = () => { events.push('write landed'); resolve({ ok: true, output: 'ok' }); }; }),
        finish: async () => { events.push('checkpoint closed'); },
      }),
    });
    closers.push(() => client.close());
    await client.ready;
    await vi.waitFor(() => expect(w.hub.deviceOnline('user-1', 'dev-1')).toBe(true));
    const { tool } = await runWorkspace(w);
    void tool('file_write')({ path: 'a', content: 'b' }).catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    client.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);
    release();
    await vi.waitFor(() => expect(events).toEqual(['write landed', 'checkpoint closed']));
  });
});

describe('Codex on 9225441', () => {
  it('the session ends when the approval this machine signed does, whatever the grant says', async () => {
    const w = await world();
    const dir = folder();
    const id = w.register('user-1', 'dev-1');
    const client = connectWorkspaceDevice({
      controlUrl: `${w.base}/control`, runUrl: `${w.base}/run`, device: id, serverId: w.server.id, serverKey: w.server.publicKey,
      approvalTtlMs: 800,
      askUser: async () => ({ tools: ['file_read'], label: 'p' }),
      open: async (consent) => createWorkspaceExecutor({ registry: registryFor(dir), tools: consent.tools, ask: async () => false }),
    });
    closers.push(() => client.close());
    await client.ready;
    await vi.waitFor(() => expect(w.hub.deviceOnline('user-1', 'dev-1')).toBe(true));
    const { ws, tool } = await runWorkspace(w);
    expect(await tool('file_read')({ path: 'README.md' })).toContain('hello');
    // The grant is good for thirty minutes; the approval for less than a second.
    expect(await ws.closed).toMatch(/closed/);
    await expect(tool('file_read')({ path: 'README.md' })).rejects.toThrow(/no longer available/);
  });

  it('an unreadable privacy record refuses the call instead of throwing', async () => {
    const dir = folder();
    const broken = { hasPolicies: () => { throw new Error('the privacy record is unreadable'); }, coversFile: () => true } as unknown as PrivacyPaths;
    const ex = createWorkspaceExecutor({ registry: registryFor(dir), tools: ['shell'], ask: async () => true, privacy: () => broken });
    const out = await ex.run('shell', { command: 'ls' }, { signal: new AbortController().signal });
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/shell was not run: the privacy record is unreadable/);
  });
});

describe('Codex on b12fe3d', () => {
  it('a dropped connection reports closed only once the session is over, so a reconnect can\'t start another run first', async () => {
    const w = await world();
    const id = w.register('user-1', 'dev-1');
    const events: string[] = [];
    let release!: () => void;
    const client = connectWorkspaceDevice({
      controlUrl: `${w.base}/control`, runUrl: `${w.base}/run`, device: id, serverId: w.server.id, serverKey: w.server.publicKey,
      askUser: async () => ({ tools: ['file_write'], label: 'p' }),
      open: async () => ({
        definitions: () => [{ name: 'file_write', description: 'Write a file', inputSchema: {} }],
        run: () => new Promise((resolve) => { release = () => { events.push('write landed'); resolve({ ok: true, output: 'ok' }); }; }),
        finish: async () => { events.push('checkpoint closed'); },
      }),
    });
    closers.push(() => client.close());
    await client.ready;
    await vi.waitFor(() => expect(w.hub.deviceOnline('user-1', 'dev-1')).toBe(true));
    const { tool } = await runWorkspace(w);
    void tool('file_write')({ path: 'a', content: 'b' }).catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    let closed = false;
    void client.closed.then(() => { closed = true; events.push('client closed'); });
    w.hub.dropDevice('dev-1', 'the connection dropped');
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(false);
    release();
    await vi.waitFor(() => expect(events).toEqual(['write landed', 'checkpoint closed', 'client closed']));
  });
});

describe('a workspace approval is its own: never a browser one, nor the reverse', () => {
  it('signs under its own domains', () => {
    const server = createIdentity('server');
    const device = createIdentity('dev-1');
    const store = createMemoryNonceStore(Date.now);
    const run = { userId: 'u', deviceId: 'dev-1', runId: 'r' };
    // A browser grant is not a workspace grant, and the reverse.
    const browserGrant = issueGrant(server, { ...run, ttlMs: 60_000, now: Date.now() });
    const workspaceGrant = issueGrant(server, { ...run, ttlMs: 60_000, now: Date.now() }, WORKSPACE_FAMILY);
    const expect_ = { serverId: server.id, deviceId: 'dev-1' };
    expect(verifyGrant(browserGrant, server.publicKey, expect_, Date.now(), WORKSPACE_FAMILY).ok).toBe(false);
    expect(verifyGrant(workspaceGrant, server.publicKey, expect_, Date.now(), BROWSER_FAMILY).ok).toBe(false);
    expect(verifyGrant(workspaceGrant, server.publicKey, expect_, Date.now(), WORKSPACE_FAMILY).ok).toBe(true);
    // A device can't approve a workspace grant as a browser one.
    const browserApprovals = createDeviceApprovals({ device, serverId: server.id, serverKey: server.publicKey, now: Date.now });
    expect(browserApprovals.approve(workspaceGrant, { tabTargetId: 't', allowedOrigins: [], privateOrigins: [] }, 60_000)).toMatchObject({ refused: 'bad grant signature' });
    // A workspace approval claims only at a workspace hub.
    const approvals = createDeviceApprovals({ device, serverId: server.id, serverKey: server.publicKey, now: Date.now, family: WORKSPACE_FAMILY });
    const approval = approvals.approve(workspaceGrant, { tools: ['file_read'] }, 60_000);
    if ('refused' in approval) throw new Error(approval.refused);
    expect(approval.payload.tools).toEqual(['file_read']);
    const claim = (family?: typeof WORKSPACE_FAMILY) => claimAtServer({
      server, store, grant: workspaceGrant, approval, now: Date.now(), deviceKey: () => device.publicKey,
      issued: () => run, ...(family ? { family } : {}),
    });
    return Promise.all([claim(), claim(WORKSPACE_FAMILY)]).then(([asBrowser, asWorkspace]) => {
      expect(asBrowser).toMatchObject({ outcome: 'refused' });
      expect(asWorkspace).toEqual({ outcome: 'claimed' });
    });
  });
});

describe('the machine tells each worker which files it read have changed', () => {
  /** A tool as a given worker (tier) calls it. */
  const as = (ws: Awaited<ReturnType<typeof runWorkspace>>['ws'], worker: string) => (name: string, input: Record<string, unknown>) =>
    ws.tools.find((t) => t.name === name)!.execute(input, { tierId: worker, sessionId: 's', requireApproval: false });
  const NOTE = /Files in the workspace changed since you read them: (.*) — read them again before relying on them\./;

  it('reports a file the worker read and something changed, on its next call, and only once', async () => {
    const w = await world();
    const dir = folder();
    await machine(w, dir);
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    expect(await a('file_read', { path: 'README.md' })).not.toMatch(NOTE);
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
    fs.writeFileSync(path.join(dir, 'README.md'), 'someone edited this on the machine\n');
    const next = await a('file_list', { path: '.' });
    expect(next.match(NOTE)?.[1]).toBe('README.md');
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
    // Gone is a change too, and reported once.
    await a('file_read', { path: 'README.md' });
    fs.rmSync(path.join(dir, 'README.md'));
    expect((await a('file_list', { path: '.' })).match(NOTE)?.[1]).toBe('README.md');
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
  });

  it("keeps each worker's reads to itself, and a worker's own write is no news to it", async () => {
    const w = await world();
    const dir = folder();
    await machine(w, dir, { ask: async () => true, checkpoints: { begin: async () => ({ n: 1 }), end: async () => undefined } });
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    const b = as(ws, 'worker-b');
    await a('file_read', { path: 'README.md' });
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed by the user\n');
    expect(await b('file_list', { path: '.' })).not.toMatch(NOTE);
    expect(await a('file_list', { path: '.' })).toMatch(NOTE);
    // A's own write of a file it read does not come back to it.
    await a('file_read', { path: 'README.md' });
    await a('file_write', { path: 'README.md', content: 'written by a, longer than before\n' });
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
  });

  it('never names a local-only file, even one read before it became local-only', async () => {
    const w = await world();
    const dir = folder();
    fs.mkdirSync(path.join(dir, 'secret'));
    fs.writeFileSync(path.join(dir, 'secret', 'keys.txt'), 'sk-live-123');
    const setup: DeviceSetup = {};
    await machine(w, dir, setup);
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    await a('file_read', { path: 'secret/keys.txt' });
    setup.privacy = new PrivacyPaths([{ pattern: 'secret/**', policy: 'local-only' }], { workspaceRoot: dir });
    fs.writeFileSync(path.join(dir, 'secret', 'keys.txt'), 'sk-live-456-changed');
    const out = await a('file_list', { path: '.' });
    expect(out).not.toMatch(NOTE);
    expect(out).not.toContain('Files in the workspace changed');
    // A read the policy refuses is never recorded.
    await expect(a('file_read', { path: 'secret/keys.txt' })).rejects.toThrow(/local-only/);
    fs.writeFileSync(path.join(dir, 'secret', 'keys.txt'), 'again, different');
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
  });

  it('sends only what a run may be shown: relative paths, capped in number and length', () => {
    const many = Array.from({ length: MAX_CHANGED + 20 }, (_, i) => `src/f${i}.ts`);
    const f = readDeviceFrame(JSON.stringify({ v: 1, t: 'result', id: 'c1', ok: true, output: 'x', changed: [...many, '/etc/passwd', '../x', 'C:\\x', 'a'.repeat(513), 'bad\nname', 7] }));
    expect(f).toMatchObject({ t: 'result', ok: true });
    const changed = (f as { changed: string[] }).changed;
    expect(changed).toHaveLength(MAX_CHANGED);
    expect(changed.every((p) => !p.startsWith('/') && !p.includes('..'))).toBe(true);
    const odd = readDeviceFrame(JSON.stringify({ v: 1, t: 'result', id: 'c1', ok: true, output: 'x', changed: ['/etc/passwd', '..', 'a'.repeat(513)] }));
    expect(odd).not.toHaveProperty('changed');
    // The worker id is an id or the call is not one.
    expect(readServerFrame(JSON.stringify({ v: 1, t: 'call', id: 'c1', tool: 'file_read', input: {}, worker: 'w-1' }))).toMatchObject({ worker: 'w-1' });
    expect(readServerFrame(JSON.stringify({ v: 1, t: 'call', id: 'c1', tool: 'file_read', input: {}, worker: 'a'.repeat(65) }))).toBeNull();
    expect(readServerFrame(JSON.stringify({ v: 1, t: 'call', id: 'c1', tool: 'file_read', input: {}, worker: '../x' }))).toBeNull();
  });

  it('caps the files it reports on the machine, and the note reaches the tool output', async () => {
    const w = await world();
    const dir = folder();
    await machine(w, dir);
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    const N = MAX_CHANGED + 10;
    for (let i = 0; i < N; i++) { fs.writeFileSync(path.join(dir, `f${i}.txt`), 'one'); await a('file_read', { path: `f${i}.txt` }); }
    for (let i = 0; i < N; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'changed, longer');
    const out = await a('file_list', { path: '.' });
    const listed = out.match(NOTE)![1]!.split(', ');
    expect(listed).toHaveLength(MAX_CHANGED);
    expect(listed.every((p) => /^f\d+\.txt$/.test(p))).toBe(true);
    expect(out).not.toContain(dir);
    // The ones over the cap are not dropped: the next call reports them, and then none.
    const rest = (await a('file_list', { path: '.' })).match(NOTE)![1]!.split(', ');
    expect(rest).toHaveLength(N - MAX_CHANGED);
    expect(new Set([...listed, ...rest]).size).toBe(N);
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
  });

  it("its partial edit of a file someone else changed since it read it still brings the note", async () => {
    const w = await world();
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'notes.md'), 'one\ntwo\n');
    await machine(w, dir, { answer: { tools: ['file_read', 'file_edit', 'file_list'], label: 'p' }, ask: async () => true, checkpoints: { begin: async () => ({ n: 1 }), end: async () => undefined } });
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    await a('file_read', { path: 'notes.md' });
    fs.writeFileSync(path.join(dir, 'notes.md'), 'one\ntwo, changed by the user\n');
    expect((await a('file_edit', { path: 'notes.md', old_string: 'one', new_string: 'ONE' })).match(NOTE)?.[1]).toBe('notes.md');
    // Reported once; its own edit of a current copy brings nothing.
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
    await a('file_read', { path: 'notes.md' });
    expect(await a('file_edit', { path: 'notes.md', old_string: 'ONE', new_string: 'One' })).not.toMatch(NOTE);
  });

  it('a read of part of a file it read is no refresh of the rest: a change elsewhere still reaches it', async () => {
    const w = await world();
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'notes.md'), 'one\ntwo\nthree\n');
    await machine(w, dir, { answer: { tools: ['file_read', 'file_list'], label: 'p' } });
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    await a('file_read', { path: 'notes.md' });
    fs.writeFileSync(path.join(dir, 'notes.md'), 'one\ntwo\nthree, changed by the user\n');
    expect((await a('file_read', { path: 'notes.md', offset: 1, limit: 1 })).match(NOTE)?.[1]).toBe('notes.md');
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
  });

  it('a whole read the result cap cut short is no refresh either: a change past the cut still reaches it', async () => {
    const w = await world();
    const dir = folder();
    const big = path.join(dir, 'big.log');
    fs.writeFileSync(big, 'line\n'.repeat(80_000));
    await machine(w, dir, { answer: { tools: ['file_read', 'file_list'], label: 'p' } });
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    await a('file_read', { path: 'big.log' });
    fs.appendFileSync(big, 'a new line far past the cut\n');
    // Read whole again, but sent cut: the change is still news.
    expect((await a('file_read', { path: 'big.log' })).match(NOTE)?.[1]).toBe('big.log');
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
  });

  it("a whole read longer than the worker's context keeps is no refresh: a change in the middle still reaches it", async () => {
    const w = await world();
    const dir = folder();
    const mid = path.join(dir, 'mid.txt');
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    fs.writeFileSync(mid, lines.join('\n'));
    await machine(w, dir, { answer: { tools: ['file_read', 'file_list'], label: 'p' } });
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    await a('file_read', { path: 'mid.txt' });
    lines[1000] = 'line 1000, changed by the user';
    fs.writeFileSync(mid, lines.join('\n'));
    // Sent whole, but the worker's context keeps only its head and tail: still news.
    expect((await a('file_read', { path: 'mid.txt' })).match(NOTE)?.[1]).toBe('mid.txt');
    expect(await a('file_list', { path: '.' })).not.toMatch(NOTE);
  });

  it('a listing or a search naming a file it read is no change of its own: a later edit still reaches it', async () => {
    const w = await world();
    const dir = folder();
    await machine(w, dir, { answer: { tools: ['file_read', 'file_list', 'grep'], label: 'p' } });
    const { ws } = await runWorkspace(w);
    const a = as(ws, 'worker-a');
    await a('file_read', { path: 'README.md' });
    await a('grep', { pattern: 'x', path: 'README.md' });
    fs.writeFileSync(path.join(dir, 'README.md'), 'edited on the machine after the search\n');
    expect((await a('file_list', { path: '.' })).match(NOTE)?.[1]).toBe('README.md');
  });
});
