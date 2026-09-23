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
  return {
    subscribed: (event: string) => (handlers.get(event)?.size ?? 0) > 0,
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
      emit() { return this; },
    } as unknown as Socket,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('useChatSession — the browser was busy', () => {
  it('says so, in words, when this run is refused the browser', () => {
    // The refusal reached the model and nobody else. A run that narrated it,
    // or papered over it, left the person with no sign the browser was never
    // used, and no idea that waiting would fix it.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    expect(fake.subscribed('browser:busy')).toBe(true);

    act(() => { fake.fire('browser:busy', { taskId: 't1', limit: 1 }); });

    expect(view.result.current.browserRefusedNotice).toBe(
      'The browser is busy: its one session is in use by another run, so this run could not open it. Try again when that run finishes.',
    );
  });

  it('counts the sessions when the deployment allows more than one', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('browser:busy', { taskId: 't1', limit: 3 }); });

    expect(view.result.current.browserRefusedNotice).toContain('all 3 sessions are in use by another run');
  });

  it('ignores a refusal belonging to a different conversation', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('browser:busy', { conversationId: 'some-other-conversation', taskId: 't9', limit: 1 }); });

    expect(view.result.current.browserRefusedNotice).toBeNull();
  });

  it('withdraws it when the run gets the browser after all', () => {
    // The other run finished and a retry opened a session: "could not open it"
    // is no longer true of this run, and leaving it up would say it was.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('browser:busy', { taskId: 't1', limit: 1 }); });
    expect(view.result.current.browserRefusedNotice).toBeTruthy();

    act(() => { fake.fire('browser:live-view', { taskId: 't1', active: true }); });
    expect(view.result.current.browserRefusedNotice).toBeNull();
  });

  it('stays with the conversation it happened in', () => {
    // One slot carried conversation A's refusal into B when you switched.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { view.result.current.setConversationId('conv-A'); });
    act(() => { fake.fire('browser:busy', { conversationId: 'conv-A', taskId: 't1', limit: 1 }); });
    expect(view.result.current.browserRefusedNotice).toBeTruthy();

    act(() => { view.result.current.setConversationId('conv-B'); });
    expect(view.result.current.browserRefusedNotice, 'not in the chat you moved to').toBeNull();

    act(() => { view.result.current.setConversationId('conv-A'); });
    expect(view.result.current.browserRefusedNotice, 'and still there when you come back').toBeTruthy();
  });

  it('is withdrawn only by the refused run getting the browser, not by a sibling run', () => {
    // Two runs in one conversation: the other one opening a browser says
    // nothing about the run that was refused.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { fake.fire('browser:busy', { taskId: 't1', limit: 1 }); });

    act(() => { fake.fire('browser:live-view', { taskId: 't2', active: true }); });
    expect(view.result.current.browserRefusedNotice, 'still true of t1').toBeTruthy();

    act(() => { fake.fire('browser:live-view', { taskId: 't1', active: true }); });
    expect(view.result.current.browserRefusedNotice).toBeNull();
  });

  it('clears when the next run starts, which may find the browser free', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('browser:busy', { taskId: 't1', limit: 1 }); });
    act(() => { view.result.current.send({ prompt: 'try again' }); });

    expect(view.result.current.browserRefusedNotice).toBeNull();
  });

  it('unsubscribes on teardown', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    view.unmount();
    expect(fake.subscribed('browser:busy')).toBe(false);
  });
});

describe('useChatSession — today\u2019s browser sessions were used up', () => {
  const detail = "Today's browser sessions are used up (5 a day on the free plan). They reset at midnight UTC. Pro includes 50 a day.";

  it('shows the server\u2019s own words, which are also what the model was told', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    expect(fake.subscribed('browser:limit')).toBe(true);

    act(() => { fake.fire('browser:limit', { taskId: 't1', detail }); });

    expect(view.result.current.browserRefusedNotice).toBe(detail);
  });

  it('ignores a refusal belonging to a different conversation', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('browser:limit', { conversationId: 'some-other-conversation', taskId: 't9', detail }); });

    expect(view.result.current.browserRefusedNotice).toBeNull();
  });

  it('keeps another chat\u2019s refusal when this chat starts a run', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { view.result.current.setConversationId('conv-A'); });
    act(() => { fake.fire('browser:limit', { conversationId: 'conv-A', taskId: 't1', detail }); });

    act(() => { view.result.current.setConversationId('conv-B'); });
    act(() => { view.result.current.send({ prompt: 'something else' }); });
    act(() => { view.result.current.setConversationId('conv-A'); });

    expect(view.result.current.browserRefusedNotice, 'B\u2019s run says nothing about A\u2019s').toBe(detail);
  });

  it('clears when the next run starts', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('browser:limit', { taskId: 't1', detail }); });
    act(() => { view.result.current.send({ prompt: 'without the browser, then' }); });

    expect(view.result.current.browserRefusedNotice).toBeNull();
  });

  it('unsubscribes on teardown', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    view.unmount();
    expect(fake.subscribed('browser:limit')).toBe(false);
  });
});
