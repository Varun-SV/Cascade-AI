import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useChatSession } from './useChatSession.js';

vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  fetchFeedback: vi.fn(async () => ({ feedback: {} })),
  selectBranch: vi.fn(async () => ({ messages: [] })),
  deleteMessage: vi.fn(async () => ({ messages: [] })),
}));

function fakeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const runAcks: Array<(a: unknown) => void> = [];
  const socket = {
    on(event: string, listener: (...args: unknown[]) => void) {
      let set = handlers.get(event);
      if (!set) { set = new Set(); handlers.set(event, set); }
      set.add(listener);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) { handlers.get(event)?.delete(listener); return this; },
    connected: true,
    connect() { return this; },
    emit(event: string, _payload: unknown, ack?: (a: unknown) => void) {
      if (event === 'chat:run' && ack) runAcks.push(ack);
      return this;
    },
  };
  return {
    ackRun(conversationId: string) { runAcks.shift()?.({ conversationId, output: 'done' }); },
    socket: socket as unknown as Socket,
  };
}

// The sidebar marks the chats a run is working in. Deriving that from the chat
// on screen moved the marker onto whatever the user opened mid-run.
describe('runningConversationIds', () => {
  it('stays on the chat the run belongs to while the user looks at another', async () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));
    act(() => { void view.result.current.send({ prompt: 'summarise the repo' }); });
    await waitFor(() => expect(view.result.current.busy).toBe(true));
    expect(view.result.current.runningConversationIds).toEqual(['conv-a']);

    await act(async () => { view.result.current.setConversationId('conv-b'); });
    expect(view.result.current.conversationId).toBe('conv-b');
    expect(view.result.current.runningConversationIds).toEqual(['conv-a']);

    act(() => { fake.ackRun('conv-a'); });
    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(view.result.current.runningConversationIds).toEqual([]);
  });
});
