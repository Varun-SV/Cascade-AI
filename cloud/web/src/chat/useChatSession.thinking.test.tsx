import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useChatSession } from './useChatSession.js';
import { setThinkingLevel } from '../lib/prefs.js';

vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  fetchFeedback: vi.fn(async () => ({ feedback: {} })),
  selectBranch: vi.fn(async () => ({ messages: [] })),
  deleteMessage: vi.fn(async () => ({ messages: [] })),
}));

function fakeSocket() {
  const sent: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    sent,
    socket: {
      connected: true,
      on() { return this; },
      off() { return this; },
      emit(event: string, payload?: unknown) { sent.push({ event, payload: (payload ?? {}) as Record<string, unknown> }); return this; },
    } as unknown as Socket,
  };
}
const lastRun = (fake: ReturnType<typeof fakeSocket>) => fake.sent.filter((e) => e.event === 'chat:run').at(-1)?.payload;

afterEach(() => localStorage.clear());

describe("the run's thinking level", () => {
  it('goes with the message to the server', async () => {
    setThinkingLevel('low');
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { view.result.current.send({ prompt: 'plan the migration' }); });
    await waitFor(() => expect(lastRun(fake)).toBeDefined());
    expect(lastRun(fake)?.['thinking']).toBe('low');
  });

  it('is left out for auto, the server default', async () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { view.result.current.send({ prompt: 'hello' }); });
    await waitFor(() => expect(lastRun(fake)).toBeDefined());
    expect(lastRun(fake)?.['thinking']).toBeUndefined();
  });
});
