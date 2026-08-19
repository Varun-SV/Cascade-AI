import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useChatSession } from './useChatSession.js';
import { getMessages } from '../lib/api.js';

// The persisted transcript, keyed by conversation. `getMessages` is what the
// recovery path calls once it knows which conversation to load, so asserting on
// its argument — and on the rows reaching the hook — is how these tests tell
// "stopped waiting" apart from "actually recovered the answer".
const PERSISTED: Record<string, Array<{ id: string; role: string; content: string }>> = {
  'server-made-id': [
    { id: 'm1', role: 'user', content: 'hello' },
    { id: 'm2', role: 'assistant', content: 'the answer that survived' },
  ],
};

vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async (cid: string) => ({ messages: PERSISTED[cid] ?? [] })),
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
  it('finishes on session:complete once the ack is known lost, and adopts its id', async () => {
    // The reviewer's case: the page comes back BEFORE the run ends. The ack
    // belongs to the emit made on the old socket and can never be re-routed,
    // so without a second ending the composer stays disabled forever behind a
    // reply that did arrive.
    //
    // The hook starts with NO conversation id, exactly as App.tsx calls it for
    // a new chat. That id is created server-side and delivered only by the ack,
    // so ending the wait without taking it from the event leaves the spinner
    // cleared over an empty chat while the answer sits somewhere unnamed.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));
    expect(view.result.current.conversationId).toBeUndefined();

    // Reconnected mid-run: the server says one run is still going.
    act(() => { fake.fire('run:resumed', { active: 1, finished: [] }); });
    expect(view.result.current.busy).toBe(true);

    // That run now ends on the new socket, carrying the id with it.
    act(() => { fake.fire('session:complete', { conversationId: 'server-made-id' }); });

    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(view.result.current.conversationId).toBe('server-made-id');
    expect(getMessages).toHaveBeenCalledWith('server-made-id');
    await waitFor(() => {
      expect(view.result.current.messages.map((m) => m.content))
        .toContain('the answer that survived');
    });
  });

  it('stops waiting when the run already finished during the gap, and loads it', async () => {
    // The other half, and the harder one: the terminal event was emitted while
    // no socket was bound, so nothing later carries the id. `run:resumed` has
    // to bring both facts — that nothing is running, and which conversation
    // ended — or the reply still looks like it died.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    act(() => { fake.fire('run:resumed', { active: 0, finished: [{ conversationId: 'server-made-id' }] }); });

    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(view.result.current.conversationId).toBe('server-made-id');
    expect(getMessages).toHaveBeenCalledWith('server-made-id');
    await waitFor(() => {
      expect(view.result.current.messages.map((m) => m.content))
        .toContain('the answer that survived');
    });
  });

  it('ends and surfaces the reason when an inherited run fails', async () => {
    // `runChatTurn` emits `session:error` and then throws, and the throw only
    // reaches the original `chat:run` ack — the callback this whole path knows
    // is gone. Unhandled, a failed run left `busy` true forever and said
    // nothing about why.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    act(() => { fake.fire('run:resumed', { active: 1, finished: [] }); });
    expect(view.result.current.busy).toBe(true);

    act(() => {
      fake.fire('session:error', { conversationId: 'server-made-id', error: 'provider refused the request' });
    });

    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(view.result.current.error).toBe('provider refused the request');
    // The failed turn still belongs to a conversation, and its user message is
    // persisted — so the id is adopted here too.
    expect(view.result.current.conversationId).toBe('server-made-id');
  });

  it('surfaces a failure that happened while nobody was connected', async () => {
    // The run can die during the gap as easily as it can finish, and its
    // `session:error` went to a socket that no longer existed. Reporting only
    // the conversation id made the two endings identical to the client: the
    // spinner cleared, a transcript with no reply in it loaded, and nothing
    // said why. The outcome has to come back with the resume, not just the id.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    act(() => {
      fake.fire('run:resumed', {
        active: 0,
        finished: [{ conversationId: 'server-made-id', error: 'the provider rejected the request' }],
      });
    });

    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(view.result.current.error).toBe('the provider rejected the request');
    // Identity is still recovered — the failed turn belongs to a conversation.
    expect(view.result.current.conversationId).toBe('server-made-id');
  });

  it('keeps waiting when the resume arrives before the run is handed over', async () => {
    // The full sequence the server's own overlap ordering produces: this page
    // reconnects while the previous socket is still holding the run, so the
    // resume status has to already count the handover that has not happened
    // yet. If it says `active: 0` the page treats it as terminal — and it does
    // not merely clear `busy`, it clears the flag saying the ack is lost, so
    // the `session:complete` that arrives after the handover is then discarded
    // as an ordinary duplicate and the answer never loads. The run survives on
    // the server and the user still sees it die.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    // Reconnected mid-run, told there is one run coming to it.
    act(() => { fake.fire('run:resumed', { active: 1, finished: [] }); });
    expect(view.result.current.busy).toBe(true);

    // The handover happens server-side, and only then does the run end.
    act(() => { fake.fire('session:complete', { conversationId: 'server-made-id' }); });

    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(view.result.current.conversationId).toBe('server-made-id');
    await waitFor(() => {
      expect(view.result.current.messages.map((m) => m.content))
        .toContain('the answer that survived');
    });
  });

  it('cannot be revived by a completion once it was told nothing was running', async () => {
    // The inverse, and the reason the count above has to be right rather than
    // merely optimistic: `active: 0` is terminal and IRREVERSIBLE on the
    // client. Nothing arriving afterwards puts the page back into waiting, so
    // a server that under-reports cannot be rescued by a later event.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    act(() => { fake.fire('run:resumed', { active: 0, finished: [] }); });
    await waitFor(() => expect(view.result.current.busy).toBe(false));

    // A completion for the run that was, in fact, still going.
    act(() => { fake.fire('session:complete', { conversationId: 'server-made-id' }); });

    // Still finished, and — the point — the reply never got loaded by it.
    expect(view.result.current.busy).toBe(false);
    expect(view.result.current.conversationId).toBeUndefined();
  });

  it('ignores session:error on a healthy connection, where the ack reports it', async () => {
    // The mirror of the session:complete gate. On a live socket the ack
    // carries `{ error }` and does the full cleanup; acting on both would
    // surface the same failure twice.
    const fake = fakeSocket();
    const view = startRun(fake);
    await waitFor(() => expect(view.result.current.busy).toBe(true));

    act(() => { fake.fire('session:error', { conversationId: 'c1', error: 'boom' }); });
    expect(view.result.current.busy).toBe(true);
    expect(view.result.current.error).toBeNull();
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
