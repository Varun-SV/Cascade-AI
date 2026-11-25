import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Socket } from 'socket.io-client';

const warm = vi.fn();
vi.mock('../lib/localModel/engine.js', () => ({ warmLocalModel: () => warm() }));
vi.mock('../lib/localModel/classifier.js', () => ({ classifyLocalComplexity: vi.fn(async () => null) }));
vi.mock('../lib/localModel/capability.js', () => ({ detectLocalModelCapability: () => ({ supported: true }) }));
vi.mock('../lib/prefs.js', async (orig) => ({ ...(await orig<typeof import('../lib/prefs.js')>()), localModelEnabled: () => true }));
vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  fetchFeedback: vi.fn(async () => ({ feedback: {} })),
  selectBranch: vi.fn(async () => ({ messages: [] })),
  deleteMessage: vi.fn(async () => ({ messages: [] })),
}));

import { useChatSession } from './useChatSession.js';

afterEach(() => { vi.useRealTimers(); localStorage.clear(); warm.mockClear(); });

describe('the on-device model', () => {
  it('starts loading only once a run has finished, never when the page opens', async () => {
    vi.useFakeTimers();
    let ack: ((r: unknown) => void) | undefined;
    const socket = {
      connected: true,
      on() { return this; },
      off() { return this; },
      emit(event: string, _payload?: unknown, cb?: (r: unknown) => void) { if (event === 'chat:run') ack = cb; return this; },
    } as unknown as Socket;
    const view = renderHook(() => useChatSession(socket, [], 'general'));
    // Long after the page opened: nothing loaded.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(warm).not.toHaveBeenCalled();
    act(() => { view.result.current.send({ prompt: 'hello there' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(ack).toBeDefined();
    // Still nothing while the run is going.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(warm).not.toHaveBeenCalled();
    // The answer is in: now it loads, once the browser is idle.
    await act(async () => { ack!({ conversationId: 'c1', totalTokens: 1 }); });
    expect(view.result.current.busy).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(warm).toHaveBeenCalledTimes(1);
  });
});
