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
    askUser(run: { runId: string; expiresAt: number; signal: AbortSignal }): Promise<UserConsent | null>;
    startBrowser(consent: Consent): Promise<RunBrowser>;
    log(line: string): void;
    signal: AbortSignal;
  }): Promise<'stopped' | 'refused'>;
}

export interface DesktopRelayDeps {
  core: DesktopRelayCore;
  electron: ElectronDeps;
  /** The signed-in account's client and its server, or null when signed out. */
  cloud(): { client: RelayCloudClient; serverUrl: string } | null;
  file: { load(): StoredDesktopDevice | null; save(d: StoredDesktopDevice): void; clear(): void };
  vault: { available(): boolean; encrypt(text: string): string; decrypt(blob: string): string };
  /** To the app's window: questions, and status. */
  notify(channel: 'relay:ask' | 'relay:ask-closed' | 'relay:status', payload: unknown): void;
  hostname?: () => string;
}

export interface DesktopRelayStatus {
  paired: boolean;
  enabled: boolean;
  connected: boolean;
  name: string | null;
  server: string | null;
  run: boolean;
  error: string | null;
}

interface Ask { id: number; runId: string; expiresAt: number; resolve(c: UserConsent | null): void }

export function createDesktopRelay(deps: DesktopRelayDeps) {
  const asks = new Map<number, Ask>();
  let nextAsk = 1;
  let serving: AbortController | null = null;
  let connected = false;
  let run: RunBrowser | null = null;
  let error: string | null = null;

  const status = (): DesktopRelayStatus => {
    const d = deps.file.load();
    return { paired: !!d, enabled: !!d?.enabled, connected, name: d?.name ?? null, server: d?.serverUrl ?? null, run: run !== null, error };
  };
  const publish = (): void => deps.notify('relay:status', status());

  const askUser = (r: { runId: string; expiresAt: number; signal: AbortSignal }): Promise<UserConsent | null> =>
    new Promise((resolve) => {
      const id = nextAsk++;
      const done = (c: UserConsent | null): void => {
        if (!asks.delete(id)) return;
        deps.notify('relay:ask-closed', { id });
        resolve(c);
      };
      asks.set(id, { id, runId: r.runId, expiresAt: r.expiresAt, resolve: done });
      r.signal.addEventListener('abort', () => done(null), { once: true });
      deps.notify('relay:ask', { id, runId: r.runId, expiresAt: r.expiresAt });
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

  return {
    status,

    /** Pairs if need be (signed in), then serves. */
    async enable(): Promise<DesktopRelayStatus> {
      let d = deps.file.load();
      if (!d) {
        const cloud = deps.cloud();
        if (!cloud) throw new Error('Sign in to Cascade Cloud first.');
        if (!deps.vault.available()) throw new Error('This computer has no keychain the app can use, so it can\'t keep a device key safely.');
        const info = await cloud.client.relayServer();
        const key = deps.core.generateRelayKey();
        const name = `${(deps.hostname ?? os.hostname)()} (desktop app)`.slice(0, 80);
        const reg = await cloud.client.registerRelayDevice({ name, kind: 'desktop', publicKey: key.publicKey });
        if (reg.serverId !== info.serverId || reg.serverKey !== info.serverKey) throw new Error('The server changed its identity while pairing. Nothing was saved.');
        d = {
          serverUrl: cloud.serverUrl, deviceId: reg.device.id, name: reg.device.name, serverId: info.serverId, serverKey: info.serverKey,
          controlPath: info.controlPath, runPath: info.runPath, privateKeyEnc: deps.vault.encrypt(key.privateKeyPem), enabled: true,
        };
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
      serving?.abort();
      serving = null;
      connected = false;
      for (const a of [...asks.values()]) a.resolve(null);
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
        const cloud = deps.cloud();
        // Already gone on the server is fine: the key still goes from here.
        await cloud?.client.removeRelayDevice(d.deviceId).catch((e: unknown) => { if (!/\(404\)/.test(String(e))) throw e; });
        deps.file.clear();
      }
      publish();
      return status();
    },

    /** The user's answer from the app's window. An answer that isn't sites is asked again. */
    answer(id: number, sites: string): { ok: true } | { error: string } {
      const a = asks.get(id);
      if (!a) return { error: 'This request is over.' };
      const parsed = deps.core.parseRelaySites(sites);
      if (parsed && 'error' in parsed) return parsed;
      a.resolve(parsed ? parsed.consent : null);
      return { ok: true };
    },

    /** At start: serve if the user left it on. */
    resume(): void {
      const d = deps.file.load();
      if (d?.enabled) serve(d);
    },

    /** Quitting: end everything. */
    shutdown(): void {
      serving?.abort();
      serving = null;
      for (const a of [...asks.values()]) a.resolve(null);
    },
  };
}

export type DesktopRelay = ReturnType<typeof createDesktopRelay>;
