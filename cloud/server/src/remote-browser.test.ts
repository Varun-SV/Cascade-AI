// ─────────────────────────────────────────────
//  Cascade Cloud — attaching a browser to a hosted run
// ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachRemoteBrowser, asWatchOnlyViewer, frameEmitter, formatCeiling, resetSharedBrowser, sharedBrowserGeneration } from './remote-browser.js';
import { Cascade, RemoteBrowserController, type CascadeConfig } from '#cascade-ai';

/**
 * A REAL Cascade, because the fake below is what let a shipped bug through.
 *
 * The registration tests used a stub whose setBrowserController always
 * recorded the call. Production's gate returns early unless the capability is
 * enabled, so the stub recorded a registration that never happened and the
 * hosted tool was absent in every deployment while these tests passed. Any
 * test that claims the tool IS registered has to ask the real registry.
 */
function realCascade(remoteBrowser?: Record<string, unknown>) {
  const config = {
    version: '1.0', defaultIdentityId: 'default', providers: [], models: {},
    tools: {
      shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [],
      browserEnabled: false, ...(remoteBrowser ? { remoteBrowser } : {}),
    },
    hooks: {}, dashboard: { port: 4899, auth: false, teamMode: 'single' },
    telemetry: { enabled: false },
    memory: { maxSessionMessages: 10, autoSummarizeAt: 1000, retentionDays: 1 },
    theme: 'cascade',
    workspace: {
      cascadeMdPath: 'CASCADE.md', configPath: '.cascade/config.json',
      keystorePath: '.cascade/keystore.enc', auditLogPath: '.cascade/audit.log',
    },
  } as unknown as CascadeConfig;
  return { cascade: new Cascade(config, '/tmp'), config };
}

/** A Cascade stand-in that records what was wired to it. */
function fakeCascade() {
  const handlers = new Map<string, (e: unknown) => void>();
  const wired: Array<{ controller: unknown; release: unknown }> = [];
  return {
    handlers,
    wired,
    cascade: {
      on: (event: string, fn: (e: unknown) => void) => { handlers.set(event, fn); },
      setRemoteBrowserController: (controller: unknown, release: unknown) => { wired.push({ controller, release }); },
    } as never,
  };
}

const emits: Array<{ event: string; payload: Record<string, unknown> }> = [];
const emit = (event: string, payload: unknown) => { emits.push({ event, payload: payload as Record<string, unknown> }); };

// The controller is deployment-scoped now, so it survives between tests unless
// this runs — and a leaked one would make the next test's pool already full.
beforeEach(async () => { emits.length = 0; await resetSharedBrowser(); });

describe('a deployment with no provider configured', () => {
  it('attaches nothing at all', () => {
    // The default. There is no capability to switch off because none exists
    // until an endpoint is supplied.
    const { cascade, wired } = fakeCascade();
    const attached = attachRemoteBrowser({ cascade, config: {}, conversationId: 'c1', emit });
    expect(attached).toBeNull();
    expect(wired, 'and the tool is never registered').toEqual([]);
  });

  it('refuses a cdp provider with no endpoint, and says why', () => {
    const warn = vi.fn();
    const { cascade } = fakeCascade();
    const attached = attachRemoteBrowser({
      cascade, conversationId: 'c1', emit, warn,
      config: { tools: { remoteBrowser: { provider: 'cdp' } } },
    });
    expect(attached).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toMatch(/ws:\/\//);
  });

  it('refuses an http endpoint, which is the likely paste', () => {
    // Named here rather than surfacing as an obscure Playwright failure on the
    // first action.
    const warn = vi.fn();
    const { cascade } = fakeCascade();
    const attached = attachRemoteBrowser({
      cascade, conversationId: 'c1', emit, warn,
      config: { tools: { remoteBrowser: { provider: 'cdp', url: 'https://browser.test' } } },
    });
    expect(attached).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('refuses the hosted Steel API with no credential', () => {
    // Both earlier fixes to this asked "is the URL valid" — and an ABSENT url
    // is valid, because it means the hosted API. But falling back to
    // api.steel.dev with no key builds a provider that advertises a Browser
    // control and then fails authentication on the first request, which is the
    // inert control those fixes existed to remove, in its third shape.
    const warn = vi.fn();
    const { cascade } = fakeCascade();
    const attached = attachRemoteBrowser({
      cascade, conversationId: 'c1', emit, warn,
      config: { tools: { remoteBrowser: { provider: 'steel' } } },
    });
    expect(attached).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toMatch(/apiKey/);
  });

  it('allows a self-hosted Steel with no credential', () => {
    // Only the FALLBACK is refused. A Steel behind a private network or its
    // own gateway legitimately has no key, and requiring one for a URL the
    // operator typed would break a working deployment to guard a default.
    const { cascade } = fakeCascade();
    const attached = attachRemoteBrowser({
      cascade, conversationId: 'c1', emit,
      config: { tools: { remoteBrowser: { provider: 'steel', url: 'https://steel.internal' } } },
    });
    expect(attached).not.toBeNull();
  });
});

describe('a configured deployment', () => {
  it('actually registers browser_control on a real Cascade', () => {
    // The test that would have caught the shipped bug. attachRemoteBrowser was
    // calling setBrowserController, which gates on the DESKTOP flag — default
    // false, never set on a server — so the tool was never registered at all.
    // Asserting against the real registry is the only version of this test
    // that means anything.
    const remoteBrowser = { provider: 'cdp', url: 'ws://browser.test:9222' };
    const { cascade, config } = realCascade(remoteBrowser);

    const attached = attachRemoteBrowser({ cascade, config, conversationId: 'c1', emit });

    expect(attached).not.toBeNull();
    expect(cascade.getToolRegistry().hasTool('browser_control'), 'the model can actually call it').toBe(true);
  });

  it('registers nothing on a real Cascade when no provider is configured', () => {
    const { cascade, config } = realCascade();
    attachRemoteBrowser({ cascade, config, conversationId: 'c1', emit });
    expect(cascade.getToolRegistry().hasTool('browser_control')).toBe(false);
  });

  it('subscribes to run:started before the run can fail', () => {
    // A run that throws is exactly the one whose session must be released, and
    // no result is available on that path.
    const { cascade, handlers } = fakeCascade();
    attachRemoteBrowser({
      cascade, conversationId: 'c1', emit,
      config: { tools: { remoteBrowser: { provider: 'cdp', url: 'ws://browser.test:9222' } } },
    });
    expect(handlers.has('run:started')).toBe(true);
  });
});

describe('the live view is a capability, and treated as one', () => {
  it('asks the viewer for a watch-only session', () => {
    // It used to ask for `interactive=true`, which made the frame a SECOND
    // controller: viewer input reaches the session over the provider's own
    // channel, never through BrowserLease, so a user "taking over" could edit
    // the page while a Playwright call was in flight and have the agent's
    // action land on top of their change. The panel promised exclusive control
    // and delivered concurrent control.
    const out = new URL(asWatchOnlyViewer('https://provider.test/live/abc'));
    expect(out.searchParams.get('interactive')).toBe('false');
    expect(out.searchParams.get('showControls')).toBe('false');
  });

  it('keeps the credential the provider put in the URL', () => {
    // The live-view URL carries its own session credential. Rebuilding it from
    // scratch would drop the one thing that makes it work.
    const out = new URL(asWatchOnlyViewer('https://provider.test/live/abc?token=xyz'));
    expect(out.searchParams.get('token')).toBe('xyz');
    expect(out.searchParams.get('interactive')).toBe('false');
  });

  // There is deliberately NO end-to-end "the announcement carries a watch-only
  // URL" test here. The one written first passed against the reverted code: it
  // drove `run:started` without opening a session, so no live-view URL was ever
  // announced and its loop asserted nothing. Reaching a real announcement needs
  // the shared controller, which is module-private on purpose — and exporting
  // it to satisfy a test would be a worse trade than relying on the single,
  // revert-checked call site above.

  it('hands back something unparseable rather than dropping it', () => {
    // Losing the only way the user has to watch is worse than a URL we did not
    // understand well enough to decorate.
    expect(asWatchOnlyViewer('not-a-url')).toBe('not-a-url');
  });

});

describe('the session pool is the deployment\'s, not one run\'s', () => {
  const cdp = { tools: { remoteBrowser: { provider: 'cdp' as const, url: 'ws://browser.test:9222' } } };

  it('shares one controller across separate attachments', async () => {
    // The shape production actually has: runChatTurnInner calls
    // attachRemoteBrowser per run. The earlier pool test put two run ids
    // through ONE controller, which production never does — so it proved a cap
    // that did not exist. Each run built its own controller with an empty
    // session map, so the cap counted to one and stopped and two concurrent
    // runs each opened a session at a configured limit of one.
    const a = realCascade(cdp.tools.remoteBrowser);
    const b = realCascade(cdp.tools.remoteBrowser);

    // The counter, not just "both attaches returned something" — that was true
    // whether the controller was shared or rebuilt per run, so the test passed
    // against the exact bug it names. One build across two attaches is the
    // property; two would mean each run got its own empty session map and the
    // cap counted to one and stopped.
    const before = sharedBrowserGeneration();
    const first = attachRemoteBrowser({ cascade: a.cascade, config: a.config, conversationId: 'c1', emit });
    const second = attachRemoteBrowser({ cascade: b.cascade, config: b.config, conversationId: 'c2', emit });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(sharedBrowserGeneration(), 'one controller, built once, for both runs').toBe(before + 1);
    // Both cascades got a working tool; what they share is the browser behind it.
    expect(a.cascade.getToolRegistry().hasTool('browser_control')).toBe(true);
    expect(b.cascade.getToolRegistry().hasTool('browser_control')).toBe(true);
  });

  it('rebuilds when the API key is rotated', async () => {
    // The case that made the first version wrong. Collapsing every credential
    // to "keyed" meant A -> B looked identical, so the shared provider went on
    // using a key that is usually being rotated BECAUSE it is being revoked.
    const a = realCascade({ provider: 'steel', url: 'https://steel.test', apiKey: 'key-A' });
    attachRemoteBrowser({ cascade: a.cascade, config: a.config, conversationId: 'c1', emit });
    const before = sharedBrowserGeneration();

    const b = realCascade({ provider: 'steel', url: 'https://steel.test', apiKey: 'key-B' });
    attachRemoteBrowser({ cascade: b.cascade, config: b.config, conversationId: 'c2', emit });

    // Observed, not assumed: attach returns an object either way, so asserting
    // it is non-null proved nothing and passed against the bug.
    expect(sharedBrowserGeneration(), 'a rotated key rebuilds the provider').toBe(before + 1);
  });

  it('does not rebuild when nothing changed', async () => {
    // The other direction matters too: rebuilding on every attach would throw
    // away the shared pool the whole change exists to create.
    const a = realCascade({ provider: 'steel', url: 'https://steel.test', apiKey: 'key-A' });
    attachRemoteBrowser({ cascade: a.cascade, config: a.config, conversationId: 'c1', emit });
    const before = sharedBrowserGeneration();

    const b = realCascade({ provider: 'steel', url: 'https://steel.test', apiKey: 'key-A' });
    attachRemoteBrowser({ cascade: b.cascade, config: b.config, conversationId: 'c2', emit });

    expect(sharedBrowserGeneration(), 'the pool is reused, which is the point').toBe(before);
  });

  it('rebuilds when the deployment\'s provider settings change', async () => {
    // Otherwise a settings change leaves the old provider's sessions running at
    // the operator's expense, with nothing left holding a reference to them.
    const a = realCascade({ provider: 'cdp', url: 'ws://one.test:9222' });
    attachRemoteBrowser({ cascade: a.cascade, config: a.config, conversationId: 'c1', emit });

    const before = sharedBrowserGeneration();
    const b = realCascade({ provider: 'cdp', url: 'ws://two.test:9222' });
    attachRemoteBrowser({ cascade: b.cascade, config: b.config, conversationId: 'c2', emit });

    expect(sharedBrowserGeneration(), 'a changed endpoint is a different browser').toBe(before + 1);
  });
});

// Frames are a picture of whatever the agent is looking at — a half-filled
// form, a page someone is signed into. They are exactly as sensitive as the
// live-view URL they replace, so who may ask for them, and where they go,
// matters as much as who may press Stop.
describe('where frames are sent', () => {
  it('prefers the lossy channel, and says so by falling back only when there is none', () => {
    // The fallback is the part that regresses silently: drop `emitFrame` and
    // frames quietly become reliable again, banking stale JPEGs behind a slow
    // viewer with nothing failing to say so.
    const reliable = vi.fn();
    const lossy = vi.fn();

    frameEmitter({ emit: reliable, emitFrame: lossy })('browser:frame', { a: 1 });
    expect(lossy).toHaveBeenCalledOnce();
    expect(reliable, 'a frame never takes the reliable path when a lossy one exists').not.toHaveBeenCalled();

    frameEmitter({ emit: reliable })('browser:frame', { a: 1 });
    expect(reliable, 'and a caller with no lossy channel still gets its frames').toHaveBeenCalledOnce();
  });
});

describe('asking to watch a run', () => {
  const cdp = { tools: { remoteBrowser: { provider: 'cdp' as const, url: 'ws://browser.test:9222' } } };

  it('sends frames to the run\'s own socket, tagged with the run they came from', async () => {
    const { cascade, config } = realCascade(cdp.tools.remoteBrowser);
    const handlers = new Map<string, (e: unknown) => void>();
    const on = (ev: string, fn: (e: unknown) => void) => { handlers.set(ev, fn); };
    (cascade as unknown as { on: typeof on }).on = on;

    const attached = attachRemoteBrowser({ cascade, config, conversationId: 'c1', emit });
    handlers.get('run:started')?.({ taskId: 't1' });
    expect(attached).not.toBeNull();

    // No browser has been opened, so there is nothing to stream — and saying
    // so is the point: a panel must never be promised frames that cannot come.
    emits.length = 0;
    expect(await attached!.watch()).toBe(false);
    expect(emits.filter((e) => e.event === 'browser:frame')).toEqual([]);
  });

  it('refuses to hand over a browser that is not there', async () => {
    // Every one of these is a control path a client can reach at any moment —
    // the panel is open while the run is still starting, or after it ended —
    // and each has to say no rather than throw into the socket handler.
    const { cascade, config } = realCascade(cdp.tools.remoteBrowser);
    const handlers = new Map<string, (e: unknown) => void>();
    (cascade as unknown as { on: (ev: string, fn: (e: unknown) => void) => void }).on =
      (ev, fn) => { handlers.set(ev, fn); };

    const attached = attachRemoteBrowser({ cascade, config, conversationId: 'c1', emit });
    handlers.get('run:started')?.({ taskId: 't1' });

    const over = await attached!.takeOver();
    expect(over.ok).toBe(false);
    expect(over.detail).toMatch(/no browser/i);

    const typed = await attached!.input({ kind: 'text', text: 'hello' });
    expect(typed.ok, 'and input is refused for the same reason').toBe(false);
    expect(attached!.handBack()).toBe(false);
    expect(await attached!.setCapture(true)).toBe(false);
  });

  it('is a no-op before the run has announced itself', async () => {
    // `taskId` is null until `run:started`. Watching then has no run to name,
    // and a frame with no task id could not be routed or discarded correctly.
    const { cascade, config } = realCascade(cdp.tools.remoteBrowser);
    const attached = attachRemoteBrowser({ cascade, config, conversationId: 'c1', emit });

    expect(attached!.taskId).toBeNull();
    expect(await attached!.watch()).toBe(false);
    await expect(attached!.unwatch()).resolves.toBeUndefined();
    // Control needs a run to name even more than watching does: an input event
    // with no task id could be applied to whichever run happened to be open.
    expect((await attached!.takeOver()).ok).toBe(false);
    expect((await attached!.input({ kind: 'click', x: 0.5, y: 0.5 })).ok).toBe(false);
    expect(attached!.handBack()).toBe(false);
    expect(await attached!.setCapture(true)).toBe(false);
  });
});

describe('a run refused the browser because every session is taken', () => {
  const cdp = { tools: { remoteBrowser: { provider: 'cdp' as const, url: 'ws://browser.test:9222' } } };

  /** Attach a run and announce it, capturing the busy listener the bridge registers. */
  function refusedRun() {
    const onBusy = vi.spyOn(RemoteBrowserController.prototype, 'onBusyFor');
    const offBusy = vi.spyOn(RemoteBrowserController.prototype, 'offBusyFor');
    const { cascade, config } = realCascade(cdp.tools.remoteBrowser);
    const handlers = new Map<string, (e: unknown) => void>();
    (cascade as unknown as { on: (ev: string, fn: (e: unknown) => void) => void }).on =
      (ev, fn) => { handlers.set(ev, fn); };
    const attached = attachRemoteBrowser({ cascade, config, conversationId: 'c1', emit });
    handlers.get('run:started')?.({ taskId: 't1' });
    const registered = onBusy.mock.calls.find(([id]) => id === 't1');
    return { attached: attached!, busy: registered?.[1], offBusy, restore: () => { onBusy.mockRestore(); offBusy.mockRestore(); } };
  }

  it('tells the run\u2019s own socket, naming the run and the limit it hit', () => {
    // The model heard about the refusal and nobody else did, so the person who
    // could act on it — by waiting for the other run — never knew.
    const { busy, restore } = refusedRun();
    try {
      expect(busy, 'registered under the run id when the run starts').toBeTypeOf('function');
      void busy!({ limit: 1 });
      expect(emits.filter((e) => e.event === 'browser:busy')).toEqual([
        { event: 'browser:busy', payload: { conversationId: 'c1', taskId: 't1', limit: 1 } },
      ]);
    } finally { restore(); }
  });

  it('says it once, however many times the run is refused', () => {
    // A worker told "busy" may well ask again; every refusal after the first
    // is the same news, and a banner per retry is noise.
    const { busy, restore } = refusedRun();
    try {
      void busy!({ limit: 1 });
      void busy!({ limit: 1 });
      void busy!({ limit: 1 });
      expect(emits.filter((e) => e.event === 'browser:busy')).toHaveLength(1);
    } finally { restore(); }
  });

  it('stops listening when the run ends', async () => {
    // The listener closes over this run's socket; the controller outlives it.
    // Detached by the controller's own run cleanup (forgetRun), which the
    // run's end reaches whether or not the run ever held a browser.
    const { attached, offBusy, restore } = refusedRun();
    try {
      await attached.endRun();
      expect(offBusy).toHaveBeenCalledWith('t1');
    } finally { restore(); }
  });
});

describe('the ceiling in a release-failure report', () => {
  it('keeps the seconds it was given', () => {
    // Rounding to the nearest minute was my own shortcut in the previous round
    // and it broke the one thing the number is for. A 30s ceiling read as
    // `1m`, and anything under 30s as `0m` — a session still running and
    // billable, reported as already collected.
    expect(formatCeiling(300_000), 'whole minutes stay whole').toBe('5m');
    expect(formatCeiling(30_000), 'not 1m').toBe('30s');
    expect(formatCeiling(5_000), 'not 0m').toBe('5s');
    expect(formatCeiling(90_000)).toBe('1m30s');
  });

  it('never reports a live session as already reaped', () => {
    // The floor is what makes the sentence safe to act on: whatever the
    // provider said, a session being reported is one that was still there.
    expect(formatCeiling(1)).toBe('1s');
  });
});
