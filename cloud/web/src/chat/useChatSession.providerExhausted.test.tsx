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

describe('useChatSession — a provider going out mid-run', () => {
  it('surfaces the account switch, naming where the spend moved', () => {
    // The policy this whole path exists for is "continue on another provider,
    // but say so". The server forwards the event; if nothing here subscribes,
    // Socket.IO drops it and a hosted user is never told their run changed
    // accounts — which is worse than for the CLI, since nobody is watching a
    // terminal.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    expect(fake.subscribed('provider:exhausted')).toBe(true);

    act(() => {
      fake.fire('provider:exhausted', {
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        kind: 'quota_exhausted',
        message: 'Quota or billing limit reached on gemini-2.5-flash.',
        failedOverTo: 'azure:prod-gpt5',
      });
    });

    const notice = view.result.current.providerNotice;
    expect(notice).toBeTruthy();
    expect(notice).toContain('gemini');
    // The account the spend moved TO is the part a user acts on.
    expect(notice).toContain('azure:prod-gpt5');
    expect(notice).toMatch(/billed to that account/i);
  });

  it('says nothing about a switch when there was nowhere to switch to', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => {
      fake.fire('provider:exhausted', {
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        kind: 'quota_exhausted',
        message: 'Quota or billing limit reached on gemini-2.5-flash.',
      });
    });

    const notice = view.result.current.providerNotice;
    expect(notice).toContain('gemini');
    expect(notice).not.toMatch(/continuing on/i);
  });

  it('clears the banner when the next run starts', () => {
    // The banner says "out for THIS run", and the router clears its verdicts at
    // the run boundary — so leaving it up would keep telling the user their
    // spend is on another account after it has already moved back.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => {
      fake.fire('provider:exhausted', {
        provider: 'gemini', modelId: 'gemini-2.5-flash', kind: 'quota_exhausted',
        message: 'Quota or billing limit reached.', failedOverTo: 'azure:prod-gpt5',
      });
    });
    expect(view.result.current.providerNotice).toBeTruthy();

    act(() => { view.result.current.send({ prompt: 'a new question' }); });

    expect(view.result.current.providerNotice).toBeNull();
  });

  it('unsubscribes on teardown, so a remounted session does not double-report', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    expect(fake.subscribed('provider:exhausted')).toBe(true);

    view.unmount();

    expect(fake.subscribed('provider:exhausted')).toBe(false);
  });
});
