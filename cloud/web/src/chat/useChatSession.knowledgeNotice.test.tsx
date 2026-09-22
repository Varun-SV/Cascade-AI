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

// One socket carries several conversations on plans that allow concurrent
// runs. `provider:exhausted` next door has filtered by conversation since it
// was written; this handler had not, so a background chat's trimming notice
// landed in whichever chat was open — telling a user their document had been
// cut when it had not been. Phase 0 made that reachable far more often by
// adding two more modes that emit it.
describe('useChatSession — the document-trimming notice', () => {
  it('shows the notice for the conversation the user is looking at', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    expect(fake.subscribed('knowledge:retrieved')).toBe(true);

    act(() => {
      fake.fire('knowledge:retrieved', {
        mode: 'fast', docCount: 2, keptChars: 40_000, totalChars: 200_000,
      });
    });

    expect(view.result.current.knowledgeNotice).toBeTruthy();
  });

  it('ignores one addressed to a different conversation', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => {
      fake.fire('knowledge:retrieved', {
        conversationId: 'some-other-conversation',
        mode: 'degraded', docCount: 1, keptChars: 10_000, totalChars: 500_000,
      });
    });

    expect(view.result.current.knowledgeNotice).toBeNull();
  });

  it('names the run budget, not the model, so it invents no limitation', () => {
    // The trim is against `cagCharBudget` — half the context window by default
    // — so a corpus can fit the model and still be cut. Saying the model could
    // not hold it sends the user to buy a bigger one for nothing.
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));

    act(() => {
      fake.fire('knowledge:retrieved', {
        mode: 'nokey', docCount: 1, keptChars: 50_000, totalChars: 100_000,
      });
    });

    const notice = view.result.current.knowledgeNotice ?? '';
    expect(notice).toContain("run's document budget");
    expect(notice).not.toContain('context window');
  });

  it('gives each reason its own remedy, because they are not the same problem', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    const fire = (mode: string) => act(() => {
      fake.fire('knowledge:retrieved', { mode, docCount: 1, keptChars: 1, totalChars: 2 });
    });

    fire('nokey');
    expect(view.result.current.knowledgeNotice).toContain('embeddings-capable key');

    fire('fast');
    expect(view.result.current.knowledgeNotice).toContain('Fast Answer');

    fire('degraded');
    expect(view.result.current.knowledgeNotice).toContain('could not run');
  });
});
