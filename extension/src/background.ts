// ─────────────────────────────────────────────
//  Cascade extension — the service worker
// ─────────────────────────────────────────────
//
//  Keeps this browser connected to the user's Cascade server as one of their devices,
//  and serves runs on it: each run is asked about in a window of its own, and gets a
//  new window with one tab, policed on the device (see tab-policy.ts).
//
//  Fail closed across the worker's life. A run never outlives the worker that started
//  it: when Chrome restarts the worker, whatever a previous one left (its windows, its
//  debugger attachments, its rules) is removed before anything else, and nothing is
//  reattached. A run needs a new approval to start again.

import { identityFromPrivateKey, publicKeyFromText } from '../../src/browser/relay/capability.js';
import { type DeviceClient, type RunHint, type UserConsent, connectDeviceClient } from '../../src/browser/relay/device.js';
import { type AnswerStore, type ConsentForm, consentFromForm, forgetAnswers, keepAnswer, keptCount, keptKey, recallAnswer } from './answers.js';
import { type PairedDevice, endpointsOf, pairWithServer } from './pairing.js';
import { RUN_RULE_IDS_FROM, openRunTab, releaseWebRtcAfterRestart } from './tab-policy.js';

// ── State ────────────────────────────────────

type Connection = 'unpaired' | 'connecting' | 'online' | 'offline' | 'refused';
interface RunInfo { runId: string; sites: string[]; windowId?: number; takenOver?: boolean }
interface Status {
  connection: Connection; device?: { name: string; server: string }; run?: RunInfo;
  pairing?: { userCode: string; verificationUri: string } | { error: string }; notice?: string;
  /** Answers kept for chats' later runs, still in date: the popup offers to forget them. */
  keptAnswers?: number;
}

const status: Status = { connection: 'unpaired' };
/** The device's own log, the last lines only. Never sent anywhere. */
const recent: string[] = [];
function note(line: string): void {
  recent.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (recent.length > 40) recent.shift();
  console.info(`[cascade relay] ${line}`);
}
// For DevTools on the service worker, and for the tests: what this worker is doing.
(globalThis as unknown as { cascade: object }).cascade = { status, recent };
let client: DeviceClient | null = null;
let connecting = false;
/** Bumped by Forget, so an attempt that read storage before it doesn't carry on. */
let connectEpoch = 0;
/** An attempt arrived while one was in flight: look again if that one ends with no client. */
let connectAgain = false;
let refusals = 0;
let backoffMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * When the next attempt is due (ms since epoch). The one-minute wake alarm and
 * a browser restart honour it, so they don't cut a backoff short. Lost with the
 * worker, which is fine: a worker that just started may try at once.
 */
let nextAttemptAt = 0;
/** After the server says it is restarting (a deploy), the first try waits this long. */
const RESTART_WAIT_MS = 8_000;

/** Whether Chrome reports a network at all. No network: no attempt, and no error in the log. */
const online = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

/** Try again in `ms`, unless an attempt is already due sooner. */
function retryIn(ms: number): void {
  clearTimeout(retryTimer);
  nextAttemptAt = Date.now() + ms;
  retryTimer = setTimeout(() => { void connect(); }, ms);
}
let nextRuleId = RUN_RULE_IDS_FROM;
/** The run the user approved last: the next browser started is its, in the window they chose. */
let approvedRun = '';
let approvedIncognito = true;

const answers: AnswerStore = {
  get: (key) => chrome.storage.session.get(key),
  set: (items) => chrome.storage.session.set(items),
};
async function refreshKept(): Promise<void> {
  status.keptAnswers = await keptCount(answers, Date.now()).catch(() => 0);
}

const KEEPALIVE_MS = 20_000;

async function loadDevice(): Promise<PairedDevice | null> {
  const { device } = await chrome.storage.local.get('device') as { device?: PairedDevice };
  return device?.deviceId && device.privateKeyPem ? device : null;
}

function publish(): void {
  // The always-visible indicator: on while a run is using this browser.
  void chrome.action.setBadgeText({ text: status.run ? 'ON' : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
  void chrome.action.setTitle({ title: status.run ? 'Cascade: a run is using this browser (page addresses and text are being sent to your server)' : `Cascade: ${status.connection}` });
  chrome.runtime.sendMessage({ type: 'status', status }).catch(() => { /* no page open */ });
}

// ── What a previous worker left ─────────────

async function cleanUpAfterRestart(): Promise<void> {
  const { runWindows } = await chrome.storage.session.get('runWindows') as { runWindows?: number[] };
  // Closing a run's window closes its tab, and the debugger attachment goes with it.
  for (const windowId of runWindows ?? []) await chrome.windows.remove(windowId).catch(() => {});
  // The runs' rules only: the lasting worker rules below RUN_RULE_IDS_FROM stay until
  // Chrome restarts (see keepWorkersOffPrivateNetwork).
  const rules = (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => r.id >= RUN_RULE_IDS_FROM);
  if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
  await chrome.storage.session.set({ runWindows: [] });
  // A run held WebRTC's UDP off; with no run left, it goes back to the user's setting.
  await releaseWebRtcAfterRestart();
}

async function rememberWindow(windowId: number, add: boolean): Promise<void> {
  const { runWindows = [] } = await chrome.storage.session.get('runWindows') as { runWindows?: number[] };
  await chrome.storage.session.set({ runWindows: add ? [...runWindows, windowId] : runWindows.filter((w) => w !== windowId) });
}

// ── Asking the user ─────────────────────────

interface PendingAsk { id: number; runId: string; expiresAt: number; hint?: RunHint; resolve(c: UserConsent | null): void; windowId?: number }
const asks = new Map<number, PendingAsk>();
let nextAsk = 1;

/** Normal or private window, as last chosen. A private one until the user picks otherwise. */
async function lastWindowMode(): Promise<'incognito' | 'normal'> {
  const { windowMode } = await chrome.storage.local.get('windowMode') as { windowMode?: string };
  return windowMode === 'normal' ? 'normal' : 'incognito';
}

async function askUser(run: { runId: string; expiresAt: number; signal: AbortSignal; hint?: RunHint }): Promise<UserConsent | null> {
  // An answer the user kept for this chat: used without asking, and said so.
  const server = status.device?.server;
  if (run.hint?.chat && server) {
    const kept = await recallAnswer(answers, keptKey(server, run.hint.chat), Date.now()).catch(() => null);
    const read = kept ? consentFromForm(kept) : null;
    if (kept && read && 'consent' in read && (!kept.incognito || await chrome.extension.isAllowedIncognitoAccess())) {
      approvedRun = run.runId;
      approvedIncognito = kept.incognito;
      void chrome.notifications?.create({
        type: 'basic', iconUrl: 'icon-128.png', title: 'Cascade is using this browser',
        message: `A run from a chat you allowed is using ${kept.anyPublic ? 'any public site' : kept.sites} in a ${kept.incognito ? 'private' : 'new'} window. Stop it from the Cascade button.`,
      }).catch(() => {});
      return read.consent;
    }
  }
  return new Promise((resolve) => {
    const id = nextAsk++;
    const pending: PendingAsk = { id, runId: run.runId, expiresAt: run.expiresAt, ...(run.hint ? { hint: run.hint } : {}), resolve: (c) => { asks.delete(id); if (pending.windowId) void chrome.windows.remove(pending.windowId).catch(() => {}); resolve(c); } };
    asks.set(id, pending);
    run.signal.addEventListener('abort', () => pending.resolve(null), { once: true });
    void chrome.windows.create({ url: chrome.runtime.getURL(`consent.html?ask=${id}`), type: 'popup', width: 480, height: 600, focused: true })
      .then((w) => { pending.windowId = w?.id; if (!asks.has(id) && w?.id) void chrome.windows.remove(w.id).catch(() => {}); })
      .catch(() => pending.resolve(null));
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  // Closing the question is a no.
  for (const a of asks.values()) if (a.windowId === windowId) { a.windowId = undefined; a.resolve(null); }
});

// ── Serving ─────────────────────────────────

async function connect(): Promise<void> {
  if (client) return;
  if (!online()) {
    // Waits for the 'online' event below rather than failing once a backoff.
    if (status.device) { status.connection = 'offline'; publish(); }
    return;
  }
  if (connecting) { connectAgain = true; return; }
  // Reserved before the first await: two attempts that overlap there (a quick
  // second Retry, or pairing finishing alongside its storage change) would each
  // make a client, and the hub's replacing one control connection with the next
  // has them knock each other off. Released on every way out below. One that
  // arrives meanwhile is not lost: if this attempt ends with no client (it read
  // storage just before pairing wrote it), it looks once more.
  connecting = true;
  connectAgain = false;
  const giveUp = (): void => {
    connecting = false;
    if (connectAgain) { connectAgain = false; void connect(); }
  };
  const epoch = connectEpoch;
  let device: PairedDevice | null;
  try { device = await loadDevice(); } catch (e) { giveUp(); throw e; }
  if (epoch !== connectEpoch) { giveUp(); return; }
  if (!device) { status.connection = 'unpaired'; delete status.device; publish(); giveUp(); return; }
  const serverKey = publicKeyFromText(device.serverKey);
  if (!serverKey) { status.connection = 'refused'; status.notice = 'The saved server key is unreadable. Pair this browser again.'; publish(); giveUp(); return; }
  status.connection = 'connecting';
  status.device = { name: device.name, server: device.serverUrl };
  publish();
  let c: DeviceClient;
  try {
    c = connectDeviceClient({
      ...endpointsOf(device),
      device: identityFromPrivateKey(device.deviceId, device.privateKeyPem),
      serverId: device.serverId, serverKey,
      keepaliveMs: KEEPALIVE_MS,
      askUser,
      startBrowser: async (consent) => {
        const leased = await openRunTab({
          consent, firstRuleId: (nextRuleId += 100), incognito: approvedIncognito,
          onStop: (reason) => {
            c.revoke(reason);
            status.notice = reason;
            publish();
            void chrome.notifications?.create({ type: 'basic', iconUrl: 'icon-128.png', title: 'Cascade run stopped', message: reason }).catch(() => {});
          },
        });
        await rememberWindow(leased.windowId, true);
        status.run = { runId: approvedRun, sites: consent.anyPublic ? ['any public site', ...consent.origins] : [...consent.origins], windowId: leased.windowId };
        publish();
        return {
          ...leased,
          async close() {
            await leased.close();
            await rememberWindow(leased.windowId, false);
            if (status.run?.windowId === leased.windowId) delete status.run;
            publish();
          },
        };
      },
      // The run's owner pressed "Show the window" in the chat.
      onFocus: () => {
        const w = status.run?.windowId;
        if (w !== undefined) void chrome.windows.update(w, { focused: true, drawAttention: true }).catch(() => {});
      },
      log: note,
    });
  } catch (e) {
    giveUp();
    throw e;
  }
  connecting = false;
  connectAgain = false;
  client = c;
  let welcomed = false;
  c.ready.then(() => {
    welcomed = true; refusals = 0; backoffMs = 1000;
    status.connection = 'online';
    publish();
  }, () => {});
  void c.closed.then(async () => {
    if (client === c) client = null;
    delete status.run;
    // Only the server turning this browser away counts; an outage is waited out.
    if (!welcomed && c.rejected() && ++refusals >= 3) {
      status.connection = 'refused';
      status.notice = 'The server does not accept this browser any more. It may have been removed: forget it and pair again.';
      publish();
      return;
    }
    if (!await loadDevice()) { status.connection = 'unpaired'; publish(); return; }
    status.connection = 'offline';
    publish();
    if (c.restarting()) {
      // A deploy: the server comes back in seconds. Asking at once would only
      // reach the gap before it is up, and Chrome logs every such failure.
      backoffMs = 1000;
      retryIn(RESTART_WAIT_MS + Math.floor(Math.random() * 2000));
      return;
    }
    retryIn(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  });
}

// ── Messages from the extension's own pages ─

type Message =
  | { type: 'status' }
  | { type: 'take-over' }
  | { type: 'hand-back' }
  | { type: 'consent:get'; ask: number }
  | ({ type: 'consent:answer'; ask: number } & ConsentForm)
  | { type: 'answers:forget' }
  | { type: 'pair'; server: string; name: string }
  | { type: 'stop' }
  | { type: 'forget' }
  | { type: 'retry' };

let pairing: AbortController | null = null;

async function handle(msg: Message): Promise<unknown> {
  switch (msg.type) {
    case 'status':
      await refreshKept();
      return status;
    case 'consent:get': {
      const a = asks.get(msg.ask);
      if (!a) return null;
      return {
        runId: a.runId, expiresAt: a.expiresAt, server: status.device?.server,
        // What the run says it will open first: pre-filled, the user's to change.
        sites: a.hint?.sites ?? [],
        canRemember: !!a.hint?.chat,
        windowMode: await lastWindowMode(),
        incognitoAllowed: await chrome.extension.isAllowedIncognitoAccess(),
      };
    }
    case 'consent:answer': {
      const a = asks.get(msg.ask);
      if (!a) return { error: 'This request is over.' };
      const form: ConsentForm = { sites: String(msg.sites ?? ''), anyPublic: msg.anyPublic === true, incognito: msg.incognito !== false, remember: msg.remember === true };
      const read = consentFromForm(form);
      if (!read) { a.resolve(null); return { ok: true }; }
      if ('error' in read) return read;
      if (form.incognito && !await chrome.extension.isAllowedIncognitoAccess()) {
        return { error: 'Chrome hasn\'t let Cascade use private windows. Turn on "Allow in Incognito" for Cascade in chrome://extensions, or choose a normal window.' };
      }
      await chrome.storage.local.set({ windowMode: form.incognito ? 'incognito' : 'normal' });
      const server = status.device?.server;
      if (form.remember && a.hint?.chat && server) await keepAnswer(answers, keptKey(server, a.hint.chat), form, Date.now());
      approvedRun = a.runId;
      approvedIncognito = form.incognito;
      a.resolve(read.consent);
      return { ok: true };
    }
    case 'answers:forget':
      await forgetAnswers(answers);
      await refreshKept();
      publish();
      return { ok: true };
    case 'pair': {
      pairing?.abort();
      const ctl = new AbortController();
      pairing = ctl;
      delete status.pairing;
      void pairWithServer({
        server: msg.server, name: msg.name, signal: ctl.signal,
        onCode: (code) => {
          status.pairing = code;
          publish();
          void chrome.tabs.create({ url: `${code.verificationUri}?code=${encodeURIComponent(code.userCode)}` });
        },
      }).then(async (device) => {
        // Forget, or a newer pairing, since: this one's result is not to be kept.
        if (pairing !== ctl || ctl.signal.aborted) return;
        pairing = null;
        await chrome.storage.local.set({ device });
        delete status.pairing;
        delete status.notice;
        refusals = 0;
        await connect();
      }, (e: unknown) => {
        if (pairing !== ctl) return;
        pairing = null;
        if (ctl.signal.aborted) return;
        status.pairing = { error: e instanceof Error ? e.message : String(e) };
        publish();
      });
      return { ok: true };
    }
    case 'stop':
      client?.revoke('you stopped it in the extension');
      return { ok: true };
    case 'take-over': {
      // The lease's fence closes before this returns: from here the agent's commands
      // are refused and nothing the page does is passed on, until the user hands back.
      // The relay brings the agent up to date with what changed when they do.
      const lease = client?.lease();
      if (!lease || lease.state() !== 'held' || !status.run) return { error: 'No run is using this browser.' };
      lease.suspend();
      status.run.takenOver = true;
      publish();
      if (status.run.windowId !== undefined) void chrome.windows.update(status.run.windowId, { focused: true }).catch(() => {});
      return { ok: true };
    }
    case 'hand-back': {
      const lease = client?.lease();
      if (!lease || lease.state() !== 'suspended' || !status.run) return { error: 'The run is not paused for you.' };
      lease.handBack();
      status.run.takenOver = false;
      publish();
      return { ok: true };
    }
    case 'retry':
      refusals = 0;
      await connect();
      return { ok: true };
    case 'forget': {
      connectEpoch++;
      pairing?.abort();
      await chrome.storage.local.remove('device');
      const c = client;
      client = null;
      await c?.close();
      Object.assign(status, { connection: 'unpaired' as Connection });
      delete status.device; delete status.run; delete status.notice;
      publish();
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((msg: Message, sender, reply) => {
  // Only this extension's own pages: a web page has no way to send here.
  if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))) return false;
  void handle(msg).then(reply, (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});

// ── Start ───────────────────────────────────

const started = cleanUpAfterRestart().catch(() => {}).then(() => connect());
// Chrome wakes a stopped worker for an alarm; a paired browser reconnects then.
chrome.alarms.create('wake', { periodInMinutes: 1 });
// Not before a scheduled retry is due: the alarm wakes a stopped worker, it
// doesn't overrule the backoff a running one is keeping.
chrome.alarms.onAlarm.addListener(() => { void started.then(() => { if (Date.now() >= nextAttemptAt) void connect(); }); });
// The network came back: try now rather than at the end of a backoff.
self.addEventListener('online', () => { backoffMs = 1000; nextAttemptAt = 0; void started.then(() => connect()); });
// Paired: the device was saved, by this worker or another page of this extension.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['device']?.newValue) { refusals = 0; void started.then(() => connect()); }
});
chrome.runtime.onStartup.addListener(() => { void started.then(() => connect()); });
