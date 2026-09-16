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

describe('a billed opt-in does not outlive the control that grants it', () => {
  it('clears browser mode when the routing controls leave the screen', async () => {
    // Simple view hides the whole routing row, including the Browser chip.
    // Sticky through that switch, the flag stayed true and every later send
    // carried `browserMode: true` — a billed capability with nothing on screen
    // to say it was on or to turn it off.
    //
    // This is the Web toggle's behaviour, inherited from sitting beside it, and
    // Web is a different kind of thing: a durable preference that costs nothing
    // to persist unseen.
    const fake = fakeSocket();
    const view = renderHook(
      ({ visible }) => useChatSession(fake.socket, [], 'general', undefined, undefined, visible),
      { initialProps: { visible: true } },
    );

    act(() => { view.result.current.setBrowserMode(true); });
    await waitFor(() => expect(view.result.current.browserMode).toBe(true));

    view.rerender({ visible: false });

    await waitFor(() => expect(view.result.current.browserMode, 'not granted once it cannot be seen').toBe(false));
    act(() => { view.result.current.send({ prompt: 'hello' }); });
    expect(lastRun(fake)?.['browserMode'], 'and the send says so too').toBe(false);
  });

  it('leaves the web toggle alone, because it is not the same kind of thing', async () => {
    // The distinction this whole fix rests on. Web costs nothing, persists as a
    // preference, and clearing it on a view switch would lose a setting the
    // person meant to keep. Only the billed opt-in is revoked.
    const fake = fakeSocket();
    const view = renderHook(
      ({ visible }) => useChatSession(fake.socket, [], 'general', undefined, undefined, visible),
      { initialProps: { visible: true } },
    );

    act(() => { view.result.current.setWebSearch(true); });
    view.rerender({ visible: false });

    await waitFor(() => expect(view.result.current.webSearch, 'still a preference').toBe(true));
  });
});

describe('a fast answer and a browser are not both on offer', () => {
  it('withholds browser mode from a fast answer rather than honouring it silently', async () => {
    // `runFastAnswer` is one model call with no tools by contract, so
    // `browser_control` is never registered. Sending both showed the Browser
    // chip lit, billed nothing, and answered from the model's own knowledge a
    // question that needed a page — the run quietly not matching the composer.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { view.result.current.setBrowserMode(true); });
    await waitFor(() => expect(view.result.current.browserMode).toBe(true));

    act(() => { view.result.current.send({ prompt: 'hello', fast: true }); });

    expect(lastRun(fake)?.['fastAnswer'], 'it is still a fast answer').toBe(true);
    expect(lastRun(fake)?.['browserMode'], 'but not one with a browser').toBe(false);
  });

  it('still sends browser mode on an ordinary turn', async () => {
    // The guard is about the fast path only — it must not quietly disable the
    // capability everywhere.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { view.result.current.setBrowserMode(true); });
    await waitFor(() => expect(view.result.current.browserMode).toBe(true));

    act(() => { view.result.current.send({ prompt: 'hello' }); });

    expect(lastRun(fake)?.['browserMode']).toBe(true);
  });

  it('takes the chip down, not just the flag off the payload', async () => {
    // Withholding `browserMode` from the payload fixed the RUN and left the
    // CLAIM. `Composer` renders the chip from this state, so it stayed pressed
    // for the whole tool-less answer — the same visible-capability mismatch
    // the payload guard was written to end, one layer up.
    //
    // Both halves are needed and neither substitutes for the other: the setter
    // cannot change the `browserMode` already captured in the send's closure,
    // and clearing the state cannot un-send a payload.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { view.result.current.setBrowserMode(true); });
    await waitFor(() => expect(view.result.current.browserMode).toBe(true));

    act(() => { view.result.current.send({ prompt: 'hello', fast: true }); });

    await waitFor(() => expect(view.result.current.browserMode, 'the chip stops saying it will drive a page').toBe(false));
    expect(lastRun(fake)?.['browserMode'], 'and this send was already without it').toBe(false);
  });

  it('does not take the chip down on an ordinary turn', async () => {
    // The clearing is the fast path's, exactly as the withholding is. A normal
    // send has to leave the selection standing or every browser turn would
    // need the chip pressed again.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { view.result.current.setBrowserMode(true); });
    await waitFor(() => expect(view.result.current.browserMode).toBe(true));

    act(() => { view.result.current.send({ prompt: 'hello' }); });

    expect(view.result.current.browserMode, 'still selected').toBe(true);
  });
});
