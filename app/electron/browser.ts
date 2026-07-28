// ─────────────────────────────────────────────
//  Cascade Desktop — Built-in browser
// ─────────────────────────────────────────────
//
// A real browser inside the app, so looking something up doesn't mean leaving
// Cascade and losing the thread of a run. It works in both directions: the
// user browses, AND the agent can read the page they are on (`read_current_page`,
// wired in main.ts) — which is why this isn't just "open the system browser".
//
// A WebContentsView, not an <iframe> or <webview>. An iframe is blocked outright
// by X-Frame-Options / frame-ancestors on most real sites — GitHub, Google,
// almost anything worth looking up — so the panel would be permanently blank
// on the pages people actually want. A WebContentsView is a genuine browser
// view with its own process, subject to none of that.
//
// It is a NATIVE overlay: it sits on top of the renderer at bounds the renderer
// dictates, rather than inside the React tree. So the renderer draws the chrome
// (address bar, buttons) and tells us where the page rectangle is; hiding the
// view is the panel's job on every view switch, or the page would float above
// whatever the user navigated to next.

import { WebContentsView, ipcMain, shell, session, type BrowserWindow } from 'electron';
import { normalizeUrl, toNavigable } from './url.js';

// A partition dedicated to the built-in browser, so its permission policy
// (below) applies only to pages the user navigates to here — never to the
// app's own renderer, which uses the default session.
const BROWSER_PARTITION = 'persist:cascade-browser';

/**
 * Deny every web permission by default.
 *
 * `sandbox` and process isolation stop a page from reaching Node or the app's
 * IPC surface, but they do nothing about Chromium's own permission prompts —
 * camera, microphone, geolocation, notifications, HID, USB. Electron grants
 * those unless the app installs a handler; with none installed anywhere in
 * this codebase, an arbitrary or compromised site the user visits here could
 * request them with no application-level policy standing in the way. None of
 * that is needed for reading web pages, so the policy is simply: deny.
 */
function hardenBrowserSession(): void {
  const s = session.fromPartition(BROWSER_PARTITION);
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
}

/** Where the renderer wants the page drawn, in renderer CSS pixels. */
interface Bounds { x: number; y: number; width: number; height: number }

const HOME_URL = 'https://duckduckgo.com/';

/** Page text handed back in one read. Beyond this the model gains nothing and
 *  the tokens cost real money; the SDK tool truncates again on its own side. */
const MAX_TEXT_CHARS = 200_000;

let view: WebContentsView | null = null;
let owner: BrowserWindow | null = null;
let visible = false;
let lastBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
/** The current main-frame navigation error, if any. See did-fail-load below
 *  for why this survives the did-stop-loading that always follows it. */
let lastError: string | undefined;

function ensureView(win: BrowserWindow): WebContentsView {
  if (view && !view.webContents.isDestroyed()) {
    // On macOS, closing the last window leaves the app running and does NOT
    // destroy a child WebContentsView. `app.on('activate')` then builds a NEW
    // BrowserWindow, and returning early with the stale `owner` left every
    // applyBounds() and state push bailing on `owner.isDestroyed()` — the
    // reopened Browser tab was invisible and inert. Re-adopt the new window.
    if (owner !== win) {
      if (owner && !owner.isDestroyed() && owner.contentView.children.includes(view)) {
        owner.contentView.removeChildView(view);
      }
      owner = win;
    }
    return view;
  }

  hardenBrowserSession();
  view = new WebContentsView({
    webPreferences: {
      // No preload, no node: this renders untrusted web content and must have
      // no path to the app's IPC surface.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: BROWSER_PARTITION,
    },
  });
  owner = win;

  const wc = view.webContents;

  // window.open / target=_blank goes to the system browser rather than
  // spawning unmanaged windows we would then have to track and clean up.
  wc.setWindowOpenHandler(({ url }) => {
    const safe = normalizeUrl(url);
    if (safe) void shell.openExternal(safe);
    return { action: 'deny' };
  });

  const pushState = () => {
    if (!owner || owner.isDestroyed()) return;
    owner.webContents.send('browser:state', getState());
  };
  // A successful or freshly-started navigation retires the old error — this
  // is the only place lastError is cleared, so did-stop-loading (below) can't
  // wipe it out from underneath a failure it didn't cause.
  wc.on('did-navigate', () => { lastError = undefined; pushState(); });
  wc.on('did-start-loading', () => { lastError = undefined; pushState(); });
  wc.on('did-navigate-in-page', pushState);
  wc.on('page-title-updated', pushState);
  // Electron always follows a failed navigation with did-stop-loading. That
  // handler calls the SAME pushState, which re-sends whatever lastError is
  // currently set to — so a DNS/TLS/connectivity failure set by did-fail-load
  // survives it instead of being overwritten by a state with no error field a
  // moment later, which is what silently blanked the failure message before.
  wc.on('did-stop-loading', pushState);
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires on every ordinary redirect and on stop.
    // A subframe (ad/tracker/embed) failing is not the page the user is on.
    if (code === -3 || !isMainFrame) return;
    if (!owner || owner.isDestroyed()) return;
    lastError = `${desc} (${url})`;
    pushState();
  });

  return view;
}

function getState() {
  if (!view || view.webContents.isDestroyed()) {
    return { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
  }
  const wc = view.webContents;
  return {
    open: visible,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    // The single source of truth for the current failure, so every caller of
    // getState() — the event pushes below, the open/state IPC handlers — sees
    // the same thing rather than each having to remember to attach it.
    error: lastError,
  };
}

function applyBounds(): void {
  if (!view || !owner || owner.isDestroyed()) return;
  // Collapsed to zero rather than removed when hidden: keeping the view
  // attached preserves the page, its scroll position and any login, so
  // switching to Chat and back does not silently reload what the user was on.
  view.setBounds(visible ? lastBounds : { x: 0, y: 0, width: 0, height: 0 });
}

/**
 * Read the page currently on screen — the agent half of the feature.
 *
 * `innerText` rather than the HTML: the model wants what a person can read, and
 * the markup would be mostly script and style tags burning tokens. Returns null
 * when nothing is open, so the tool can say so instead of inventing content.
 */
export async function readCurrentPage(): Promise<{ url: string; title: string; text: string } | null> {
  if (!view || view.webContents.isDestroyed()) return null;
  const wc = view.webContents;
  const url = wc.getURL();
  if (!url || url === 'about:blank') return null;

  const text = await wc.executeJavaScript(
    `(() => {
       const el = document.body;
       if (!el) return '';
       return (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_TEXT_CHARS});
     })()`,
    true,
  ).catch(() => '');

  return { url, title: wc.getTitle(), text: typeof text === 'string' ? text : '' };
}

export function registerBrowserHandlers(getWindow: () => BrowserWindow | null): void {
  const win = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w : null;
  };

  ipcMain.handle('browser:open', (_e, arg: unknown) => {
    const w = win();
    if (!w) return { ok: false, error: 'No window.' };
    const a = (arg ?? {}) as { url?: string; bounds?: Bounds };
    const v = ensureView(w);
    if (!w.contentView.children.includes(v)) w.contentView.addChildView(v);
    visible = true;
    if (a.bounds) lastBounds = a.bounds;
    applyBounds();
    if (!v.webContents.getURL()) {
      void v.webContents.loadURL(toNavigable(a.url ?? '') ?? HOME_URL);
    } else if (a.url) {
      const target = toNavigable(a.url);
      if (target) void v.webContents.loadURL(target);
    }
    return { ok: true, state: getState() };
  });

  // Hide, don't destroy: the page (and any session the user signed into)
  // survives a trip to another view.
  ipcMain.handle('browser:hide', () => {
    visible = false;
    applyBounds();
    return { ok: true };
  });

  ipcMain.handle('browser:close', () => {
    visible = false;
    if (view && owner && !owner.isDestroyed() && owner.contentView.children.includes(view)) {
      owner.contentView.removeChildView(view);
    }
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    view = null;
    return { ok: true };
  });

  ipcMain.handle('browser:setBounds', (_e, b: unknown) => {
    const bounds = b as Bounds;
    if (!bounds || typeof bounds.width !== 'number') return { ok: false };
    lastBounds = {
      x: Math.round(bounds.x), y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)),
    };
    applyBounds();
    return { ok: true };
  });

  ipcMain.handle('browser:navigate', (_e, url: unknown) => {
    if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'Browser is not open.' };
    const target = toNavigable(String(url ?? ''));
    if (!target) return { ok: false, error: 'Only http and https addresses can be opened here.' };
    void view.webContents.loadURL(target);
    return { ok: true };
  });

  ipcMain.handle('browser:back', () => {
    if (view && !view.webContents.isDestroyed() && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  });

  ipcMain.handle('browser:forward', () => {
    if (view && !view.webContents.isDestroyed() && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  });

  ipcMain.handle('browser:reload', () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle('browser:stop', () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.stop();
    return { ok: true };
  });

  ipcMain.handle('browser:state', () => getState());

  // The page the user is on, for the renderer (Settings/debug) — the agent
  // reaches the same function directly through the SDK tool.
  ipcMain.handle('browser:readPage', async () => (await readCurrentPage()) ?? null);

  ipcMain.handle('browser:openExternal', (_e, url: unknown) => {
    const safe = normalizeUrl(String(url ?? ''));
    if (!safe) return { ok: false };
    void shell.openExternal(safe);
    return { ok: true };
  });
}
