// ─────────────────────────────────────────────
//  Cascade Desktop — this app as one of the user's devices (relay source A)
// ─────────────────────────────────────────────
//
// A run on Cascade Cloud can use a browser in this app, as it can the CLI's or the
// extension's: the user approves it here, naming the sites it may open, and the run
// drives one window of its own through the relay.
//
// Each run gets a FRESH in-memory session, never the app's built-in browser profile:
// an empty profile like the CLI's, closed and wiped with the run. That is what lets the
// desktop enforce everything the CLI does, in Electron's main process, out of the
// agent's reach:
//
//  - Every request of the session, workers included, goes through the SDK's egress
//    proxy: a name is resolved once, a private address is refused unless that exact
//    origin was consented, and the address checked is the one dialled.
//  - Documents (any frame, any initiator, every redirect hop) load only from consented
//    origins; any file: request, and documents of other schemes, are refused
//    (`requestVerdict`, the CLI's own rule) before they are sent.
//  - Downloads are cancelled. Pop-ups are denied. Dialogs are dismissed. Permissions
//    are refused. WebRTC sends no UDP past the proxy.
//  - The main frame showing another site, the window closing or the debugger
//    detaching ends the run, and nothing reattaches without a new approval.

import { randomUUID } from 'node:crypto';

// ── What this module needs from the SDK bundle and from Electron ──

export interface RelayCdpClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  on(fn: (msg: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void): void;
  onClose(fn: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export interface Consent { readonly origins: ReadonlySet<string>; readonly privateOrigins: ReadonlySet<string> }
export interface UserConsent { allowedOrigins: string[]; privateOrigins: string[]; anyPublic?: boolean }

export interface RelayCore {
  startEgressProxy(opts: { consent: Consent }): Promise<{
    port: number; canaryUrl(): string; canarySeen(url: string): boolean; open(): void; shut(): void;
    onClose(fn: () => void): void; close(): Promise<void>;
  }>;
  requestVerdict(url: string, resourceType: string, consent: Consent): { allow: boolean; reason?: string };
  onConsentedSite(url: string, consent: Consent): boolean;
  settlesWithin(call: Promise<unknown>, ms: number): Promise<boolean>;
}

/** Electron's `webContents.debugger`, the slice used. */
export interface ElectronDebugger {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(event: 'message', fn: (event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void): unknown;
  on(event: 'detach', fn: (event: unknown, reason: string) => void): unknown;
  removeListener(event: string, fn: (...args: never[]) => void): unknown;
}

export interface RunSession {
  setProxy(config: { proxyRules: string; proxyBypassRules?: string }): Promise<void>;
  fetch(url: string): Promise<unknown>;
  webRequest: { onBeforeRequest(listener: ((details: { url: string; resourceType: string }, callback: (r: { cancel?: boolean }) => void) => void) | null): void };
  setPermissionRequestHandler(handler: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | null): void;
  setPermissionCheckHandler(handler: (() => boolean) | null): void;
  on(event: 'will-download', fn: (event: { preventDefault(): void }, item: { cancel(): void; getURL(): string }) => void): unknown;
  clearStorageData(): Promise<void>;
}

export interface RunWindow {
  readonly webContents: {
    readonly debugger: ElectronDebugger;
    loadURL(url: string): Promise<void>;
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
    setWebRTCIPHandlingPolicy(policy: string): void;
    isDestroyed(): boolean;
  };
  on(event: 'closed', fn: () => void): unknown;
  isDestroyed(): boolean;
  destroy(): void;
  focus(): void;
}

export interface ElectronDeps {
  sessionFromPartition(partition: string): RunSession;
  /** A new, visible window on that partition, sandboxed, with no preload. */
  createWindow(partition: string): RunWindow;
}

// ── CDP over webContents.debugger ──

/**
 * The run window's debugger as a CDP client. Several share the one attachment (the
 * policy's and the relay's): each sees every event, and closing one only stops it.
 */
export function debuggerCdp(dbg: ElectronDebugger): RelayCdpClient {
  let closed = false;
  const listeners: ((m: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void)[] = [];
  const closers: (() => void)[] = [];
  const onMessage = (_e: unknown, method: string, params: Record<string, unknown>, sessionId?: string): void => {
    if (closed) return;
    for (const l of listeners) l({ method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
  };
  const shut = (): void => {
    if (closed) return;
    closed = true;
    dbg.removeListener('message', onMessage as never);
    dbg.removeListener('detach', onDetach as never);
    for (const c of closers) c();
  };
  const onDetach = (): void => shut();
  dbg.on('message', onMessage);
  dbg.on('detach', onDetach);
  return {
    get closed() { return closed; },
    async send(method, params = {}, sessionId) {
      if (closed) throw new Error('CDP connection closed');
      return ((await dbg.sendCommand(method, params, sessionId)) ?? {}) as Record<string, unknown>;
    },
    on(fn) { listeners.push(fn); },
    onClose(fn) { closers.push(fn); },
    close: shut,
  };
}

// ── The run's request rules ──

/** Electron's resource types, as the SDK's request rules name them. */
export function ruleType(resourceType: string): string {
  if (resourceType === 'mainFrame' || resourceType === 'subFrame') return 'Document';
  if (resourceType === 'webSocket') return 'WebSocket';
  return resourceType;
}

/**
 * The run session's rules: what loads, what's asked, what's saved. Returns what it did,
 * for the log and the tests.
 */
export function policeSession(session: RunSession, consent: Consent, core: Pick<RelayCore, 'requestVerdict'>, onDownload: (url: string) => void) {
  const refused: string[] = [];
  session.webRequest.onBeforeRequest((details, callback) => {
    const verdict = core.requestVerdict(details.url, ruleType(details.resourceType), consent);
    if (!verdict.allow) refused.push(`${details.resourceType} ${verdict.reason ?? ''}`.trim());
    callback({ cancel: !verdict.allow });
  });
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  // Nothing a run's page offers is saved: the session is the run's alone, so every
  // download in it is the run's, and cancelling it touches nothing of the user's.
  session.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
    onDownload(item.getURL());
  });
  return { refused };
}

// ── A run's window ──

const PAGE_END_TIMEOUT_MS = 5000;

export interface RunBrowser {
  tabWs: string;
  tabTargetId: string;
  connectTab: () => Promise<RelayCdpClient>;
  enforcer: {
    decisions: readonly unknown[]; closedPages: readonly string[]; children: readonly unknown[]; dismissedDialogs: readonly string[];
    checkTabBeforeLease(): Promise<{ ok: true } | { ok: false; reason: string }>;
    clearForeignHistory(): Promise<boolean>;
    onForeignDocument(l: () => void): void;
    onPolicyLost(l: () => void): void;
    endPageActivity(mode: 'close' | 'blank'): Promise<boolean>;
    close(): void;
  };
  pageEnd: 'close';
  onEgressDown(fn: () => void): void;
  /** Brings the run's window forward, for the user taking over. */
  focus(): void;
  close(): Promise<void>;
  /** For the log and the tests. */
  readonly refused: readonly string[];
  readonly cancelledDownloads: readonly string[];
}

/**
 * Opens a run's window on a fresh session behind the egress proxy, with every rule on
 * and the proxy proven in use before anything leaves. A failure at any step takes down
 * what came before it.
 */
export async function openRunBrowser(consent: Consent, core: RelayCore, electron: ElectronDeps): Promise<RunBrowser> {
  const proxy = await core.startEgressProxy({ consent });
  const partition = `cascade-run-${randomUUID()}`; // no "persist:": in memory, gone with the run
  const session = electron.sessionFromPartition(partition);
  const cancelledDownloads: string[] = [];
  const { refused } = policeSession(session, consent, core, (url) => cancelledDownloads.push(url));
  let win: RunWindow | null = null;
  let own: RelayCdpClient | null = null;
  const foreign: (() => void)[] = [];
  const lost: (() => void)[] = [];
  const dismissedDialogs: string[] = [];
  const closedPages: string[] = [];
  let closed = false;

  const teardown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { if (win && !win.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); } catch { /* gone */ }
    if (win && !win.isDestroyed()) win.destroy();
    session.webRequest.onBeforeRequest(null);
    await session.clearStorageData().catch(() => {});
    await proxy.close().catch(() => {});
  };

  try {
    await session.setProxy({ proxyRules: `http://127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>' });
    // Proven, not assumed: the session's own request reaches the proxy before egress opens.
    const canary = proxy.canaryUrl();
    await session.fetch(canary).catch(() => {});
    if (!proxy.canarySeen(canary)) throw new Error('The run\'s browser did not go through its proxy, so it was not opened.');
    proxy.open();

    win = electron.createWindow(partition);
    const wc = win.webContents;
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    wc.setWindowOpenHandler(() => { closedPages.push('a window the page opened'); return { action: 'deny' }; });
    await wc.loadURL('about:blank');
    wc.debugger.attach('1.3');
    own = debuggerCdp(wc.debugger);
    await own.send('Page.enable');
    const info = await own.send('Target.getTargetInfo') as { targetInfo?: { targetId?: string } };
    const tabTargetId = info.targetInfo?.targetId;
    if (!tabTargetId) throw new Error('The run\'s window did not say which target it is.');

    own.on((msg) => {
      if (msg.sessionId) return;
      if (msg.method === 'Page.frameNavigated') {
        const frame = (msg.params as { frame?: { parentId?: string; url?: string; unreachableUrl?: string } }).frame;
        if (!frame || frame.parentId || frame.unreachableUrl || frame.url === 'about:blank' || core.onConsentedSite(frame.url ?? '', consent)) return;
        for (const l of foreign) l();
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        dismissedDialogs.push(String((msg.params as { type?: unknown }).type ?? 'dialog'));
        void own!.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      }
    });
    // The debugger or the window going, for any reason: nothing is policed any more.
    own.onClose(() => { for (const l of lost) l(); });
    win.on('closed', () => { for (const l of lost) l(); });

    const shared = own;
    const window = win;
    return {
      tabWs: '', tabTargetId, pageEnd: 'close', refused, cancelledDownloads,
      connectTab: async () => debuggerCdp(window.webContents.debugger),
      onEgressDown: (fn) => proxy.onClose(fn),
      focus: () => { if (!window.isDestroyed()) window.focus(); },
      enforcer: {
        decisions: [], closedPages, children: [], dismissedDialogs,
        async checkTabBeforeLease() {
          const tree = await shared.send('Page.getFrameTree').catch(() => null) as { frameTree?: { frame?: { url?: string }; childFrames?: unknown[] } } | null;
          if (tree?.frameTree?.frame?.url !== 'about:blank' || tree.frameTree.childFrames?.length) return { ok: false, reason: 'the run window is not blank' };
          return { ok: true };
        },
        // A window opened for this run, on an empty session, has no history.
        clearForeignHistory: async () => true,
        onForeignDocument: (l) => { foreign.push(l); },
        onPolicyLost: (l) => { lost.push(l); },
        async endPageActivity(mode) {
          if (mode === 'blank') return core.settlesWithin(shared.send('Page.navigate', { url: 'about:blank' }), PAGE_END_TIMEOUT_MS);
          proxy.shut();
          if (!window.isDestroyed()) window.destroy();
          return true;
        },
        close() { void teardown(); },
      },
      close: teardown,
    };
  } catch (e) {
    await teardown();
    throw e;
  }
}
