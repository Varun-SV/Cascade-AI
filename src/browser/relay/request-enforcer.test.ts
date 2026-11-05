import { describe, expect, it, vi } from 'vitest';
import { policeChild } from './request-enforcer.js';

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
