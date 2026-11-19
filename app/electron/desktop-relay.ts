// ─────────────────────────────────────────────
//  Cascade Desktop — pairing this app as a device, serving it, asking the user
// ─────────────────────────────────────────────
//
// Off until the user turns it on in Settings. Turning it on, signed in to Cascade
// Cloud, makes a key here, registers its public half as a "desktop" device of the
// account, and keeps the private half encrypted by the operating system's keychain
// (Electron's safeStorage). Then the app stays connected while it runs, and each run
// that wants a browser is asked about in the app's own window: the sites it may open,
// or no. A yes opens a run window (relay-device.ts).

import * as os from 'node:os';
import type { Consent, ElectronDeps, RelayCore, RunBrowser, UserConsent } from './relay-device.js';
import { openRunBrowser } from './relay-device.js';
import type { RelayCloudClient } from './cloudAuth.js';

export interface StoredDesktopDevice {
  serverUrl: string;
  /** The Cascade Cloud account it was paired for: it serves while that account is signed in. */
  accountId: string;
  deviceId: string;
  name: string;
  serverId: string;
  serverKey: string;
  controlPath: string;
  runPath: string;
  /** The private key, encrypted by the OS keychain. Never stored in the clear. */
  privateKeyEnc: string;
  enabled: boolean;
}

export interface DesktopRelayCore extends RelayCore {
  generateRelayKey(): { privateKeyPem: string; publicKey: string };
  makeConsent(origins: Iterable<string>, privateOrigins?: Iterable<string>): Consent;
  parseRelaySites(answer: string): { consent: UserConsent } | { error: string } | null;
  relayEndpoints(serverUrl: string, info: { controlPath: string; runPath: string }): { controlUrl: string; runUrl: string };
  serveDevice(opts: {
    stored: { deviceId: string; privateKeyPem: string; serverId: string; serverKey: string };
    endpoints: { controlUrl: string; runUrl: string };
    askUser(run: { runId: string; expiresAt: number; signal: AbortSignal; hint?: { sites: string[]; chat?: string } }): Promise<UserConsent | null>;
    onFocus?(): void;
    startBrowser(consent: Consent): Promise<RunBrowser>;
    log(line: string): void;
    signal: AbortSignal;
    onClient?(client: RelayDeviceClient | null): void;
  }): Promise<'stopped' | 'refused'>;
}

export interface DesktopRelayDeps {
  core: DesktopRelayCore;
  electron: ElectronDeps;
  /** The signed-in account: its id, its client and its server; null when signed out. */
  cloud(): { userId: string; client: RelayCloudClient; serverUrl: string } | null;
  file: { load(): StoredDesktopDevice | null; save(d: StoredDesktopDevice): void; clear(): void };
  vault: { available(): boolean; encrypt(text: string): string; decrypt(blob: string): string };
  /** To the app's window: questions, and status. */
  notify(channel: 'relay:ask' | 'relay:ask-closed' | 'relay:status', payload: unknown): void;
  hostname?: () => string;
}

/** What a takeover needs of the connection: the lease of the run it serves. */
export interface RelayDeviceClient {
  lease(): { state(): string; suspend(): void; handBack(): void } | null;
}

export interface DesktopRelayStatus {
  paired: boolean;
  enabled: boolean;
  connected: boolean;
  name: string | null;
  server: string | null;
  run: boolean;
  /** The user has the run's window: the run can't act there until they hand it back. */
  takenOver: boolean;
  error: string | null;
}

interface Ask { id: number; runId: string; expiresAt: number; resolve(c: UserConsent | null): void }

export function createDesktopRelay(deps: DesktopRelayDeps) {
  const asks = new Map<number, Ask>();
  let nextAsk = 1;
  let serving: AbortController | null = null;
  let connected = false;
  let run: RunBrowser | null = null;
  let client: RelayDeviceClient | null = null;
  // Bumped by every sign-in and sign-out: a pairing that began under another account stops.
  let accountEpoch = 0;
  let pairing: Promise<StoredDesktopDevice> | null = null;
  let error: string | null = null;

  /** Whether the account signed in now is the one the pairing belongs to. */
  const ownerSignedIn = (d: StoredDesktopDevice): boolean => {
    const c = deps.cloud();
    return !!c && c.userId === d.accountId && c.serverUrl === d.serverUrl;
  };
  /** Why a pairing left on isn't serving, when it's the account. */
  const accountProblem = (d: StoredDesktopDevice | null): string | null => {
    if (!d?.enabled || ownerSignedIn(d)) return null;
    return deps.cloud()
      ? 'This app was paired for another Cascade Cloud account. Sign in to that one, or remove this app as a device.'
      : 'Sign in to Cascade Cloud, with the account this app was paired for, to serve its runs.';
  };

  const status = (): DesktopRelayStatus => {
    const d = deps.file.load();
    const takenOver = run !== null && client?.lease()?.state() === 'suspended';
    return { paired: !!d, enabled: !!d?.enabled, connected, name: d?.name ?? null, server: d?.serverUrl ?? null, run: run !== null, takenOver, error: error ?? accountProblem(d) };
  };

  /** Stops serving now: the connection closes, a run on it ends, a question gets no. */
  const stopServing = (): void => {
    serving?.abort();
    serving = null;
    connected = false;
    for (const a of [...asks.values()]) a.resolve(null);
  };
  const publish = (): void => deps.notify('relay:status', status());

  const askUser = (r: { runId: string; expiresAt: number; signal: AbortSignal; hint?: { sites: string[] } }): Promise<UserConsent | null> =>
    new Promise((resolve) => {
      const id = nextAsk++;
      const done = (c: UserConsent | null): void => {
        if (!asks.delete(id)) return;
        deps.notify('relay:ask-closed', { id });
        resolve(c);
      };
      asks.set(id, { id, runId: r.runId, expiresAt: r.expiresAt, resolve: done });
      r.signal.addEventListener('abort', () => done(null), { once: true });
      // The site the run wants to start on, to pre-fill: the user's to change.
      deps.notify('relay:ask', { id, runId: r.runId, expiresAt: r.expiresAt, sites: r.hint?.sites ?? [] });
    });

  const startBrowser = async (consent: Consent): Promise<RunBrowser> => {
    const b = await openRunBrowser(consent, deps.core, deps.electron);
    run = b;
    publish();
    return {
      ...b,
      async close() {
        await b.close();
        if (run === b) run = null;
        publish();
      },
    };
  };

  const serve = (d: StoredDesktopDevice): void => {
    serving?.abort();
    const ctl = new AbortController();
    serving = ctl;
    let privateKeyPem: string;
    try { privateKeyPem = deps.vault.decrypt(d.privateKeyEnc); } catch {
      error = 'This app\'s device key could not be read. Turn it off and on again to pair anew.';
      publish();
      return;
    }
    void deps.core.serveDevice({
      stored: { deviceId: d.deviceId, privateKeyPem, serverId: d.serverId, serverKey: d.serverKey },
      endpoints: deps.core.relayEndpoints(d.serverUrl, d),
      askUser, startBrowser, signal: ctl.signal,
      onClient: (c) => { if (serving === ctl) client = c; },
      // "Show the window", from the chat on the web.
      onFocus: () => run?.focus(),
      log: (line) => {
        if (line.startsWith('connected')) { connected = true; error = null; publish(); }
        else if (line.startsWith('disconnected')) { connected = false; publish(); }
      },
    }).then((outcome) => {
      if (serving !== ctl) return;
      connected = false;
      if (outcome === 'refused') error = 'Cascade Cloud no longer accepts this app as a device. It may have been removed: turn this off, then on again.';
      publish();
    }, (e: unknown) => {
      connected = false;
      error = e instanceof Error ? e.message : String(e);
      publish();
    });
  };

  /** Registers this app for the account signed in now; nothing is kept if the account changes meanwhile. */
  const pair = async (): Promise<StoredDesktopDevice> => {
    const cloud = deps.cloud();
    if (!cloud) throw new Error('Sign in to Cascade Cloud first.');
    if (!deps.vault.available()) throw new Error('This computer has no keychain the app can use, so it can\'t keep a device key safely.');
    const epoch = accountEpoch;
    const stillThisAccount = (): boolean => epoch === accountEpoch && deps.cloud()?.userId === cloud.userId;
    const info = await cloud.client.relayServer();
    if (!stillThisAccount()) throw new Error('You signed out or changed account while pairing. Nothing was saved.');
    const key = deps.core.generateRelayKey();
    const name = `${(deps.hostname ?? os.hostname)()} (desktop app)`.slice(0, 80);
    const reg = await cloud.client.registerRelayDevice({ name, kind: 'desktop', publicKey: key.publicKey });
    if (!stillThisAccount()) {
      // Registered for an account that's gone from here: take it back if the server still lets us.
      await cloud.client.removeRelayDevice(reg.device.id).catch(() => { /* removable from that account's settings */ });
      throw new Error('You signed out or changed account while pairing. Nothing was saved.');
    }
    if (reg.serverId !== info.serverId || reg.serverKey !== info.serverKey) throw new Error('The server changed its identity while pairing. Nothing was saved.');
    return {
      serverUrl: cloud.serverUrl, accountId: cloud.userId, deviceId: reg.device.id, name: reg.device.name, serverId: info.serverId, serverKey: info.serverKey,
      controlPath: info.controlPath, runPath: info.runPath, privateKeyEnc: deps.vault.encrypt(key.privateKeyPem), enabled: true,
    };
  };

  return {
    status,

    /** Pairs if need be (signed in), then serves. */
    async enable(): Promise<DesktopRelayStatus> {
      let d = deps.file.load();
      if (d && !ownerSignedIn(d)) throw new Error(accountProblem({ ...d, enabled: true })!);
      if (!d) {
        // One pairing at a time: a second click waits for the first.
        pairing ??= pair().finally(() => { pairing = null; });
        d = await pairing;
      } else {
        d = { ...d, enabled: true };
      }
      deps.file.save(d);
      error = null;
      serve(d);
      publish();
      return status();
    },

    /** Stops serving; a run using this app's browser ends. The pairing is kept. */
    disable(): DesktopRelayStatus {
      stopServing();
      const d = deps.file.load();
      if (d) deps.file.save({ ...d, enabled: false });
      publish();
      return status();
    },

    /** Removes this app as a device, on the server and here. */
    async forget(): Promise<DesktopRelayStatus> {
      const d = deps.file.load();
      this.disable();
      if (d) {
        // Removed on the server only through the account it belongs to; under another
        // account (or none) the key still goes from here. Already gone is fine.
        if (ownerSignedIn(d)) {
          await deps.cloud()!.client.removeRelayDevice(d.deviceId).catch((e: unknown) => { if (!/\(404\)/.test(String(e))) throw e; });
        }
        deps.file.clear();
      }
      publish();
      return status();
    },

    /**
     * The user takes the run's window: the lease's fence closes at once, so the run's
     * commands are refused and nothing from the page is passed on, until hand back.
     */
    takeOver(): { ok: true } | { error: string } {
      const lease = client?.lease();
      if (!run || !lease || lease.state() !== 'held') return { error: 'No run is using this app\'s browser.' };
      lease.suspend();
      run.focus();
      publish();
      return { ok: true };
    },

    /** The run carries on, from the page the user left; the relay brings it up to date. */
    handBack(): { ok: true } | { error: string } {
      const lease = client?.lease();
      if (!run || !lease || lease.state() !== 'suspended') return { error: 'The run is not paused for you.' };
      lease.handBack();
      publish();
      return { ok: true };
    },

    /**
     * The user's answer from the app's window: the sites typed, whether any public
     * site may load too, and whether still screenshots may go to the server for the
     * run's report. Nothing at all is a no; an answer that isn't sites is asked again.
     */
    answer(id: number, sites: string, anyPublic = false, screenshots = false): { ok: true } | { error: string } {
      const a = asks.get(id);
      if (!a) return { error: 'This request is over.' };
      const parsed = deps.core.parseRelaySites(sites);
      if (parsed && 'error' in parsed) return parsed;
      if (!parsed && !anyPublic) { a.resolve(null); return { ok: true }; }
      const consent = parsed?.consent ?? { allowedOrigins: [], privateOrigins: [] };
      a.resolve({ ...consent, ...(anyPublic || consent.anyPublic ? { anyPublic: true } : {}), ...(screenshots ? { screenshots: true } : {}) });
      return { ok: true };
    },

    /** At start: serve if the user left it on, and its account is the one signed in. */
    resume(): void {
      const d = deps.file.load();
      if (d?.enabled && ownerSignedIn(d)) serve(d);
      publish();
    },

    /** Signed out, or in as someone else: stop, and serve again only for the pairing's own account. */
    accountChanged(): void {
      accountEpoch += 1;
      stopServing();
      error = null;
      this.resume();
    },

    /** Quitting: end everything. */
    shutdown(): void {
      stopServing();
    },
  };
}

export type DesktopRelay = ReturnType<typeof createDesktopRelay>;
