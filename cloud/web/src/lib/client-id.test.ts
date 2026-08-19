import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimClientId } from './client-id.js';

/**
 * A BroadcastChannel that actually delivers between instances, so two "tabs"
 * can be driven in one test. jsdom does not implement one.
 */
class FakeChannel {
  static live: FakeChannel[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { FakeChannel.live.push(this); }
  postMessage(data: unknown) {
    for (const other of FakeChannel.live) {
      if (other === this || other.name !== this.name) continue;
      other.onmessage?.({ data } as MessageEvent);
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
  it('keeps its id when nothing else answers to it', () => {
    const rotate = vi.fn();
    const id = claimClientId(rotate);
    expect(id).toEqual(expect.any(String));
    expect(rotate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('cascade.clientId')).toBe(id);
  });

  it('rotates the tab that inherited a copied id, and leaves the original alone', () => {
    // Session storage is COPIED into a tab opened from another one, so both
    // tabs come up holding the same value and the server would treat them as
    // one resume owner — the cross-tab adoption bug, reintroduced by the very
    // mechanism meant to prevent it.
    const originalRotate = vi.fn();
    const original = claimClientId(originalRotate);

    // The duplicate starts with the parent's value already in storage.
    const duplicateRotate = vi.fn();
    const duplicate = claimClientId(duplicateRotate);

    expect(duplicateRotate).toHaveBeenCalledTimes(1);
    const rotated = duplicateRotate.mock.calls[0]![0] as string;

    // Asserted on the SETTLED identity rather than the returned one, because
    // which of the two comes back depends on whether the channel delivered
    // before or after the call returned — a real BroadcastChannel is async and
    // this fake is not. What must hold either way is that this tab ends up on
    // an id of its own: if delivery was late, the caller reconnects on it.
    expect(sessionStorage.getItem('cascade.clientId')).toBe(rotated);
    expect(rotated).not.toBe(original);
    expect([original, rotated]).toContain(duplicate);
    // Seniority: the tab that claimed first keeps its identity, and therefore
    // keeps any run being held for it.
    expect(originalRotate).not.toHaveBeenCalled();
  });

  it('does not rotate a tab whose id nobody else claims', () => {
    const first = claimClientId(vi.fn());
    sessionStorage.clear();
    const secondRotate = vi.fn();
    const second = claimClientId(secondRotate);

    expect(second).not.toBe(first);
    expect(secondRotate).not.toHaveBeenCalled();
  });

  it('still yields an id when BroadcastChannel is unavailable', () => {
    // Losing collision detection must not lose the identity outright — that
    // would make every tab non-resumable.
    vi.stubGlobal('BroadcastChannel', undefined);
    const id = claimClientId(vi.fn());
    expect(id).toEqual(expect.any(String));
  });
});
