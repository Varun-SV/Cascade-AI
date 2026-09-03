// ─────────────────────────────────────────────
//  Cascade Cloud — attaching a browser to a hosted run
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { attachRemoteBrowser, withViewerControls } from './remote-browser.js';

/** A Cascade stand-in that records what was wired to it. */
function fakeCascade() {
  const handlers = new Map<string, (e: unknown) => void>();
  const wired: Array<{ controller: unknown; release: unknown }> = [];
  return {
    handlers,
    wired,
    cascade: {
      on: (event: string, fn: (e: unknown) => void) => { handlers.set(event, fn); },
      setBrowserController: (controller: unknown, release: unknown) => { wired.push({ controller, release }); },
    } as never,
  };
}

const emits: Array<{ event: string; payload: Record<string, unknown> }> = [];
const emit = (event: string, payload: unknown) => { emits.push({ event, payload: payload as Record<string, unknown> }); };

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
  it('registers the controller and a worker-release hook', () => {
    const { cascade, wired } = fakeCascade();
    const attached = attachRemoteBrowser({
      cascade, conversationId: 'c1', emit,
      config: { tools: { remoteBrowser: { provider: 'cdp', url: 'ws://browser.test:9222' } } },
    });
    expect(attached).not.toBeNull();
    expect(wired).toHaveLength(1);
    // Both halves: without the release, ownership would fall back to a timer,
    // and no fixed timer is safe for a worker that may be waiting on a human.
    expect(typeof wired[0]?.controller).toBe('function');
    expect(typeof wired[0]?.release).toBe('function');
  });

  it('learns the run id when the run STARTS, not when it ends', () => {
    // A run that throws is exactly the one whose session must be released, and
    // no result is available on that path.
    const { cascade, handlers } = fakeCascade();
    attachRemoteBrowser({
      cascade, conversationId: 'c1', emit,
      config: { tools: { remoteBrowser: { provider: 'cdp', url: 'ws://browser.test:9222' } } },
    });
    expect(handlers.has('run:started'), 'subscribed before the run can fail').toBe(true);
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
