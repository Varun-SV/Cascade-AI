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
import { parseSites } from '../../src/browser/relay/consent-input.js';
import { type DeviceClient, type UserConsent, connectDeviceClient } from '../../src/browser/relay/device.js';
import { makeConsent } from '../../src/browser/relay/egress-rules.js';
import { type PairedDevice, endpointsOf, pairWithServer } from './pairing.js';
import { RUN_RULE_IDS_FROM, openRunTab, releaseWebRtcAfterRestart } from './tab-policy.js';

// ── State ────────────────────────────────────

type Connection = 'unpaired' | 'connecting' | 'online' | 'offline' | 'refused';
interface RunInfo { runId: string; sites: string[]; windowId?: number }
interface Status { connection: Connection; device?: { name: string; server: string }; run?: RunInfo; pairing?: { userCode: string; verificationUri: string } | { error: string }; notice?: string }

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
let nextRuleId = RUN_RULE_IDS_FROM;
/** The run the user approved last: the next browser started is its. */
let approvedRun = '';

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

interface PendingAsk { id: number; runId: string; expiresAt: number; resolve(c: UserConsent | null): void; windowId?: number }
const asks = new Map<number, PendingAsk>();
let nextAsk = 1;

async function askUser(run: { runId: string; expiresAt: number; signal: AbortSignal }): Promise<UserConsent | null> {
  return new Promise((resolve) => {
    const id = nextAsk++;
    const pending: PendingAsk = { id, runId: run.runId, expiresAt: run.expiresAt, resolve: (c) => { asks.delete(id); if (pending.windowId) void chrome.windows.remove(pending.windowId).catch(() => {}); resolve(c); } };
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
          consent, firstRuleId: (nextRuleId += 100),
          onStop: (reason) => {
            c.revoke(reason);
            status.notice = reason;
            publish();
            void chrome.notifications?.create({ type: 'basic', iconUrl: 'icon-128.png', title: 'Cascade run stopped', message: reason }).catch(() => {});
          },
        });
        await rememberWindow(leased.windowId, true);
        status.run = { runId: approvedRun, sites: [...consent.origins], windowId: leased.windowId };
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
    if (!welcomed && ++refusals >= 3) {
      status.connection = 'refused';
      status.notice = 'The server does not accept this browser any more. It may have been removed: forget it and pair again.';
      publish();
      return;
    }
    if (!await loadDevice()) { status.connection = 'unpaired'; publish(); return; }
    status.connection = 'offline';
    publish();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { void connect(); }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  });
}

// ── Messages from the extension's own pages ─

type Message =
  | { type: 'status' }
  | { type: 'consent:get'; ask: number }
  | { type: 'consent:answer'; ask: number; sites: string }
  | { type: 'pair'; server: string; name: string }
  | { type: 'stop' }
  | { type: 'forget' }
  | { type: 'retry' };

let pairing: AbortController | null = null;

async function handle(msg: Message): Promise<unknown> {
  switch (msg.type) {
    case 'status': return status;
    case 'consent:get': {
      const a = asks.get(msg.ask);
      return a ? { runId: a.runId, expiresAt: a.expiresAt, server: status.device?.server } : null;
    }
    case 'consent:answer': {
      const a = asks.get(msg.ask);
      if (!a) return { error: 'This request is over.' };
      const parsed = parseSites(msg.sites);
      if (!parsed) { a.resolve(null); return { ok: true }; }
      if ('error' in parsed) return parsed;
      if (parsed.consent.allowedOrigins.length > 50) return { error: 'Allow at most 50 sites for one run.' };
      if (parsed.consent.privateOrigins.length) return { error: "Sites on your private network can't be used from your own Chrome: the extension can't keep a run off them. Use the Cascade CLI or desktop app for those." };
      // Checked here as the policy will read it: an answer it would refuse is asked again.
      makeConsent(parsed.consent.allowedOrigins);
      approvedRun = a.runId;
      a.resolve(parsed.consent);
      return { ok: true };
    }
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
chrome.alarms.onAlarm.addListener(() => { void started.then(() => connect()); });
// Paired: the device was saved, by this worker or another page of this extension.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['device']?.newValue) { refusals = 0; void started.then(() => connect()); }
});
chrome.runtime.onStartup.addListener(() => { void started.then(() => connect()); });
