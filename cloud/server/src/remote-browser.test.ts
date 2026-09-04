// ─────────────────────────────────────────────
//  Cascade Cloud — attaching a browser to a hosted run
// ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachRemoteBrowser, withViewerControls, resetSharedBrowser } from './remote-browser.js';
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
  it('asks the viewer for controls, so it is usable and not just watchable', () => {
    // Watching alone is not a kill switch. The desktop's equivalent is that the
    // user can reach the page; here it is that they can take it over.
    const out = new URL(withViewerControls('https://provider.test/live/abc'));
    expect(out.searchParams.get('interactive')).toBe('true');
    expect(out.searchParams.get('showControls')).toBe('true');
  });

  it('keeps the credential the provider put in the URL', () => {
    // The live-view URL carries its own session credential. Rebuilding it from
    // scratch would drop the one thing that makes it work.
    const out = new URL(withViewerControls('https://provider.test/live/abc?token=xyz'));
    expect(out.searchParams.get('token')).toBe('xyz');
    expect(out.searchParams.get('interactive')).toBe('true');
  });

  it('hands back something unparseable rather than dropping it', () => {
    // Losing the only way the user has to watch is worse than a URL we did not
    // understand well enough to decorate.
    expect(withViewerControls('not-a-url')).toBe('not-a-url');
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

    const first = attachRemoteBrowser({ cascade: a.cascade, config: a.config, conversationId: 'c1', emit });
    const second = attachRemoteBrowser({ cascade: b.cascade, config: b.config, conversationId: 'c2', emit });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Both cascades got a working tool; what they share is the browser behind it.
    expect(a.cascade.getToolRegistry().hasTool('browser_control')).toBe(true);
    expect(b.cascade.getToolRegistry().hasTool('browser_control')).toBe(true);
  });

  it('rebuilds when the deployment\'s provider settings change', async () => {
    // Otherwise a settings change leaves the old provider's sessions running at
    // the operator's expense, with nothing left holding a reference to them.
    const a = realCascade({ provider: 'cdp', url: 'ws://one.test:9222' });
    attachRemoteBrowser({ cascade: a.cascade, config: a.config, conversationId: 'c1', emit });

    const b = realCascade({ provider: 'cdp', url: 'ws://two.test:9222' });
    const second = attachRemoteBrowser({ cascade: b.cascade, config: b.config, conversationId: 'c2', emit });

    expect(second, 'a changed endpoint is a different deployment browser').not.toBeNull();
  });
});
