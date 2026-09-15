import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useChatSession } from './useChatSession.js';

vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  fetchFeedback: vi.fn(async () => ({ feedback: {} })),
  selectBranch: vi.fn(async () => ({ messages: [] })),
  deleteMessage: vi.fn(async () => ({ messages: [] })),
}));

/** A socket that keeps what was emitted — the payload IS the assertion here. */
function fakeSocket() {
  const sent: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    sent,
    socket: {
      connected: true,
      on() { return this; },
      off() { return this; },
      emit(event: string, payload?: unknown) {
        sent.push({ event, payload: (payload ?? {}) as Record<string, unknown> });
        return this;
      },
    } as unknown as Socket,
  };
}

const lastRun = (fake: ReturnType<typeof fakeSocket>) =>
  fake.sent.filter((e) => e.event === 'chat:run').at(-1)?.payload;

beforeEach(() => { vi.clearAllMocks(); });

describe('reaching the internet is one decision, not two toggles', () => {
  it('clears the web toggle when browser mode is turned on', async () => {
    // The two are alternative ways out to the internet, not independent
    // capabilities: one reads pages as text, the other drives a real one. Both
    // on is not a coherent request, and it is the incoherent case that hurts —
    // it leaves the model a cheaper tool than the one the person just asked
    // for, which is the whole reason the browser went unused.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { view.result.current.setWebSearch(true); });
    await waitFor(() => expect(view.result.current.webSearch).toBe(true));

    act(() => { view.result.current.setBrowserMode(true); });

    expect(view.result.current.browserMode).toBe(true);
    expect(view.result.current.webSearch, 'turning one on turns the other off').toBe(false);
  });

  it('clears browser mode when the web toggle is turned on', async () => {
    // The same rule from the other side. Enforced on the setters rather than in
    // the chip's onClick, so it holds however the state is reached.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { view.result.current.setBrowserMode(true); });
    await waitFor(() => expect(view.result.current.browserMode).toBe(true));

    act(() => { view.result.current.setWebSearch(true); });

    expect(view.result.current.webSearch).toBe(true);
    expect(view.result.current.browserMode, 'and symmetrically').toBe(false);
  });

  it('carries the choice to the server, which is the only place it does anything', async () => {
    // The chip changes nothing on its own: what drops web_search and web_fetch
    // is the server reading this flag. A toggle that never reaches the payload
    // is a light switch wired to nothing.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { view.result.current.setBrowserMode(true); });
    act(() => { view.result.current.send({ prompt: 'book the table on that page' }); });

    await waitFor(() => expect(lastRun(fake)).toBeDefined());
    expect(lastRun(fake)?.['browserMode']).toBe(true);
    expect(lastRun(fake)?.['webSearch'], 'and says so about the other one too').toBe(false);
  });
});
