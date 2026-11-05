import { describe, expect, it, vi } from 'vitest';
import { endPageActivity, policeChild } from './request-enforcer.js';

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
    expect(await endPageActivity(tab, browser, TAB, 'blank', 20)).toBe(true);
    expect(closed(browser)).toEqual(['sw', 'shw']);
    expect(tab.calls.map((c) => c.method)).toEqual(['Page.navigate']);
  });
  it('close: closes the workers and the tab, without navigating', async () => {
    const tab = cdp(); const browser = cdp(WORKERS);
    expect(await endPageActivity(tab, browser, TAB, 'close', 20)).toBe(true);
    expect(closed(browser)).toEqual(['sw', 'shw', TAB]);
    expect(tab.calls).toEqual([]);
  });
  it.each(['hang', 'fail'] as const)('blank: a navigation that will %s closes the tab instead', async (how) => {
    const browser = cdp();
    expect(await endPageActivity(cdp({ 'Page.navigate': how }), browser, TAB, 'blank', 20)).toBe(true);
    expect(closed(browser)).toEqual([TAB]);
  });
  it.each(['hang', 'fail'] as const)('listing the workers will %s: the tab still ends', async (how) => {
    const tab = cdp(); const browser = cdp({ 'Target.getTargets': how });
    expect(await endPageActivity(tab, browser, TAB, 'blank', 20)).toBe(true);
    expect(tab.calls.map((c) => c.method)).toEqual(['Page.navigate']);
    const browser2 = cdp({ 'Target.getTargets': how });
    expect(await endPageActivity(cdp(), browser2, TAB, 'close', 20)).toBe(true);
    expect(closed(browser2)).toEqual([TAB]);
  });
  it.each(['hang', 'fail'] as const)('a close that will %s is reported as unconfirmed, not success', async (how) => {
    const browser = cdp({ 'Target.closeTarget': how });
    expect(await endPageActivity(cdp({ 'Page.navigate': 'hang' }), browser, TAB, 'blank', 20)).toBe(false);
    expect(await endPageActivity(cdp(), cdp({ 'Target.closeTarget': how }), TAB, 'close', 20)).toBe(false);
  });
});
