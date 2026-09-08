// ─────────────────────────────────────────────
//  Cascade Cloud — attaching a browser to a hosted run
// ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachRemoteBrowser, asWatchOnlyViewer, resetSharedBrowser, sharedBrowserGeneration } from './remote-browser.js';
import { Cascade, type CascadeConfig } from '#cascade-ai';

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
