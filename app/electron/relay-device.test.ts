// ─────────────────────────────────────────────
//  Cascade Desktop — a run's window, policed in the main process
// ─────────────────────────────────────────────
//
//  Electron is faked; the rules and the proxy are the SDK's own, so what is tested is
//  what ships: which requests the run session lets out, that nothing opens until the
//  proxy is proven in use, and how a run ends.

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConsent, onConsentedSite, requestVerdict } from '../../src/browser/relay/egress-rules.js';
import { startEgressProxy } from '../../src/browser/relay/egress-proxy.js';
import { settlesWithin } from '../../src/browser/relay/settles.js';
import { debuggerCdp, openRunBrowser, policeSession, ruleType, type ElectronDebugger, type RelayCore, type RunSession, type RunWindow } from './relay-device.js';

const core: RelayCore = { startEgressProxy, requestVerdict, onConsentedSite, settlesWithin } as unknown as RelayCore;
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

/** A session that records what the policy installed, and can be fed requests. */
function fakeSession(fetchVia?: (url: string, proxyPort: number) => Promise<void>) {
  let before: ((d: { url: string; resourceType: string }, cb: (r: { cancel?: boolean }) => void) => void) | null = null;
  let permission: ((wc: unknown, p: string, cb: (g: boolean) => void) => void) | null = null;
  let check: (() => boolean) | null = null;
  const downloads = new EventEmitter();
  let proxyPort = 0;
  const session: RunSession = {
    setProxy: async (c) => { proxyPort = Number(/:(\d+)$/.exec(c.proxyRules)![1]); },
    fetch: async (url) => { if (fetchVia) await fetchVia(url, proxyPort); },
    webRequest: { onBeforeRequest: (l) => { before = l; } },
    setPermissionRequestHandler: (h) => { permission = h; },
    setPermissionCheckHandler: (h) => { check = h; },
    on: (_e, fn) => downloads.on('will-download', fn),
    clearStorageData: vi.fn(async () => {}),
  };
  const request = (url: string, resourceType: string) => new Promise<boolean>((r) => before!({ url, resourceType }, (res) => r(!res.cancel)));
  const download = (url: string) => {
    const item = { cancel: vi.fn(), getURL: () => url };
    const event = { preventDefault: vi.fn() };
    downloads.emit('will-download', event, item);
    return { item, event };
  };
  return { session, request, download, asks: (p: string) => new Promise<boolean>((r) => permission!(null, p, r)), check: () => check!(), get installed() { return before !== null; } };
}

/** Plain http to the canary through the proxy, as the session's own request would be. */
const throughProxy = (url: string, port: number) => new Promise<void>((resolve) => {
  const u = new URL(url);
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: u.host } }, (res) => { res.resume(); res.on('end', () => resolve()); });
  req.on('error', () => resolve());
  req.end();
});

/** A debugger that answers the commands a run's window gets, and can emit events. */
function fakeDebugger(answers: Record<string, unknown> = {}) {
  const ee = new EventEmitter();
  const sent: Array<{ method: string; sessionId?: string }> = [];
  let attached = false;
  const dbg: ElectronDebugger & { emit(e: string, ...a: unknown[]): void } = {
    attach: () => { attached = true; },
    detach: () => { attached = false; ee.emit('detach', {}, 'target closed'); },
    isAttached: () => attached,
    sendCommand: async (method: string, _params?: object, sessionId?: string) => {
      sent.push({ method, ...(sessionId ? { sessionId } : {}) });
      return answers[method] ?? {};
    },
    on: ((event: string, fn: (...a: never[]) => void) => { ee.on(event, fn as (...a: unknown[]) => void); return dbg; }) as ElectronDebugger['on'],
    removeListener: (event: string, fn: (...a: never[]) => void) => { ee.removeListener(event, fn as (...a: unknown[]) => void); return dbg; },
    emit: (e: string, ...a: unknown[]) => { ee.emit(e, ...a); },
  };
  return { dbg, sent };
}

function fakeWindow(dbg: ElectronDebugger) {
  const ee = new EventEmitter();
  let destroyed = false;
  const opened: string[] = [];
  const win: RunWindow & { emit(e: string): void } = {
    webContents: {
      debugger: dbg,
      loadURL: async (u: string) => { opened.push(u); },
      setWindowOpenHandler: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
      isDestroyed: () => destroyed,
    },
    on: (e: string, fn: () => void) => ee.on(e, fn),
    isDestroyed: () => destroyed,
    destroy: () => { if (!destroyed) { destroyed = true; ee.emit('closed'); } },
    focus: vi.fn(),
    emit: (e: string) => { ee.emit(e); },
  };
  return { win, opened };
}

describe("the run session's rules", () => {
  const consent = makeConsent(['https://allowed.test'], ['http://localhost:3000']);

  it('documents load only from consented sites, in any frame; subresources from public sites do', async () => {
    const s = fakeSession();
    policeSession(s.session, consent, core, () => {});
    expect(await s.request('https://allowed.test/a', 'mainFrame')).toBe(true);
    expect(await s.request('https://elsewhere.test/', 'mainFrame')).toBe(false);
    expect(await s.request('https://elsewhere.test/frame', 'subFrame')).toBe(false);
    expect(await s.request('https://cdn.elsewhere.test/lib.js', 'script')).toBe(true);
    expect(ruleType('webSocket')).toBe('WebSocket');
  });

  it('file: and private addresses are refused, but for the private origin the user named', async () => {
    const s = fakeSession();
    policeSession(s.session, consent, core, () => {});
    expect(await s.request('file:///etc/passwd', 'other')).toBe(false);
    expect(await s.request('file:///etc/passwd', 'mainFrame')).toBe(false);
    expect(await s.request('http://192.168.1.1/admin', 'xhr')).toBe(false);
    expect(await s.request('http://127.0.0.1:9222/json', 'xhr')).toBe(false);
    expect(await s.request('http://localhost:3000/api', 'xhr')).toBe(true);
  });

  it('every download is cancelled, and every permission refused', async () => {
    const s = fakeSession();
    const seen: string[] = [];
    policeSession(s.session, consent, core, (u) => seen.push(u));
    const { item, event } = s.download('https://allowed.test/report.pdf');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(item.cancel).toHaveBeenCalled();
    expect(seen).toEqual(['https://allowed.test/report.pdf']);
    expect(await s.asks('geolocation')).toBe(false);
    expect(s.check()).toBe(false);
  });
});

describe("a run's window", () => {
  const consent = makeConsent(['https://allowed.test']);
  const answers = { 'Target.getTargetInfo': { targetInfo: { targetId: 'T1' } }, 'Page.getFrameTree': { frameTree: { frame: { url: 'about:blank' } } } };

  it('is not opened when the session does not go through its proxy, and nothing is left behind', async () => {
    const s = fakeSession(async () => { /* goes straight out: the proxy never sees it */ });
    const createWindow = vi.fn();
    await expect(openRunBrowser(consent, core, { sessionFromPartition: () => s.session, createWindow })).rejects.toThrow(/proxy/);
    expect(createWindow).not.toHaveBeenCalled();
    expect(s.session.clearStorageData).toHaveBeenCalled();
  });

  it('opens on a fresh in-memory session once the proxy is proven, blank, with pop-ups and UDP off', async () => {
    const s = fakeSession(throughProxy);
    const { dbg, sent } = fakeDebugger(answers);
    const { win, opened } = fakeWindow(dbg);
    const partitions: string[] = [];
    const run = await openRunBrowser(consent, core, {
      sessionFromPartition: (p) => { partitions.push(p); return s.session; },
      createWindow: (p) => { partitions.push(p); return win; },
    });
    closers.push(() => run.close());
    expect(partitions[0]).toMatch(/^cascade-run-[0-9a-f-]{36}$/);
    expect(partitions[1]).toBe(partitions[0]);
    expect(s.installed).toBe(true);
    expect(opened).toEqual(['about:blank']);
    expect(win.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    expect((win.webContents.setWindowOpenHandler as ReturnType<typeof vi.fn>).mock.calls[0]![0]()).toEqual({ action: 'deny' });
    expect(run.tabTargetId).toBe('T1');
    expect(await run.enforcer.checkTabBeforeLease()).toEqual({ ok: true });
    expect(sent.map((c) => c.method)).toEqual(expect.arrayContaining(['Page.enable', 'Target.getTargetInfo']));
  });

  it('dismisses dialogs; another site in the main frame, a detach or the window closing ends the run', async () => {
    const s = fakeSession(throughProxy);
    const { dbg, sent } = fakeDebugger(answers);
    const { win } = fakeWindow(dbg);
    const run = await openRunBrowser(consent, core, { sessionFromPartition: () => s.session, createWindow: () => win });
    closers.push(() => run.close());
    const foreign = vi.fn();
    const lost = vi.fn();
    run.enforcer.onForeignDocument(foreign);
    run.enforcer.onPolicyLost(lost);
    dbg.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert' });
    await vi.waitFor(() => expect(sent.map((c) => c.method)).toContain('Page.handleJavaScriptDialog'));
    // A frame, or the main frame on a consented site or an error page: the run goes on.
    dbg.emit('message', {}, 'Page.frameNavigated', { frame: { parentId: 'p', url: 'https://elsewhere.test/' } });
    dbg.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'https://allowed.test/x' } });
    dbg.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'chrome-error://chromewebdata/', unreachableUrl: 'https://elsewhere.test/' } });
    expect(foreign).not.toHaveBeenCalled();
    dbg.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'https://elsewhere.test/' } });
    expect(foreign).toHaveBeenCalledTimes(1);
    dbg.detach();
    expect(lost).toHaveBeenCalled();
  });

  it('ending the page closes the window and shuts the proxy; closing wipes the session', async () => {
    const s = fakeSession(throughProxy);
    const { dbg } = fakeDebugger(answers);
    const { win } = fakeWindow(dbg);
    const run = await openRunBrowser(consent, core, { sessionFromPartition: () => s.session, createWindow: () => win });
    expect(await run.enforcer.endPageActivity('close')).toBe(true);
    expect(win.isDestroyed()).toBe(true);
    await run.close();
    expect(s.session.clearStorageData).toHaveBeenCalled();
  });
});

describe('CDP over webContents.debugger', () => {
  it('sends with child sessions, passes events on with theirs, and closes on detach', async () => {
    const { dbg, sent } = fakeDebugger({ 'Runtime.evaluate': { result: { value: 2 } } });
    const cdp = debuggerCdp(dbg);
    expect(await cdp.send('Runtime.evaluate', { expression: '1+1' }, 'child-1')).toEqual({ result: { value: 2 } });
    expect(sent).toEqual([{ method: 'Runtime.evaluate', sessionId: 'child-1' }]);
    const got: unknown[] = [];
    cdp.on((m) => got.push(m));
    dbg.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 }, 'child-1');
    expect(got).toEqual([{ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'child-1' }]);
    const closed = vi.fn();
    cdp.onClose(closed);
    dbg.emit('detach', {}, 'target closed');
    expect(closed).toHaveBeenCalled();
    expect(cdp.closed).toBe(true);
    await expect(cdp.send('Page.enable')).rejects.toThrow(/closed/);
  });
});
