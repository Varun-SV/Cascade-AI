// ─────────────────────────────────────────────
//  Cascade Cloud — a hosted run on the user's own browser
// ─────────────────────────────────────────────
//
//  The wiring only. That a controller drives a real browser through the relay,
//  fill and click included, is shown with Chromium in the SDK's own suite
//  (src/browser/relay/device.browser.test.ts), which CI runs with a browser.

import { describe, it, expect, vi } from 'vitest';
import { attachRemoteBrowser, ON_DEVICE_ONLY, providerRationsSessions, type RelayForRun } from './remote-browser.js';
import { buildCloudConfig, relayBrowserControls, relayForRun } from './runs.js';
import type { BrowserRelay } from './browser-relay.js';
import type { CloudEnv } from './env.js';
import type { RelayDevice } from './db.js';
import { RelayRefused, type RelayHub } from '#cascade-ai';

function fakeCascade() {
  const handlers = new Map<string, (e: unknown) => void>();
  const wired: Array<{ controller: (a: unknown, ctx: unknown) => Promise<{ ok: boolean; detail: string }>; features: Record<string, boolean> }> = [];
  return {
    handlers,
    wired,
    cascade: {
      on: (event: string, fn: (e: unknown) => void) => { handlers.set(event, fn); },
      setRemoteBrowserController: (controller: never, _release: unknown, features: Record<string, boolean>) => { wired.push({ controller, features }); },
    } as never,
  };
}

/** A hub whose device always declines, recording who was asked. */
function decliningHub() {
  const asked: Array<{ userId: string; deviceId: string; runId: string }> = [];
  const ended: string[] = [];
  const hub = {
    requestBrowser: vi.fn(async (r: { userId: string; deviceId: string; runId: string }) => {
      asked.push({ userId: r.userId, deviceId: r.deviceId, runId: r.runId });
      throw new RelayRefused('the user declined on the device');
    }),
    endRun: (runId: string) => { ended.push(runId); },
    deviceOnline: () => true,
  } as unknown as RelayHub;
  return { hub, asked, ended };
}

const relayFor = (hub: RelayHub): RelayForRun => ({
  hub, agentUrl: (t) => `ws://127.0.0.1:1/agent/${t}`, userId: 'user-a', device: { id: 'dev-1', name: 'Work laptop' },
});
const relaySettings = { tools: { remoteBrowser: { provider: 'relay' as const, maxSessions: 1 } } };

describe("a run on the user's own browser", () => {
  it('attaches nothing when the server has no relay, and says why', () => {
    const warn = vi.fn();
    const { cascade, wired } = fakeCascade();
    expect(attachRemoteBrowser({ cascade, config: relaySettings, conversationId: 'c1', emit: () => {}, warn })).toBeNull();
    expect(wired).toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toMatch(/relay/);
  });

  it("asks the chosen device of the run's own user, and the refusal reaches the model", async () => {
    const { hub, asked } = decliningHub();
    const { cascade, wired, handlers } = fakeCascade();
    const attached = attachRemoteBrowser({ cascade, config: relaySettings, conversationId: 'c1', emit: () => {}, relay: relayFor(hub) });
    expect(attached).not.toBeNull();
    handlers.get('run:started')!({ taskId: 't1' });
    const out = await wired[0]!.controller({ kind: 'navigate', url: 'https://example.com/' }, { sessionId: 't1', actorId: 'w1' });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('declined on the device');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ userId: 'user-a', deviceId: 'dev-1' });
    expect(asked[0]!.runId.startsWith('c1:')).toBe(true);
    await attached!.endRun();
  });

  it('claims no allowance: the browser is the user\'s, and costs nobody a session', async () => {
    const { hub } = decliningHub();
    const take = vi.fn(() => ({ refusal: 'none left today' }));
    const { cascade, wired, handlers } = fakeCascade();
    const attached = attachRemoteBrowser({ cascade, config: relaySettings, conversationId: 'c1', emit: () => {}, relay: relayFor(hub), allowance: { take } as never });
    handlers.get('run:started')!({ taskId: 't1' });
    await wired[0]!.controller({ kind: 'navigate', url: 'https://example.com/' }, { sessionId: 't1', actorId: 'w1' });
    expect(take).not.toHaveBeenCalled();
    expect(providerRationsSessions({ provider: 'relay', maxSessions: 1 }, 'hosted')).toBe(false);
    await attached!.endRun();
  });

  it('reads pages, but offers no screenshots: no picture of the page leaves the device', () => {
    const { hub } = decliningHub();
    const { cascade, wired } = fakeCascade();
    attachRemoteBrowser({ cascade, config: relaySettings, conversationId: 'c1', emit: () => {}, relay: relayFor(hub) });
    expect(wired[0]!.features).toMatchObject({ screenshots: false, marked: false });
  });

  it('watching, taking over and input from the web are refused plainly: those are done on the device', async () => {
    const { hub } = decliningHub();
    const { cascade, handlers } = fakeCascade();
    const attached = attachRemoteBrowser({ cascade, config: relaySettings, conversationId: 'c1', emit: () => {}, relay: relayFor(hub) })!;
    handlers.get('run:started')!({ taskId: 't1' });
    expect(await attached.watch()).toBe(false);
    expect(await attached.takeOver()).toEqual({ ok: false, detail: ON_DEVICE_ONLY });
    expect(await attached.input({ kind: 'key', key: 'a' } as never)).toEqual({ ok: false, detail: ON_DEVICE_ONLY });
    expect(attached.handBack()).toBe(false);
    expect(await attached.setCapture(true)).toBe(false);
    await attached.endRun();
  });

  it('each attach is its own controller, so two runs never share a device tab', async () => {
    const { hub, asked } = decliningHub();
    const a = fakeCascade();
    const b = fakeCascade();
    attachRemoteBrowser({ cascade: a.cascade, config: relaySettings, conversationId: 'c1', emit: () => {}, relay: relayFor(hub) });
    attachRemoteBrowser({ cascade: b.cascade, config: relaySettings, conversationId: 'c1', emit: () => {}, relay: relayFor(hub) });
    expect(a.wired[0]!.controller).not.toBe(b.wired[0]!.controller);
    a.handlers.get('run:started')!({ taskId: 't1' });
    b.handlers.get('run:started')!({ taskId: 't2' });
    await a.wired[0]!.controller({ kind: 'navigate', url: 'https://example.com/' }, { sessionId: 't1', actorId: 'w1' });
    await b.wired[0]!.controller({ kind: 'navigate', url: 'https://example.com/' }, { sessionId: 't2', actorId: 'w1' });
    expect(new Set(asked.map((x) => x.runId)).size).toBe(2);
  });
});

describe('which device serves a run', () => {
  const device = (id: string, lastSeenAt: number | null): RelayDevice => ({ id, userId: 'user-a', name: `name-${id}`, kind: 'extension', publicKey: 'k', createdAt: 0, lastSeenAt });
  const relay = (online: string[]) => ({
    hub: { deviceOnline: (_u: string, id: string) => online.includes(id) },
    ready: Promise.resolve(),
    agentUrl: (t: string) => `ws://127.0.0.1:1/agent/${t}`,
  }) as unknown as BrowserRelay;
  const store = { listRelayDevices: () => [device('old', 10), device('new', 30), device('offline', 50)] };

  it('none online: no own browser, and the run falls back to what the deployment has', async () => {
    expect(await relayForRun(relay([]), store, 'user-a')).toBeNull();
  });

  it('the one seen last among those online, never an offline one', async () => {
    expect((await relayForRun(relay(['old', 'new']), store, 'user-a'))?.device).toEqual({ id: 'new', name: 'name-new' });
  });

  it('the one the user picked, when it is online', async () => {
    expect((await relayForRun(relay(['old', 'new']), store, 'user-a', 'old'))?.device.id).toBe('old');
  });

  it("a pick that is offline, or isn't theirs, is not honoured", async () => {
    expect((await relayForRun(relay(['old', 'new']), store, 'user-a', 'offline'))?.device.id).toBe('new');
    expect((await relayForRun(relay(['old', 'new']), store, 'user-a', 'someone-elses'))?.device.id).toBe('new');
  });
});

describe("the run's config, with the user's own browser", () => {
  it('names the relay as its provider only when the turn asked for the browser', () => {
    const env = {} as CloudEnv;
    expect(buildCloudConfig([], 0.5, { browserMode: true, ...relayBrowserControls(env) }).tools.remoteBrowser).toMatchObject({ provider: 'relay', maxSessions: 1 });
    expect(buildCloudConfig([], 0.5, { browserMode: false, ...relayBrowserControls(env) }).tools.remoteBrowser).toBeUndefined();
  });
});
