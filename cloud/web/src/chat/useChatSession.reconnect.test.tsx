import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useChatSession } from './useChatSession.js';

// The hook reconciles against the server tree after every ending. None of that
// is what these tests are about, so it is stubbed to empty rather than mocked
// per-case — an unstubbed fetch would fail the reload and swallow its own error.
vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  fetchFeedback: vi.fn(async () => ({ feedback: {} })),
  selectBranch: vi.fn(async () => ({ messages: [] })),
  deleteMessage: vi.fn(async () => ({ messages: [] })),
}));

/** A socket that records emits and lets a test deliver server events. */
function fakeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const runAcks: Array<(ack: unknown) => void> = [];
  return {
    runAcks,
    fire(event: string, payload?: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
    socket: {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) {
        let set = handlers.get(event);
        if (!set) { set = new Set(); handlers.set(event, set); }
        set.add(listener);
        return this;
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        handlers.get(event)?.delete(listener);
        return this;
      },
      emit(event: string, _payload?: unknown, ack?: (a: unknown) => void) {
        if (event === 'chat:run' && ack) runAcks.push(ack);
        return this;
      },
    } as unknown as Socket,
  };
}

function startRun(fake: ReturnType<typeof fakeSocket>) {
  const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
  act(() => { view.result.current.send({ prompt: 'hello' }); });
  return view;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('useChatSession — a run that outlives the connection that started it', () => {
  it('finishes on session:complete once the ack is known lost', async () => {
    // The reviewer's case: the page comes back BEFORE the run ends. The ack
    // belongs to the emit made on the old socket and can never be re-routed,
    // so without a second ending the composer stays disabled forever behind a
    // reply that did arrive.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    // Reconnected mid-run: the server says one run is still going.
    act(() => { fake.fire('run:resumed', { active: 1 }); });
    expect(view.result.current.busy).toBe(true);

    // That run now ends on the new socket.
    act(() => { fake.fire('session:complete', { conversationId: 'c1' }); });
    await waitFor(() => expect(view.result.current.busy).toBe(false));
  });

  it('stops waiting when the run already finished during the gap', async () => {
    // The other half: nothing is running any more, and no further event is
    // coming. `active: 0` is the only thing that can say so.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    act(() => { fake.fire('run:resumed', { active: 0 }); });
    await waitFor(() => expect(view.result.current.busy).toBe(false));
  });

  it('leaves the ordinary ending to the ack', async () => {
    // `session:complete` precedes the ack on a healthy connection. Ending the
    // run on it unconditionally would clear `busy` a beat before the ack
    // delivers the reply bubble, so it must do nothing until the ack is known
    // to be lost.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    act(() => { fake.fire('session:complete', { conversationId: 'c1' }); });
    expect(view.result.current.busy).toBe(true);

    act(() => { fake.runAcks[0]?.({ conversationId: 'c1', output: 'hi' }); });
    await waitFor(() => expect(view.result.current.busy).toBe(false));
  });

  it('keeps an unanswered escalation up across a blip', async () => {
    // The server holds the run and re-points its `escalation:decide` listener
    // at the replacement socket, so the question is still live and still
    // answerable. Clearing it on disconnect — right when the socket died with
    // the run — would strand the run until its own timeout.
    const fake = fakeSocket();
    const view = startRun(fake);
    act(() => {
      fake.fire('escalation:decision-required', {
        requestId: 'e1', sectionId: 's1', question: 'Which approach?', options: ['a', 'b'],
      });
    });
    await waitFor(() => expect(view.result.current.escalationQueued).toBe(1));

    act(() => { fake.fire('disconnect'); });
    expect(view.result.current.escalationQueued).toBe(1);

    // And it is dismissed by the signal that the run really is over.
    act(() => { fake.fire('run:resumed', { active: 0 }); });
    await waitFor(() => expect(view.result.current.escalationQueued).toBe(0));
  });
});
