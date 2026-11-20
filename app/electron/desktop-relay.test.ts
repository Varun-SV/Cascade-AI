// ─────────────────────────────────────────────
//  Cascade Desktop — this app as a device: pairing, the key, the questions
// ─────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { parseSites } from '../../src/cli/commands/relay.js';
const opened = vi.hoisted(() => ({ windows: [] as Array<{ focus: ReturnType<typeof import('vitest').vi.fn>; close: () => Promise<void> }> }));
vi.mock('./relay-device.js', () => ({
  openRunBrowser: async () => {
    const w = { focus: vi.fn(), close: async () => {} };
    opened.windows.push(w);
    return w;
  },
}));
import { createDesktopRelay, type DesktopRelayCore, type DesktopRelayDeps, type StoredDesktopDevice } from './desktop-relay.js';

type ServeOpts = Parameters<DesktopRelayCore['serveDevice']>[0];

function harness(over: { signedIn?: boolean; keychain?: boolean; reply?: { serverId: string; serverKey: string }; stored?: StoredDesktopDevice; account?: string; gate?: Promise<void> } = {}) {
  let account: string | null = over.signedIn === false ? null : (over.account ?? 'user-a');
  let saved: StoredDesktopDevice | null = over.stored ?? null;
  const served: ServeOpts[] = [];
  let finish: ((o: 'stopped' | 'refused') => void) | null = null;
  const notes: Array<[string, unknown]> = [];
  const registered: unknown[] = [];
  const removed: string[] = [];
  const core = {
    generateRelayKey: () => ({ privateKeyPem: '-----BEGIN PRIVATE KEY-----x', publicKey: 'pub' }),
    parseRelaySites: parseSites,
    relayEndpoints: (url: string, p: { controlPath: string; runPath: string }) => ({ controlUrl: url + p.controlPath, runUrl: url + p.runPath }),
    serveDevice: (o: ServeOpts) => {
      served.push(o);
      return new Promise<'stopped' | 'refused'>((r) => {
        finish = r;
        o.signal.addEventListener('abort', () => r('stopped'));
      });
    },
  } as unknown as DesktopRelayCore;
  const info = { serverId: 's1', serverKey: 'k1', controlPath: '/c', runPath: '/r' };
  const deps: DesktopRelayDeps = {
    core,
    electron: {} as DesktopRelayDeps['electron'],
    cloud: () => (account === null ? null : {
      userId: account,
      serverUrl: 'https://cloud.test',
      client: {
        relayServer: async () => info,
        registerRelayDevice: async (input: unknown) => { registered.push(input); await over.gate; return { device: { id: 'dev-1', name: 'box (desktop app)' }, ...(over.reply ?? { serverId: 's1', serverKey: 'k1' }) }; },
        removeRelayDevice: async (id: string) => { removed.push(id); },
      } as never,
    }),
    file: { load: () => saved, save: (d) => { saved = d; }, clear: () => { saved = null; } },
    vault: { available: () => over.keychain !== false, encrypt: (t) => `enc(${t})`, decrypt: (b) => /^enc\((.*)\)$/s.exec(b)![1]! },
    notify: (c, p) => notes.push([c, p]),
    hostname: () => 'box',
  };
  return {
    relay: createDesktopRelay(deps), served, notes, registered, removed, saved: () => saved, finish: (o: 'stopped' | 'refused') => finish!(o),
    signIn: (id: string | null) => { account = id; },
  };
}

const pairedDevice = (enabled: boolean): StoredDesktopDevice => ({
  serverUrl: 'https://cloud.test', accountId: 'user-a', deviceId: 'dev-1', name: 'box (desktop app)', serverId: 's1', serverKey: 'k1',
  controlPath: '/c', runPath: '/r', privateKeyEnc: 'enc(pem)', enabled,
});

describe('turning it on', () => {
  it('pairs as a desktop device, sends only the public key, and keeps the private one encrypted', async () => {
    const h = harness();
    const s = await h.relay.enable();
    expect(h.registered).toEqual([{ name: 'box (desktop app)', kind: 'desktop', publicKey: 'pub' }]);
    expect(h.saved()).toMatchObject({ accountId: 'user-a', deviceId: 'dev-1', serverId: 's1', serverKey: 'k1', enabled: true, privateKeyEnc: 'enc(-----BEGIN PRIVATE KEY-----x)' });
    expect(JSON.stringify(h.saved())).not.toMatch(/"privateKeyPem"/);
    expect(h.served).toHaveLength(1);
    expect(h.served[0]!.stored.privateKeyPem).toBe('-----BEGIN PRIVATE KEY-----x');
    expect(h.served[0]!.endpoints).toEqual({ controlUrl: 'https://cloud.test/c', runUrl: 'https://cloud.test/r' });
    expect(s).toMatchObject({ paired: true, enabled: true, connected: false });
  });

  it('signed out, or with no keychain, nothing is paired or saved', async () => {
    const out = harness({ signedIn: false });
    await expect(out.relay.enable()).rejects.toThrow(/Sign in/);
    const noVault = harness({ keychain: false });
    await expect(noVault.relay.enable()).rejects.toThrow(/keychain/);
    expect(noVault.registered).toEqual([]);
    expect(out.saved()).toBeNull();
    expect(noVault.saved()).toBeNull();
  });

  it('a server whose identity changed while pairing gets nothing saved', async () => {
    const h = harness({ reply: { serverId: 's1', serverKey: 'other' } });
    await expect(h.relay.enable()).rejects.toThrow(/identity/);
    expect(h.saved()).toBeNull();
    expect(h.served).toEqual([]);
  });

  it('connected and disconnected show in the status the window gets', async () => {
    const h = harness();
    await h.relay.enable();
    h.served[0]!.log('connected as box');
    expect(h.relay.status().connected).toBe(true);
    h.served[0]!.log('disconnected: gone');
    expect(h.notes.filter(([c]) => c === 'relay:status').map(([, p]) => (p as { connected: boolean }).connected)).toContain(true);
    expect(h.relay.status().connected).toBe(false);
  });

  it('a server that refuses the device says so', async () => {
    const h = harness();
    await h.relay.enable();
    h.finish('refused');
    await vi.waitFor(() => expect(h.relay.status().error).toMatch(/no longer accepts/));
  });
});

describe('across restarts', () => {
  it('serves again at start only if left on, and an unreadable key is reported, not served', () => {
    const off = harness({ stored: pairedDevice(false) });
    off.relay.resume();
    expect(off.served).toEqual([]);
    const on = harness({ stored: pairedDevice(true) });
    on.relay.resume();
    expect(on.served).toHaveLength(1);
    const broken = harness({ stored: { ...pairedDevice(true), privateKeyEnc: 'garbage' } });
    broken.relay.resume();
    expect(broken.served).toEqual([]);
    expect(broken.relay.status().error).toMatch(/could not be read/);
  });
});

describe('the question in the app', () => {
  const ask = (h: ReturnType<typeof harness>, signal = new AbortController().signal) =>
    h.served[0]!.askUser({ runId: 'run-1', expiresAt: Date.now() + 60_000, signal });
  const askId = (h: ReturnType<typeof harness>) => (h.notes.filter(([c]) => c === 'relay:ask').at(-1)![1] as { id: number }).id;

  it('the sites typed are the consent; a bad answer is asked again; empty is no', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    const first = ask(h);
    const id = askId(h);
    expect(h.relay.answer(id, 'file:///etc/passwd')).toMatchObject({ error: expect.any(String) });
    expect(h.relay.answer(id, 'example.com')).toEqual({ ok: true });
    expect([...(await first)!.allowedOrigins]).toEqual(['https://example.com']);
    expect(h.notes).toContainEqual(['relay:ask-closed', { id }]);
    expect(h.relay.answer(id, 'example.com')).toEqual({ error: 'This request is over.' });
    const second = ask(h);
    h.relay.answer(askId(h), '  ');
    await expect(second).resolves.toBeNull();
  });

  it('a run that ends while asking, turning it off, or quitting closes the question with a no', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    const stop = new AbortController();
    const a = ask(h, stop.signal);
    stop.abort();
    await expect(a).resolves.toBeNull();
    const b = ask(h);
    h.relay.disable();
    await expect(b).resolves.toBeNull();
    expect(h.saved()!.enabled).toBe(false);
    h.relay.resume();
    expect(h.served).toHaveLength(1);
  });
});

describe('forgetting', () => {
  it('removes the device on the server and the key here, and stops serving', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    const s = await h.relay.forget();
    expect(h.removed).toEqual(['dev-1']);
    expect(h.saved()).toBeNull();
    expect(s).toMatchObject({ paired: false, enabled: false });
    expect(h.served[0]!.signal.aborted).toBe(true);
  });
});

describe("the pairing's account", () => {
  it('signing out stops serving and ends a question; signing back in serves again', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    const asked = h.served[0]!.askUser({ runId: 'r', expiresAt: Date.now() + 60_000, signal: new AbortController().signal });
    h.signIn(null);
    h.relay.accountChanged();
    expect(h.served[0]!.signal.aborted).toBe(true);
    await expect(asked).resolves.toBeNull();
    expect(h.relay.status()).toMatchObject({ enabled: true, connected: false, error: expect.stringContaining('Sign in') });
    h.signIn('user-a');
    h.relay.accountChanged();
    expect(h.served).toHaveLength(2);
    expect(h.relay.status().error).toBeNull();
  });

  it("another account signed in neither resumes it, nor turns it on, nor removes it from that account", async () => {
    const h = harness({ stored: pairedDevice(true), account: 'user-b' });
    h.relay.resume();
    expect(h.served).toEqual([]);
    expect(h.relay.status().error).toMatch(/another Cascade Cloud account/);
    await expect(h.relay.enable()).rejects.toThrow(/another Cascade Cloud account/);
    expect(h.registered).toEqual([]);
    await h.relay.forget();
    expect(h.removed).toEqual([]);
    expect(h.saved()).toBeNull();
  });
});

describe('taking over the run window', () => {
  function lease() {
    let state = 'held';
    return { state: () => state, suspend: vi.fn(() => { state = 'suspended'; }), handBack: vi.fn(() => { state = 'held'; }) };
  }

  it('pauses the run and brings its window forward; hand back lets it carry on', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    const l = lease();
    h.served[0]!.onClient!({ lease: () => l });
    expect(h.relay.takeOver()).toEqual({ error: expect.stringContaining('No run') });
    const run = await h.served[0]!.startBrowser({} as never);
    expect(h.relay.takeOver()).toEqual({ ok: true });
    expect(l.suspend).toHaveBeenCalledTimes(1);
    expect(opened.windows.at(-1)!.focus).toHaveBeenCalled();
    expect(h.relay.status()).toMatchObject({ run: true, takenOver: true });
    expect(h.relay.takeOver()).toMatchObject({ error: expect.any(String) });
    expect(h.relay.handBack()).toEqual({ ok: true });
    expect(l.handBack).toHaveBeenCalledTimes(1);
    expect(h.relay.status().takenOver).toBe(false);
    expect(h.relay.handBack()).toMatchObject({ error: expect.stringContaining('not paused') });
    await run.close();
    expect(h.relay.status()).toMatchObject({ run: false, takenOver: false });
  });

  it('a closed connection has no lease to take', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    h.served[0]!.onClient!({ lease: () => lease() });
    await h.served[0]!.startBrowser({} as never);
    h.served[0]!.onClient!(null);
    expect(h.relay.takeOver()).toMatchObject({ error: expect.any(String) });
  });
});

describe('pairing while the account changes', () => {
  it('a sign-out while registering saves nothing, serves nothing, and takes the device back', async () => {
    let open!: () => void;
    const h = harness({ gate: new Promise<void>((r) => { open = r; }) });
    const enabling = h.relay.enable();
    await vi.waitFor(() => expect(h.registered).toHaveLength(1));
    h.signIn(null);
    h.relay.accountChanged();
    open();
    await expect(enabling).rejects.toThrow(/signed out or changed account/);
    expect(h.saved()).toBeNull();
    expect(h.served).toEqual([]);
    expect(h.removed).toEqual(['dev-1']);
  });

  it('two clicks pair once', async () => {
    const h = harness();
    await Promise.all([h.relay.enable(), h.relay.enable()]);
    expect(h.registered).toHaveLength(1);
  });
});

describe("the run's hint, any public site, and showing the window", () => {
  it('the question carries the site the run starts on; any public site is an answer of its own', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    const asked = h.served[0]!.askUser({ runId: 'r', expiresAt: Date.now() + 60_000, signal: new AbortController().signal, hint: { sites: ['www.rtings.com'] } });
    const ask = h.notes.filter(([c]) => c === 'relay:ask').at(-1)![1] as { id: number; sites: string[] };
    expect(ask.sites).toEqual(['www.rtings.com']);
    expect(h.relay.answer(ask.id, '', true)).toEqual({ ok: true });
    await expect(asked).resolves.toEqual({ allowedOrigins: [], privateOrigins: [], anyPublic: true, maxTabs: 1 });
  });

  it('the browsers-at-once choice goes with the answer, within one to eight', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    for (const [picked, given] of [[3, 3], [20, 8], [0, 1]] as const) {
      const asked = h.served[0]!.askUser({ runId: 'r', expiresAt: Date.now() + 60_000, signal: new AbortController().signal });
      const ask = h.notes.filter(([c]) => c === 'relay:ask').at(-1)![1] as { id: number };
      expect(h.relay.answer(ask.id, 'example.com', false, false, picked)).toEqual({ ok: true });
      await expect(asked).resolves.toMatchObject({ maxTabs: given });
    }
  });

  it('screenshots go with an answer only when ticked', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    const start = () => {
      const asked = h.served[0]!.askUser({ runId: 'r', expiresAt: Date.now() + 60_000, signal: new AbortController().signal });
      return { asked, id: (h.notes.filter(([c]) => c === 'relay:ask').at(-1)![1] as { id: number }).id };
    };
    const yes = start();
    expect(h.relay.answer(yes.id, 'example.com', false, true)).toEqual({ ok: true });
    await expect(yes.asked).resolves.toMatchObject({ screenshots: true });
    const no = start();
    h.relay.answer(no.id, 'example.com');
    expect(await no.asked).not.toHaveProperty('screenshots');
  });

  it('nothing typed and nothing ticked is still a no', async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    const asked = h.served[0]!.askUser({ runId: 'r', expiresAt: Date.now() + 60_000, signal: new AbortController().signal });
    const ask = h.notes.filter(([c]) => c === 'relay:ask').at(-1)![1] as { id: number };
    h.relay.answer(ask.id, '  ', false);
    await expect(asked).resolves.toBeNull();
  });

  it("Show the window brings the run's window forward, when there is one", async () => {
    const h = harness({ stored: pairedDevice(true) });
    h.relay.resume();
    h.served[0]!.onFocus!();
    await h.served[0]!.startBrowser({} as never);
    h.served[0]!.onFocus!();
    expect(opened.windows.at(-1)!.focus).toHaveBeenCalledTimes(1);
  });
});
