import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimClientId } from './client-id.js';

/**
 * A BroadcastChannel that actually delivers between instances, so two "tabs"
 * can be driven in one test. jsdom does not implement one.
 */
class FakeChannel {
  static live: FakeChannel[] = [];
  private handler: ((e: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { FakeChannel.live.push(this); }
  set onmessage(fn: ((e: MessageEvent) => void) | null) { this.handler = fn; }
  deliver(data: unknown) { this.handler?.({ data } as MessageEvent); }
  postMessage(data: unknown) {
    for (const other of FakeChannel.live) {
      if (other !== this && other.name === this.name) other.deliver(data);
    }
  }
  close() { FakeChannel.live = FakeChannel.live.filter((c) => c !== this); }
}

beforeEach(() => {
  FakeChannel.live = [];
  sessionStorage.clear();
  vi.stubGlobal('BroadcastChannel', FakeChannel);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('claimClientId', () => {
  it('settles immediately on a first load, with nothing to collide with', async () => {
    // A freshly minted id cannot be a copy of anybody's, so this path must not
    // pay the claim window at all.
    const id = await claimClientId();
    expect(id).toEqual(expect.any(String));
    expect(sessionStorage.getItem('cascade.clientId')).toBe(id);
  });

  it('keeps a stored id when no other tab objects', async () => {
    vi.useFakeTimers();
    try {
      sessionStorage.setItem('cascade.clientId', 'stored-id');
      const pending = claimClientId();
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBe('stored-id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves on the ROTATED id, before the caller can connect on the copied one', async () => {
    // The ordering that matters. Session storage is copied into a duplicated
    // tab, and the server treats a socket arriving on an existing resume key
    // as that client coming back — it moves the runs over at once. So a claim
    // that resolved with the inherited id and rotated afterwards would hand
    // the original tab's run to the duplicate inside that window, and the
    // duplicate would then rotate away still holding it.
    const original = new FakeChannel('cascade.client-id');
    const held = 'id-held-by-the-original-tab';
    original.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id: string };
      if (m?.type === 'claim' && m.id === held) original.postMessage({ type: 'taken', id: held });
    };

    sessionStorage.setItem('cascade.clientId', held);
    const settled = await claimClientId();

    expect(settled).not.toBe(held);
    expect(settled).toEqual(expect.any(String));
    expect(sessionStorage.getItem('cascade.clientId')).toBe(settled);
  });

  it('answers a later claim, so a tab duplicated from THIS one rotates in turn', async () => {
    // Seniority has to keep working after the first settle: the listener
    // outlives the promise precisely so this tab can object later.
    sessionStorage.setItem('cascade.clientId', 'senior-id');
    vi.useFakeTimers();
    let senior: string | undefined;
    try {
      const pending = claimClientId();
      await vi.advanceTimersByTimeAsync(60);
      senior = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(senior).toBe('senior-id');

    // A newcomer claims the same id and must be told it is taken.
    const newcomer = new FakeChannel('cascade.client-id');
    const replies: unknown[] = [];
    newcomer.onmessage = (e: MessageEvent) => { replies.push(e.data); };
    newcomer.postMessage({ type: 'claim', id: 'senior-id' });

    expect(replies).toContainEqual({ type: 'taken', id: 'senior-id' });
  });

  it('still yields an id when BroadcastChannel is unavailable', async () => {
    // Losing collision detection must not lose the identity outright — that
    // would make every tab non-resumable.
    vi.stubGlobal('BroadcastChannel', undefined);
    sessionStorage.setItem('cascade.clientId', 'stored-id');
    await expect(claimClientId()).resolves.toBe('stored-id');
  });

  it('yields nothing when the identity cannot be persisted', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      await expect(claimClientId()).resolves.toBeUndefined();
    } finally {
      setItem.mockRestore();
    }
  });
});
