import { describe, expect, it, vi } from 'vitest';
import { historyIsSafe, endPageActivity, policeChild } from './request-enforcer.js';
import { makeConsent } from './egress-rules.js';

/** A CDP client that fails the named steps, and records the order of the rest. */
function fakeClient(failing: string[] = []) {
  const calls: string[] = [];
  const send = vi.fn(async (method: string) => {
    calls.push(method);
    if (failing.includes(method)) throw new Error(`${method} failed`);
    return {};
  });
  return { send, calls };
}
const OWNED = new Set(['sw', 'shw']);
const RESUME = 'Runtime.runIfWaitingForDebugger';

describe('a child target runs only if every setup step succeeded', () => {
  it.each(['page', 'iframe', 'shared_worker', 'service_worker', 'other', 'worker'])('%s: all steps succeed, resumed last', async (type) => {
    const c = fakeClient();
    expect(await policeChild(c, 's', type)).toBe('own-interception');
    expect(c.calls).toEqual(['Fetch.enable', 'Target.setAutoAttach', RESUME]);
  });
  it.each(['iframe', 'shared_worker', 'service_worker', 'other', 'page'])('%s: interception failing is never resumed', async (type) => {
    const c = fakeClient(['Fetch.enable']);
    expect(await policeChild(c, 's', type)).toBeNull();
    expect(c.calls).not.toContain(RESUME);
  });
  it('a dedicated worker alone may rely on its parent frame', async () => {
    const c = fakeClient(['Fetch.enable']);
    expect(await policeChild(c, 's', 'worker')).toBe('parent-interception');
    expect(c.calls).toContain(RESUME);
  });
  it.each(['worker', 'iframe', 'shared_worker', 'service_worker'])('%s: auto-attach failing is never resumed', async (type) => {
    const c = fakeClient(['Target.setAutoAttach']);
    expect(await policeChild(c, 's', type)).toBeNull();
    expect(c.calls).not.toContain(RESUME);
  });
  it('a resume that fails counts as not policed, for the caller to close', async () => {
    expect(await policeChild(fakeClient([RESUME]), 's', 'iframe')).toBeNull();
  });
  it('a dedicated worker with both interception and auto-attach failing is refused', async () => {
    const c = fakeClient(['Fetch.enable', 'Target.setAutoAttach']);
    expect(await policeChild(c, 's', 'worker')).toBeNull();
    expect(c.calls).not.toContain(RESUME);
  });
});

describe('the page step of a revoke always finishes, and ends the tab', () => {
  const NEVER = new Promise<never>(() => {});
  /** Answers by method: 'hang', 'fail', or a result. */
  function cdp(behaviour: Record<string, 'hang' | 'fail' | object> = {}) {
    const calls: { method: string; targetId?: unknown }[] = [];
    const send = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      calls.push({ method, targetId: params.targetId });
      const b = behaviour[method];
      if (b === 'hang') return NEVER;
      if (b === 'fail') throw new Error(`${method} failed`);
      return (b ?? {}) as Record<string, unknown>;
    };
    return { send, calls };
  }
  const TAB = 'the-tab';
  const closed = (c: ReturnType<typeof cdp>): unknown[] => c.calls.filter((x) => x.method === 'Target.closeTarget').map((x) => x.targetId);
  const WORKERS = { 'Target.getTargets': { targetInfos: [
    { targetId: 'sw', type: 'service_worker' }, { targetId: 'shw', type: 'shared_worker' }, { targetId: 'w', type: 'worker' }, { targetId: TAB, type: 'page' },
  ] } };

  it('blank: closes shared and service workers, leaves the tab open on about:blank', async () => {
    const tab = cdp(); const browser = cdp(WORKERS);
    expect(await endPageActivity(tab, browser, TAB, 'blank', OWNED, 20)).toBe(true);
    expect(closed(browser)).toEqual(['sw', 'shw']);
    expect(tab.calls.map((c) => c.method)).toEqual(['Page.navigate']);
  });
  it('close: closes the workers and the tab, without navigating', async () => {
    const tab = cdp(); const browser = cdp(WORKERS);
    expect(await endPageActivity(tab, browser, TAB, 'close', OWNED, 20)).toBe(true);
    expect(closed(browser)).toEqual(['sw', 'shw', TAB]);
    expect(tab.calls).toEqual([]);
  });
  it.each(['net::ERR_ABORTED', 'net::ERR_FAILED'])('blank: a navigation that answers with %s did not happen, so the tab is closed instead', async (errorText) => {
    const browser = cdp();
    const tab = cdp({ 'Page.navigate': { frameId: 'f', errorText } });
    expect(await endPageActivity(tab, browser, TAB, 'blank', OWNED, 20)).toBe(true);
    expect(closed(browser)).toEqual([TAB]);
  });
  it('blank: a navigation that answers with an error, and a tab that then will not close, is not confirmed', async () => {
    const tab = cdp({ 'Page.navigate': { errorText: 'net::ERR_ABORTED' } });
    expect(await endPageActivity(tab, cdp({ 'Target.closeTarget': 'fail' }), TAB, 'blank', OWNED, 20)).toBe(false);
  });
  it('blank: a clean answer with no errorText leaves the tab open', async () => {
    const browser = cdp();
    expect(await endPageActivity(cdp({ 'Page.navigate': { frameId: 'f', loaderId: 'l' } }), browser, TAB, 'blank', OWNED, 20)).toBe(true);
    expect(closed(browser)).toEqual([]);
  });
  it.each(['hang', 'fail'] as const)('blank: a navigation that will %s closes the tab instead', async (how) => {
    const browser = cdp();
    expect(await endPageActivity(cdp({ 'Page.navigate': how }), browser, TAB, 'blank', OWNED, 20)).toBe(true);
    expect(closed(browser)).toEqual([TAB]);
  });
  it.each(['hang', 'fail'] as const)('listing the workers will %s: the tab still ends', async (how) => {
    const tab = cdp(); const browser = cdp({ 'Target.getTargets': how });
    expect(await endPageActivity(tab, browser, TAB, 'blank', OWNED, 20)).toBe(true);
    expect(tab.calls.map((c) => c.method)).toEqual(['Page.navigate']);
    const browser2 = cdp({ 'Target.getTargets': how });
    expect(await endPageActivity(cdp(), browser2, TAB, 'close', OWNED, 20)).toBe(true);
    expect(closed(browser2)).toEqual([TAB]);
  });
  it.each(['hang', 'fail'] as const)('a close that will %s is reported as unconfirmed, not success', async (how) => {
    const browser = cdp({ 'Target.closeTarget': how });
    expect(await endPageActivity(cdp({ 'Page.navigate': 'hang' }), browser, TAB, 'blank', OWNED, 20)).toBe(false);
    expect(await endPageActivity(cdp(), cdp({ 'Target.closeTarget': how }), TAB, 'close', OWNED, 20)).toBe(false);
  });
});

describe('historyIsSafe', () => {
  const consent = makeConsent(['https://ok.test']);
  const entry = (url: string) => ({ id: 1, url });
  it.each<[string, unknown]>([
    ['no reply', undefined], ['null', null], ['no entries', { currentIndex: 0 }], ['empty entries', { currentIndex: 0, entries: [] }],
    ['entries not a list', { currentIndex: 0, entries: {} }], ['no index', { entries: [entry('about:blank')] }],
    ['index past the end', { currentIndex: 1, entries: [entry('about:blank')] }], ['negative index', { currentIndex: -1, entries: [entry('about:blank')] }],
    ['an entry with no URL', { currentIndex: 0, entries: [{ id: 1 }] }], ['an empty URL', { currentIndex: 0, entries: [entry('')] }],
    ['a null entry', { currentIndex: 0, entries: [null] }],
    ['an entry on another site', { currentIndex: 0, entries: [entry('https://ok.test/'), entry('https://offlist.test/')] }],
  ])('refuses %s', (_n, reply) => { expect(historyIsSafe(reply, consent)).toBe(false); });
  it('accepts a well-formed history on consented sites', () => {
    expect(historyIsSafe({ currentIndex: 1, entries: [entry('about:blank'), entry('https://ok.test/a')] }, consent)).toBe(true);
  });
});

describe('a revoke closes only workers the lease saw start', () => {
  it('leaves other workers alone, and still ends the tab', async () => {
    const closed: string[] = [];
    const browser = { send: async (m: string, p?: { targetId?: string }) => {
      if (m === 'Target.getTargets') return { targetInfos: [{ targetId: 'mine', type: 'service_worker' }, { targetId: 'theirs', type: 'service_worker' }, { targetId: 'theirs2', type: 'shared_worker' }, { targetId: 'mine2', type: 'shared_worker' }] };
      if (m === 'Target.closeTarget') closed.push(p!.targetId!);
      return {};
    } };
    expect(await endPageActivity({ send: async () => ({}) }, browser as never, 'tab', 'close', new Set(['mine', 'mine2']))).toBe(true);
    expect(closed.sort()).toEqual(['mine', 'mine2', 'tab']);
  });
});
