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
  return {
    sent,
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
      emit(event: string, payload: unknown) { sent.push({ event, payload }); return this; },
    } as unknown as Socket,
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
