import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useChatSession } from './useChatSession.js';

vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  fetchFeedback: vi.fn(async () => ({ feedback: {} })),
  selectBranch: vi.fn(async () => ({ messages: [] })),
  deleteMessage: vi.fn(async () => ({ messages: [] })),
}));

/** A socket that records subscriptions and lets a test deliver server events. */
function fakeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  /** Emitted while down. Socket.IO would flush these on reconnect. */
  const buffered: Array<{ event: string; payload: unknown }> = [];
  const runAcks: Array<(a: unknown) => void> = [];
  /** Registrations and the connect, in the order they happened. */
  const order: string[] = [];
  const socket = {
    on(event: string, listener: (...args: unknown[]) => void) {
      order.push(`on:${event}`);
      let set = handlers.get(event);
      if (!set) { set = new Set(); handlers.set(event, set); }
      set.add(listener);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(listener);
      return this;
    },
    connected: false,
    connect() { socket.connected = true; order.push('connect'); return this; },
    emit(event: string, payload: unknown, ack?: (a: unknown) => void) {
      // Socket.IO 4.x BUFFERS anything emitted while disconnected and delivers
      // it on reconnect. Modelled here because a fake that records every emit
      // cannot tell "sent" from "queued to be sent later" — and that difference
      // is the whole of the takeover's see-what-you-drive guarantee across a
      // transport gap. See socket.io/docs/v4/client-offline-behavior.
      if (!socket.connected) { buffered.push({ event, payload }); return this; }
      sent.push({ event, payload });
      if (event === 'chat:run' && ack) runAcks.push(ack);
      return this;
    },
  };
  return {
    order,
    sent,
    /** What Socket.IO is holding to deliver later. Should stay empty. */
    buffered,
    /** The transport drops, the way a flaky network does. */
    drop() { socket.connected = false; },
    /** And comes back, flushing whatever Socket.IO had queued. */
    restore() {
      socket.connected = true;
      sent.push(...buffered.splice(0, buffered.length));
    },
    /** Settle the in-flight run the way the server's `chat:run` ack does. */
    ackRun(conversationId: string) { runAcks.shift()?.({ conversationId, output: 'done' }); },
    /** The other ordinary ending: the run failed on this same socket. */
    failRun(error = 'the run failed') { runAcks.shift()?.({ error }); },
    fire(event: string, payload?: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
    socket: socket as unknown as Socket,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

// The first turn of a brand-new chat is the most common case there is: the
// server creates the conversation as the run starts and stamps its events with
// that new id, while this side does not learn the id until the run's closing
// ack. A filter that compares eagerly therefore compares `new-server-id` with
// `undefined` and drops everything — for the whole first run.
describe('useChatSession — conversation-scoped gates on a brand-new chat', () => {
  it('queues a tool approval whose id this chat has not learned yet', () => {
    // Dropping it is worse than having no gate: nothing renders, nobody
    // answers, and the server's approval callback parks until it times out and
    // denies — ten minutes of silence on the very first browser action.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    expect(view.result.current.conversationId).toBeUndefined();

    // A genuine first turn: this pane started the run, so it is the pane
    // entitled to adopt the id the server made for it. The fake never acks, so
    // the run stays in flight — which is the state under test.
    act(() => { void view.result.current.send({ prompt: 'open the page' }); });

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-created-by-the-server',
        requestId: 'req-1',
        toolName: 'browser_control',
        args: { action: 'click', selector: '#buy' },
      });
    });

    expect(view.result.current.toolApprovals.map((a) => a.requestId)).toEqual(['req-1']);
  });

  it('shows the live view for a run whose id this chat has not learned yet', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { void view.result.current.send({ prompt: 'open the page' }); });

    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-created-by-the-server',
        taskId: 'task-1',
        liveViewUrl: 'https://viewer.example/s/abc',
        active: true,
      });
    });

    // The Stop button hangs off `browserActive`/`browserTaskId`, so losing this
    // loses the kill switch too.
    expect(view.result.current.browserActive).toBe(true);
    expect(view.result.current.browserTaskId).toBe('task-1');
    expect(view.result.current.browserLiveView).toBe('https://viewer.example/s/abc');
  });

  // The filter still has to do its job once the id IS known, which is the case
  // it was added for: one socket carries several conversations.
  it('still drops another conversation once this chat knows its own id', () => {
    const fake = fakeSocket();
    const view = renderHook(() =>
      useChatSession(fake.socket, [], 'general', undefined, 'conv-mine'));

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-someone-elses',
        requestId: 'req-2',
        toolName: 'browser_control',
      });
      fake.fire('browser:live-view', {
        conversationId: 'conv-someone-elses',
        taskId: 'task-2',
        liveViewUrl: 'https://viewer.example/s/xyz',
        active: true,
      });
    });

    expect(view.result.current.toolApprovals).toEqual([]);
    expect(view.result.current.browserActive).toBe(false);
    expect(view.result.current.browserLiveView).toBeUndefined();
  });
});

// One socket carries every conversation the user has open, and one hook
// instance serves the whole app — switching chats changes an id, it does not
// remount. So any state fed by socket events has to say WHICH conversation it
// belongs to, or the run you walked away from writes into the pane you walked
// into.
describe('useChatSession — switching conversations mid-run', () => {
  function liveView(conversationId: string, taskId: string, url: string) {
    return { conversationId, taskId, liveViewUrl: url, active: true };
  }

  it('keeps each conversation\'s browser panel with its own conversation', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => { fake.fire('browser:live-view', liveView('conv-a', 'task-a', 'https://viewer.example/a')); });
    expect(view.result.current.browserLiveView).toBe('https://viewer.example/a');
    expect(view.result.current.browserTaskId).toBe('task-a');

    // B has no browser of its own. Showing A's would hand this pane a live
    // bearer-capability URL for a session it is not watching, under a Stop
    // button that stops a run in another chat.
    act(() => { view.result.current.setConversationId('conv-b'); });
    expect(view.result.current.browserActive).toBe(false);
    expect(view.result.current.browserLiveView).toBeUndefined();
    expect(view.result.current.browserTaskId).toBeUndefined();

    act(() => { fake.fire('browser:live-view', liveView('conv-b', 'task-b', 'https://viewer.example/b')); });
    expect(view.result.current.browserLiveView).toBe('https://viewer.example/b');
    expect(view.result.current.browserTaskId).toBe('task-b');

    // Back to A: its run never stopped, so its panel — and its kill switch —
    // have to still be there.
    act(() => { view.result.current.setConversationId('conv-a'); });
    expect(view.result.current.browserLiveView).toBe('https://viewer.example/a');
    expect(view.result.current.browserTaskId).toBe('task-a');
  });

  it('stops the browser of the conversation on screen, and only that one', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a', 'https://viewer.example/a'));
      fake.fire('browser:live-view', liveView('conv-b', 'task-b', 'https://viewer.example/b'));
    });
    act(() => { view.result.current.setConversationId('conv-b'); });
    act(() => { view.result.current.stopBrowser(); });

    const stops = fake.sent.filter((m) => m.event === 'browser:stop');
    expect(stops).toEqual([{ event: 'browser:stop', payload: { taskId: 'task-b' } }]);
    expect(view.result.current.browserActive).toBe(false);

    act(() => { view.result.current.setConversationId('conv-a'); });
    expect(view.result.current.browserTaskId).toBe('task-a');
  });

  it('drops the panel when a run gives the browser up, without touching the others', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a', 'https://viewer.example/a'));
      fake.fire('browser:live-view', liveView('conv-b', 'task-b', 'https://viewer.example/b'));
      // A's run is done with it.
      fake.fire('browser:live-view', { conversationId: 'conv-a', taskId: 'task-a', active: false });
    });
    expect(view.result.current.browserActive).toBe(false);

    act(() => { view.result.current.setConversationId('conv-b'); });
    expect(view.result.current.browserTaskId).toBe('task-b');
  });

  it('holds an unanswered approval for the chat it belongs to', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-a', requestId: 'req-a', toolName: 'browser_control',
      });
    });
    expect(view.result.current.toolApprovals.map((a) => a.requestId)).toEqual(['req-a']);

    // Not answerable from another chat...
    act(() => { view.result.current.setConversationId('conv-b'); });
    expect(view.result.current.toolApprovals).toEqual([]);

    // ...but not thrown away either: the run is still blocked on it, and
    // discarding it would leave the server's callback parked until its own
    // timeout denied it.
    act(() => { view.result.current.setConversationId('conv-a'); });
    expect(view.result.current.toolApprovals.map((a) => a.requestId)).toEqual(['req-a']);
  });

  it('answers a first-turn approval against the id the server created', () => {
    // The pane has no conversation id of its own yet, so without adopting the
    // one the event carried the decision would name no conversation at all and
    // the server could not match it to the waiting run.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { void view.result.current.send({ prompt: 'open the page' }); });

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-new', requestId: 'req-1', toolName: 'browser_control',
      });
    });
    act(() => { view.result.current.resolveToolApproval('req-1', true); });

    expect(fake.sent.filter((m) => m.event === 'permission:decide')).toEqual([
      { event: 'permission:decide', payload: { conversationId: 'conv-new', requestId: 'req-1', approved: true, always: false } },
    ]);
    expect(view.result.current.toolApprovals).toEqual([]);
  });
});

// New Chat is not "every conversation" — it is a pane with no conversation at
// all. The distinction matters because the thing being scoped is consent to a
// dangerous action.
describe('useChatSession — a blank New Chat pane', () => {
  it('does not offer another conversation\'s dangerous-tool prompt', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-a', requestId: 'req-a',
        toolName: 'browser_control', args: { action: 'click', selector: '#confirm-purchase' },
      });
    });
    expect(view.result.current.toolApprovals.map((a) => a.requestId)).toEqual(['req-a']);

    // App.newChat() does exactly this.
    act(() => { view.result.current.setConversationId(undefined); });

    // Showing it here would let someone approve a click in a run they are no
    // longer looking at, from a chat that has nothing to do with it.
    expect(view.result.current.toolApprovals).toEqual([]);
  });

  it('does not let a run left behind adopt the blank pane', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => { view.result.current.setConversationId(undefined); });
    // A's run is still going and still emitting.
    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-a', taskId: 'task-a', liveViewUrl: 'https://viewer.example/a', active: true,
      });
      fake.fire('permission:user-required', {
        conversationId: 'conv-a', requestId: 'req-late', toolName: 'browser_control',
      });
    });

    // Adopting `conv-a` here would drag the whole run — its live view, its
    // Stop, its prompts — into the empty chat the user just opened.
    expect(view.result.current.browserActive).toBe(false);
    expect(view.result.current.browserLiveView).toBeUndefined();
    expect(view.result.current.toolApprovals).toEqual([]);
  });

  it('answers with the conversation the request came from, never the pane\'s', () => {
    // The pane must be showing something ELSE when the answer is sent, or the
    // two candidate ids are equal and the assertion cannot tell them apart —
    // which is what the first version of this test did, and it passed against
    // the bug. A click handler captured before a conversation switch and run
    // after it is the reachable version of this.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-a', requestId: 'req-a', toolName: 'browser_control',
      });
    });
    const deny = view.result.current.resolveToolApproval;
    act(() => { view.result.current.setConversationId('conv-b'); });
    act(() => { deny('req-a', false); });

    // `conv-b` here would deny A's browser click by naming a conversation that
    // has nothing to do with it — and the server, which used to accept a
    // decision whose id was merely absent, would resolve it by request id.
    expect(fake.sent.filter((m) => m.event === 'permission:decide')).toEqual([
      { event: 'permission:decide', payload: { conversationId: 'conv-a', requestId: 'req-a', approved: false, always: false } },
    ]);
  });

  it('sends nothing for a request that is no longer queued', () => {
    // A second click on a prompt already answered, or one pruned by its run
    // ending. Emitting again would name a conversation from the pane rather
    // than from the request, which is the bug this pair is about.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-a', requestId: 'req-a', toolName: 'browser_control',
      });
    });
    act(() => { view.result.current.resolveToolApproval('req-a', true); });
    act(() => { view.result.current.resolveToolApproval('req-a', true); });

    expect(fake.sent.filter((m) => m.event === 'permission:decide')).toHaveLength(1);
  });
});

// The server denies every approval still parked when a run ends and clears its
// map in a `finally`, and it sends nothing to say so. Anything this side kept
// would be a prompt with no waiter behind it.
describe('useChatSession — approvals outliving their run', () => {
  it('drops a question nobody is waiting on once the run has settled', async () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { void view.result.current.send({ prompt: 'open the page' }); });

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-new', requestId: 'req-1', toolName: 'browser_control',
      });
    });
    expect(view.result.current.toolApprovals).toHaveLength(1);

    // The run ends — timed out, errored, or simply finished while the request
    // was being torn down.
    await act(async () => { fake.ackRun('conv-new'); });

    expect(view.result.current.toolApprovals).toEqual([]);
    // And it does not come back when the user revisits that conversation.
    act(() => { view.result.current.setConversationId(undefined); });
    act(() => { view.result.current.setConversationId('conv-new'); });
    expect(view.result.current.toolApprovals).toEqual([]);
  });

  it('takes the prompt down when the server says the window closed', () => {
    // The run is still going — this is not the terminal path. The SDK's
    // escalator has timed the decision out and denied it, so the buttons would
    // resolve a waiter that no longer exists on either side.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { void view.result.current.send({ prompt: 'open the page' }); });

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-new', requestId: 'req-1', toolName: 'browser_control',
      });
      fake.fire('permission:user-required', {
        conversationId: 'conv-new', requestId: 'req-2', toolName: 'browser_control',
      });
    });
    expect(view.result.current.toolApprovals).toHaveLength(2);

    act(() => {
      fake.fire('permission:resolved', {
        conversationId: 'conv-new', requestId: 'req-1', reason: 'timeout',
      });
    });

    // Only the one that expired. The other is still live.
    expect(view.result.current.toolApprovals.map((a) => a.requestId)).toEqual(['req-2']);
  });

  it('leaves another conversation\'s live question alone', async () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { void view.result.current.send({ prompt: 'open the page' }); });

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-new', requestId: 'req-1', toolName: 'browser_control',
      });
      fake.fire('permission:user-required', {
        conversationId: 'conv-other', requestId: 'req-2', toolName: 'browser_control',
      });
    });
    await act(async () => { fake.ackRun('conv-new'); });

    act(() => { view.result.current.setConversationId('conv-other'); });
    expect(view.result.current.toolApprovals.map((a) => a.requestId)).toEqual(['req-2']);
  });
});

// A run that fails is a run that has finished. The success ack does the whole
// ending — clears the adopted id, disarms first-turn adoption, drops questions
// nobody is waiting on — and the error ack returned before reaching any of it.
//
// `session:error` does not cover this: it deliberately ignores errors while the
// ack is still reachable, which is exactly the case on the same socket.
describe('useChatSession — a run that ends by failing', () => {
  it('does not leave a dangerous-tool prompt behind', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { void view.result.current.send({ prompt: 'open the page' }); });

    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-new', requestId: 'req-1',
        toolName: 'browser_control', args: { action: 'click', selector: '#buy' },
      });
    });
    expect(view.result.current.toolApprovals).toHaveLength(1);

    act(() => { fake.failRun('the model provider rejected the request'); });

    expect(view.result.current.error).toContain('rejected');
    // The run is over. Its questions are not answerable, and offering them
    // invites a click that emits into nothing.
    expect(view.result.current.toolApprovals).toEqual([]);
  });

  it('does not leave first-turn adoption armed after the run is over', () => {
    // Still armed, the next event from ANY run — including one the user walked
    // away from — could name this pane's conversation.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { void view.result.current.send({ prompt: 'open the page' }); });
    act(() => { fake.failRun(); });

    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-somewhere-else', taskId: 'task-x',
        liveViewUrl: 'https://viewer.example/x', active: true,
      });
    });

    expect(view.result.current.browserActive).toBe(false);
    expect(view.result.current.browserLiveView).toBeUndefined();
  });
});

// A held run survives a page reload — that is the point of holding it. But the
// browser panel and the consent prompt are one-shot events kept in React state,
// which a reload destroys, so the server replays them to the connection that
// takes the run over. This side has to be able to receive them.
describe('useChatSession — a page reloaded into a run already using a browser', () => {
  it('takes the browser panel and its Stop back', () => {
    // A fresh mount: no conversation id, nothing sent from here, and a run
    // already in flight that the server rebound to this connection.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('run:resumed', { active: 1 }); });
    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-held', taskId: 'task-held',
        liveViewUrl: 'https://viewer.example/held', active: true,
      });
    });

    // Without this the page is attached to a run whose agent is driving a real
    // browser, with no way to watch it and no way to halt it.
    expect(view.result.current.browserActive).toBe(true);
    expect(view.result.current.browserTaskId).toBe('task-held');
    expect(view.result.current.browserLiveView).toBe('https://viewer.example/held');
  });

  it('takes a still-pending consent prompt back, answerable against its own run', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('run:resumed', { active: 1 }); });
    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-held', requestId: 'req-held',
        toolName: 'browser_control', args: { action: 'click', selector: '#confirm' },
      });
    });
    expect(view.result.current.toolApprovals.map((a) => a.requestId)).toEqual(['req-held']);

    act(() => { view.result.current.resolveToolApproval('req-held', false); });
    expect(fake.sent.filter((m) => m.event === 'permission:decide')).toEqual([
      { event: 'permission:decide', payload: { conversationId: 'conv-held', requestId: 'req-held', approved: false, always: false } },
    ]);
  });

  it('does not let a resumed run rename a chat the user already had open', () => {
    // Adoption is for a pane with nothing to compare against. A pane that knows
    // its conversation must keep matching on it, or a background run's events
    // would land in the chat on screen.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-mine'));

    act(() => { fake.fire('run:resumed', { active: 1 }); });
    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-someone-elses', taskId: 'task-other',
        liveViewUrl: 'https://viewer.example/other', active: true,
      });
    });

    expect(view.result.current.browserActive).toBe(false);
    expect(view.result.current.conversationId).toBe('conv-mine');
  });
});

// The server names the resumed conversation in `run:resumed` itself, and only
// then replays that run's one-shot supervision events. The page must claim its
// id from the resume rather than infer it from whichever event lands next —
// that inference is what the ordering bug broke, and the events do not repeat.
describe('useChatSession — claiming a resumed run by name', () => {
  it('shows the browser panel for a run named in run:resumed', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('run:resumed', { active: 1, active_conversations: ['conv-held'] }); });
    expect(view.result.current.conversationId, 'the pane still shows "new chat"').toBeUndefined();

    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-held', taskId: 'task-held',
        liveViewUrl: 'https://viewer.example/held', active: true,
      });
    });

    expect(view.result.current.browserActive).toBe(true);
    expect(view.result.current.browserTaskId).toBe('task-held');
  });

  it('answers a replayed prompt against the run it belongs to', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('run:resumed', { active: 1, active_conversations: ['conv-held'] }); });
    act(() => {
      fake.fire('permission:user-required', {
        conversationId: 'conv-held', requestId: 'req-held', toolName: 'browser_control',
      });
    });
    act(() => { view.result.current.resolveToolApproval('req-held', false); });

    expect(fake.sent.filter((m) => m.event === 'permission:decide')).toEqual([
      { event: 'permission:decide', payload: { conversationId: 'conv-held', requestId: 'req-held', approved: false, always: false } },
    ]);
  });

  it('claims the run it was named, not whichever event arrives first', () => {
    // The discriminating case for claiming by name. With the ordering fixed,
    // the two happy-path tests above pass whether the id comes from
    // `run:resumed` or is inferred from the first replayed event — the ids are
    // the same, so they cannot tell the mechanisms apart.
    //
    // They differ when the first event to land belongs to something else: a
    // background run the server did not name in `active_conversations`.
    // Inferring would adopt THAT conversation and put its browser, and its
    // Stop button, in front of a user who never opened it.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('run:resumed', { active: 1, active_conversations: ['conv-held'] }); });
    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-other', taskId: 'task-other',
        liveViewUrl: 'https://viewer.example/other', active: true,
      });
    });

    expect(view.result.current.browserActive, 'not the one it was not named').toBe(false);

    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-held', taskId: 'task-held',
        liveViewUrl: 'https://viewer.example/held', active: true,
      });
    });
    expect(view.result.current.browserTaskId).toBe('task-held');
  });

  it('claims nothing when several runs resumed at once', () => {
    // Two concurrent runs means this pane cannot know which of them it is
    // showing. Picking one would put another conversation's browser — and its
    // Stop button — in front of the user.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('run:resumed', { active: 2, active_conversations: ['conv-a', 'conv-b'] }); });
    act(() => {
      fake.fire('browser:live-view', {
        conversationId: 'conv-a', taskId: 'task-a', liveViewUrl: 'https://viewer.example/a', active: true,
      });
    });

    expect(view.result.current.browserActive).toBe(false);
  });
});

// The server sends `run:resumed` the instant it accepts a connection, and the
// held run's live view and pending approval immediately behind it. All three
// are one-shot. If the socket can connect before this hook is listening, a
// reloaded page loses them for good — attached to a run still driving a real
// browser, with nothing to watch it by and no Stop.
describe('useChatSession — subscribing before connecting', () => {
  it('attaches every handshake handler before opening the connection', () => {
    const fake = fakeSocket();
    renderHook(() => useChatSession(fake.socket, [], 'general'));

    const connectedAt = fake.order.indexOf('connect');
    expect(connectedAt, 'the hook is what opens the socket').toBeGreaterThan(-1);

    // The three the reconnect handshake delivers. Each must already be
    // listening when the connection opens — `App` calls getSocket() during
    // render, so an auto-connecting socket would be in flight while React was
    // still committing and this effect had not run.
    for (const event of ['run:resumed', 'browser:live-view', 'permission:user-required']) {
      const at = fake.order.indexOf(`on:${event}`);
      expect(at, `${event} must be subscribed`).toBeGreaterThan(-1);
      expect(at, `${event} must be subscribed before connect`).toBeLessThan(connectedAt);
    }
  });
});

// A run can finish while nobody is connected. Its terminal event went to a dead
// socket, so the reconnect payload is the only thing that still knows both the
// answer's conversation and whether it failed.
describe('useChatSession — a run that finished during the reload gap', () => {
  it('adopts and reloads the conversation on a fresh mount', () => {
    // Fresh mount: nothing sent from here, `busy` is just React state at false.
    // The active-run branch does not apply, and returning early on "not busy"
    // dropped the report entirely — an empty chat, nothing reloaded.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => {
      fake.fire('run:resumed', { active: 0, finished: [{ conversationId: 'conv-held' }] });
    });

    expect(view.result.current.conversationId).toBe('conv-held');
  });

  it('surfaces the error when that run failed', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => {
      fake.fire('run:resumed', {
        active: 0,
        finished: [{ conversationId: 'conv-held', error: 'the provider rejected the request' }],
      });
    });

    expect(view.result.current.conversationId).toBe('conv-held');
    expect(view.result.current.error).toContain('rejected');
  });

  it('claims nothing when several conversations finished', () => {
    // The same non-guessing rule as a multi-run resume: this pane cannot know
    // which of them it is, and picking one drops somebody else's chat into it.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => {
      fake.fire('run:resumed', {
        active: 0,
        finished: [{ conversationId: 'conv-a' }, { conversationId: 'conv-b' }],
      });
    });

    expect(view.result.current.conversationId).toBeUndefined();
  });

  it('does not yank a pane that is already showing another conversation', () => {
    const fake = fakeSocket();
    const view = renderHook(() =>
      useChatSession(fake.socket, [], 'general', undefined, 'conv-mine'));

    act(() => {
      fake.fire('run:resumed', { active: 0, finished: [{ conversationId: 'conv-somewhere-else' }] });
    });

    expect(view.result.current.conversationId).toBe('conv-mine');
  });
});

// Frames are the same routing problem as the live view, but arriving many times
// a second: one socket, several chats, and a picture of somebody else's page is
// a worse failure than a blank panel — it is a plausible-looking lie about what
// the agent is doing.
describe('useChatSession — frames of the agent\'s browser', () => {
  function liveView(conversationId: string, taskId: string, url?: string) {
    return { conversationId, taskId, liveViewUrl: url, active: true };
  }
  function frame(conversationId: string, taskId: string, data: string, generation = 1) {
    return { conversationId, taskId, data, width: 1280, height: 800, generation };
  }

  it('stops being driveable the moment the socket goes down', () => {
    // A takeover survives a transport gap: the server holds the lease across
    // the reconnect grace and the remote page keeps changing, but no frames can
    // reach this client. Left alone, the last JPEG stayed an interactive `<img>`
    // — and Socket.IO buffers what the person does against it and delivers it
    // on reconnect, so the click lands on whatever the page became.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'BEFORE', 4));
      fake.fire('browser:control', {
        conversationId: 'conv-a', taskId: 'task-a', human: true, capturing: true, confirmed: true,
      });
    });
    expect(view.result.current.browserFrame?.data).toBe('BEFORE');
    expect(view.result.current.browserConfirmed).toBe(true);

    act(() => { fake.drop(); fake.fire('disconnect'); });

    // The evidence of sight is gone, so the panel has nothing to drive.
    expect(view.result.current.browserFrame, 'no picture of a page nobody can see').toBeUndefined();
    expect(view.result.current.browserStreaming).toBe(false);
    expect(view.result.current.browserConfirmed).toBe(false);
    // But the hold is NOT invented away — it really does survive on the server,
    // and a client that decided its own ownership would be the failure this
    // panel exists to prevent, in the other direction.
    expect(view.result.current.browserHuman, 'the takeover is still theirs').toBe(true);

    // Anything they try now must not even reach the send buffer.
    act(() => {
      view.result.current.sendBrowserInput({ kind: 'text', text: 'secret' });
      view.result.current.setBrowserCapture(false);
    });
    expect(fake.sent.filter((m) => m.event === 'browser:input')).toHaveLength(0);
    expect(fake.sent.filter((m) => m.event === 'browser:capture')).toHaveLength(0);
    expect(fake.buffered, 'and Socket.IO is holding nothing to deliver later').toHaveLength(0);
  });

  it('starts a new viewing boundary when the socket comes back', () => {
    // The watch effect keys on the socket OBJECT, which survives a reconnect,
    // so it never re-runs — and the server, having received no unwatch, keeps
    // streaming to the rebound transport as though nothing happened. Something
    // has to invalidate the receipt this view gave before the gap.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'BEFORE', 4));
      fake.fire('browser:control', {
        conversationId: 'conv-a', taskId: 'task-a', human: true, capturing: true, confirmed: true,
      });
    });

    act(() => { fake.drop(); fake.fire('disconnect'); });
    act(() => { fake.restore(); fake.fire('connect'); });

    // Unwatch AND watch, in that order: a bare watch takes the server's
    // reconnect branch, which keeps the existing screencast, and an idle page
    // would then never repaint — leaving the panel inert with no way back.
    const watching = fake.sent
      .filter((m) => m.event === 'browser:unwatch' || m.event === 'browser:watch')
      .map((m) => m.event);
    expect(watching.slice(-2)).toEqual(['browser:unwatch', 'browser:watch']);

    // Still not driveable: the boundary is new and nothing has been seen yet.
    expect(view.result.current.browserFrame).toBeUndefined();
    expect(view.result.current.browserConfirmed).toBe(false);

    // Only a picture from the NEW watch, confirmed, brings the surface back.
    act(() => {
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'AFTER', 5));
      view.result.current.markBrowserFrameShown(5);
      fake.fire('browser:control', {
        conversationId: 'conv-a', taskId: 'task-a', human: true, capturing: true, confirmed: true,
      });
    });
    expect(view.result.current.browserFrame?.data).toBe('AFTER');
    expect(view.result.current.browserConfirmed).toBe(true);
    expect(
      fake.sent.filter((m) => m.event === 'browser:frame-seen').map((m) => m.payload),
      'and the new watch is what got confirmed',
    ).toContainEqual({ taskId: 'task-a', generation: 5 });

    act(() => { view.result.current.sendBrowserInput({ kind: 'text', text: 'ok' }); });
    expect(fake.sent.filter((m) => m.event === 'browser:input')).toHaveLength(1);
  });

  it('tells the server it actually has the picture, once per watch', () => {
    // Frames go out lossy — dropped, not queued, when the transport is not
    // writable — so handing one to the socket establishes nothing about what
    // arrived. Hiding the page is gated on this receipt instead, which is what
    // stops an honest stale client, whose Hide is still wired to `streaming`,
    // asking for a blind typing surface over a page it never received.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'AAAA', 7));
    });

    const seen = () => fake.sent.filter((m) => m.event === 'browser:frame-seen');
    // What the rendered <img> reports on `load` — the frame arriving is not
    // itself the receipt, which is the point of the test below this one.
    act(() => { view.result.current.markBrowserFrameShown(7); });
    expect(seen().map((m) => m.payload)).toEqual([{ taskId: 'task-a', generation: 7 }]);

    // Once per WATCH, not per frame: a busy page repaints constantly and every
    // repaint fires `load` again, so this would otherwise spend a reliable
    // round trip on each of them.
    act(() => {
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'BBBB', 7));
      view.result.current.markBrowserFrameShown(7);
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'CCCC', 7));
      view.result.current.markBrowserFrameShown(7);
    });
    expect(seen(), 'the same watch is confirmed once').toHaveLength(1);

    // A new watch is a new thing to confirm — the previous receipt names a
    // generation the server has already superseded.
    act(() => {
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'DDDD', 8));
      view.result.current.markBrowserFrameShown(8);
    });
    expect(seen().map((m) => m.payload)).toEqual([
      { taskId: 'task-a', generation: 7 },
      { taskId: 'task-a', generation: 8 },
    ]);
  });

  it('does not confirm a frame that arrived but was never rendered', () => {
    // Round 9's argument, one layer further down. The receipt used to be sent
    // from an effect keyed on the frame entering React state, which proves the
    // socket delivered bytes and nothing about whether they became a picture.
    // A slow client — or one handed a JPEG it cannot decode — would confirm a
    // page it has never shown anybody, and the confirmation is precisely what
    // opens Hide and the blind keyboard surface.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'UNDECODABLE', 9));
    });

    expect(view.result.current.browserFrame?.data, 'the bytes did arrive').toBe('UNDECODABLE');
    expect(
      fake.sent.filter((m) => m.event === 'browser:frame-seen'),
      'but nothing has said it rendered, so nothing is confirmed',
    ).toHaveLength(0);

    // The image reporting its own `load` is the only thing that confirms it.
    act(() => { view.result.current.markBrowserFrameShown(9); });
    expect(fake.sent.filter((m) => m.event === 'browser:frame-seen').map((m) => m.payload))
      .toEqual([{ taskId: 'task-a', generation: 9 }]);
  });

  it('does not confirm a picture it discarded', () => {
    // The routing guards run first: a frame this pane refused is not a frame
    // it received, and confirming it would vouch for a page nobody was shown.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-second'));
      // A late frame from the run this pane has replaced, and one naming no run.
      fake.fire('browser:frame', frame('conv-a', 'task-first', 'STALE', 3));
      fake.fire('browser:frame', { conversationId: 'conv-a', data: 'ORPHAN', width: 1, height: 1, generation: 4 });
    });

    // The receipt half of this test was DELETED rather than kept. It asserted
    // that neither frame was confirmed, and once the receipt moved to the
    // image's own `load` there is no image for a discarded frame, so nothing
    // in this test could call it and the assertion could no longer fail. The
    // property it was reaching for — a frame that arrives is not a frame that
    // was seen — is pinned above, where it can.
    expect(view.result.current.browserFrame, 'neither was shown').toBeUndefined();
  });

  it('shows each conversation the frames of its own browser', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:live-view', liveView('conv-b', 'task-b'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'AAAA'));
      fake.fire('browser:frame', frame('conv-b', 'task-b', 'BBBB'));
    });

    expect(view.result.current.browserFrame?.data).toBe('AAAA');
    act(() => { view.result.current.setConversationId('conv-b'); });
    expect(view.result.current.browserFrame?.data).toBe('BBBB');
  });

  it('keeps only the newest frame', () => {
    // A queue would spend memory rendering something already untrue, and the
    // server acks per frame precisely so a slow client falls behind by dropping
    // pictures rather than by growing a backlog.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'OLD'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'NEW'));
    });

    expect(view.result.current.browserFrame).toEqual({ data: 'NEW', width: 1280, height: 800, generation: 1 });
  });

  it('ignores a frame for a run this pane has no browser for', () => {
    // A frame outliving its run must not rebuild the panel: that would put a
    // Stop button on screen for a browser nobody holds, and the user would be
    // watching a still picture of a session that has already been closed.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => { fake.fire('browser:frame', frame('conv-a', 'task-gone', 'LATE')); });

    expect(view.result.current.browserActive).toBe(false);
    expect(view.result.current.browserFrame).toBeUndefined();
  });

  it('ignores a frame from a different run in the same conversation', () => {
    // Second run in the same chat: the panel exists, so the "no view" guard
    // above does not fire, and only the task id separates the new browser's
    // frames from the previous one's still in flight.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-second'));
      fake.fire('browser:frame', frame('conv-a', 'task-second', 'MINE'));
      fake.fire('browser:frame', frame('conv-a', 'task-first', 'STALE'));
    });

    expect(view.result.current.browserFrame?.data).toBe('MINE');
  });

  it('drops the picture when capture is paused', () => {
    // Hiding the page has to actually hide it. Keeping the last frame on
    // screen would show a page that may have changed since — the stale-picture
    // failure, dressed up as a working panel.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'BEFORE'));
      fake.fire('browser:control', { conversationId: 'conv-a', taskId: 'task-a', human: true, capturing: true });
    });
    expect(view.result.current.browserFrame?.data).toBe('BEFORE');

    act(() => {
      fake.fire('browser:control', { conversationId: 'conv-a', taskId: 'task-a', human: true, capturing: false });
    });
    expect(view.result.current.browserFrame, 'nothing to look at while it is paused').toBeUndefined();
    expect(view.result.current.browserCapturing).toBe(false);
  });

  it('ignores a browser message that names no run at all', () => {
    // The guard used to reject only when BOTH ids were present and differed,
    // so an untagged message landed in whichever pane was on screen. This
    // server always names the run, which is exactly why an unnamed message is
    // not something to route on a guess — and a picture of someone else's page
    // is worse than no picture.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:frame', { conversationId: 'conv-a', data: 'ORPHAN', width: 1, height: 1 });
      fake.fire('browser:watching', { conversationId: 'conv-a', streaming: true });
      fake.fire('browser:control', { conversationId: 'conv-a', human: true });
    });

    expect(view.result.current.browserFrame).toBeUndefined();
    expect(view.result.current.browserStreaming).toBe(false);
    expect(view.result.current.browserHuman).toBe(false);
  });

  it('records that the server actually started streaming, per conversation', () => {
    // Asking to watch and being watched are different facts: a provider that
    // refuses the screencast leaves the panel blank, and only the server's
    // answer distinguishes "waiting for the first frame" from "never coming".
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:live-view', liveView('conv-b', 'task-b'));
      fake.fire('browser:watching', { conversationId: 'conv-b', taskId: 'task-b', streaming: true });
    });

    // B's stream is B's. Borrowing it here would promise frames that are being
    // sent to another pane, and this one would wait for them forever.
    expect(view.result.current.browserStreaming, 'not another chat\'s stream').toBe(false);
    act(() => { view.result.current.setConversationId('conv-b'); });
    expect(view.result.current.browserStreaming).toBe(true);
  });

  it('ignores a watching reply about a run this conversation has replaced', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-second'));
      fake.fire('browser:watching', { conversationId: 'conv-a', taskId: 'task-first', streaming: true });
    });

    // The previous run's stream says nothing about this one's, and claiming it
    // does turns "waiting for the first frame" into a permanent lie.
    expect(view.result.current.browserStreaming).toBe(false);
  });

  it('follows who holds each conversation\'s page', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:live-view', liveView('conv-b', 'task-b'));
      fake.fire('browser:control', { conversationId: 'conv-b', taskId: 'task-b', human: true });
    });
    expect(view.result.current.browserHuman, 'not another chat\'s takeover').toBe(false);

    act(() => { view.result.current.setConversationId('conv-b'); });
    expect(view.result.current.browserHuman).toBe(true);
  });

  it('does not take control away over a refusal', () => {
    // A refusal is not a statement about who holds the page: an unknown key is
    // refused while the user still has it, and reading that as a loss of
    // control would close their panel over a keystroke.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:control', { conversationId: 'conv-a', taskId: 'task-a', human: true });
      fake.fire('browser:control', {
        conversationId: 'conv-a', taskId: 'task-a', detail: 'That key cannot be sent to the page.',
      });
    });

    expect(view.result.current.browserHuman).toBe(true);
    expect(view.result.current.browserNotice).toMatch(/cannot be sent/i);

    // And the next statement of ownership clears it, so a refusal does not
    // outlive the situation it described.
    act(() => {
      fake.fire('browser:control', { conversationId: 'conv-a', taskId: 'task-a', human: false });
    });
    expect(view.result.current.browserHuman).toBe(false);
    expect(view.result.current.browserNotice).toBeUndefined();
  });

  it('drives the browser this pane is showing, and only with its own run id', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    // No browser yet: every control is a no-op rather than an event the server
    // would have to decide about.
    act(() => {
      view.result.current.takeOverBrowser();
      view.result.current.sendBrowserInput({ kind: 'text', text: 'hello' });
    });
    expect(fake.sent.filter((m) => m.event.startsWith('browser:'))).toEqual([]);

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:live-view', liveView('conv-b', 'task-b'));
    });
    act(() => { view.result.current.setConversationId('conv-b'); });
    act(() => {
      view.result.current.takeOverBrowser();
      view.result.current.sendBrowserInput({ kind: 'click', x: 0.5, y: 0.5 });
      view.result.current.setBrowserCapture(false);
      view.result.current.handBackBrowser();
    });

    expect(fake.sent.filter((m) => ['browser:take-over', 'browser:input', 'browser:capture', 'browser:hand-back']
      .includes(m.event)))
      .toEqual([
        { event: 'browser:take-over', payload: { taskId: 'task-b' } },
        { event: 'browser:input', payload: { taskId: 'task-b', event: { kind: 'click', x: 0.5, y: 0.5 } } },
        { event: 'browser:capture', payload: { taskId: 'task-b', on: false } },
        { event: 'browser:hand-back', payload: { taskId: 'task-b' } },
      ]);
  });

  it('watches the browser on screen, and stops watching when it leaves', () => {
    // Frames cost the operator money to encode and ship, so the stream follows
    // what is actually being looked at rather than what happens to be running.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:live-view', liveView('conv-b', 'task-b'));
    });
    expect(fake.sent.filter((m) => m.event === 'browser:watch'))
      .toEqual([{ event: 'browser:watch', payload: { taskId: 'task-a' } }]);

    act(() => { view.result.current.setConversationId('conv-b'); });
    // B's browser, and A's stream shut off. The unwatch for B is the leading
    // half of its own viewing boundary, not a second thought about A.
    expect(fake.sent
      .filter((m) => m.event === 'browser:unwatch' || m.event === 'browser:watch')
      .map((m) => [m.event, (m.payload as { taskId: string }).taskId]))
      .toEqual([
        ['browser:unwatch', 'task-a'], ['browser:watch', 'task-a'],
        ['browser:unwatch', 'task-a'], ['browser:unwatch', 'task-b'], ['browser:watch', 'task-b'],
      ]);
  });

  it('starts a new viewing boundary on a page that reloaded into a live run', async () => {
    // A reload gets a brand-new socket; the run's screencast on the server is
    // not new. Nothing there stops watching when a socket drops, so it outlived
    // the previous page unwatched and the run is simply re-pointed at this
    // connection with the stream still attached.
    //
    // The connect handler cannot deal with that: a reloaded page learns its
    // task id from the REPLAYED live view, which lands well after `connect`.
    // So this falls to the watch effect — and a bare watch there takes the
    // server's reconnect branch, which keeps the surviving screencast. CDP
    // frames being adaptive, an idle page then repaints for nobody and the
    // panel stays blank for the life of the run.
    const fake = fakeSocket();
    renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    // Awaited: `connect` also kicks off the conversation reload, and letting it
    // settle here keeps this test about watching rather than about React.
    await act(async () => { fake.fire('connect'); });
    expect(fake.sent.filter((m) => m.event === 'browser:watch'),
      'nothing is watched on connect — the replay has not arrived yet').toHaveLength(0);

    act(() => { fake.fire('browser:live-view', liveView('conv-a', 'task-a')); });
    expect(fake.sent
      .filter((m) => m.event === 'browser:unwatch' || m.event === 'browser:watch')
      .map((m) => m.event), 'the replayed run is re-watched from scratch, not resumed')
      .toEqual(['browser:unwatch', 'browser:watch']);
  });
});
