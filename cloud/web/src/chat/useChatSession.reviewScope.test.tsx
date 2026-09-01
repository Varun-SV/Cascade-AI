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

const rejection = {
  tierId: 'T1', role: 'T1', status: 'IN_PROGRESS',
  currentAction: 'Review found 2 gaps — replanning, pass 1 of 2',
  review: { summary: 'Two things are missing', gaps: [{ title: 'no sources' }, { title: 'one thesis' }] },
};

beforeEach(() => { vi.clearAllMocks(); });

describe('which conversation a review belongs to', () => {
  it('shows a review from the first run of a brand-new chat', () => {
    // The server tags every tier:status with the conversation id it just
    // created, but this side does not learn that id until the run's closing
    // ack. Comparing against `undefined` therefore discarded the whole first
    // run — every status, every activity node and the review card — in the
    // most common case there is.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => { fake.fire('tier:status', { ...rejection, conversationId: 'server-made-this-one' }); });

    expect(view.result.current.activity).toHaveLength(1);
    expect(view.result.current.activity[0]?.review?.gaps).toHaveLength(2);
  });

  it('ignores a review from another conversation once this one is known', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'mine'));

    act(() => { fake.fire('tier:status', { ...rejection, conversationId: 'someone-elses' }); });

    expect(view.result.current.activity).toHaveLength(0);
  });

  it('shows one from this conversation', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'mine'));

    act(() => { fake.fire('tier:status', { ...rejection, conversationId: 'mine' }); });

    expect(view.result.current.activity[0]?.review?.gaps).toHaveLength(2);
  });

  it('drops the card when a later pass approves', () => {
    // An approved verdict carries no gaps, which is how the client tells
    // "this pass passed" from "this event has no review to report".
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'mine'));

    act(() => { fake.fire('tier:status', { ...rejection, conversationId: 'mine' }); });
    expect(view.result.current.activity[0]?.review).toBeTruthy();

    act(() => {
      fake.fire('tier:status', {
        tierId: 'T1', role: 'T1', status: 'IN_PROGRESS', conversationId: 'mine',
        currentAction: 'Review passed', review: { approved: true, gaps: [] },
      });
    });
    expect(view.result.current.activity[0]?.review).toBeUndefined();
  });
});
