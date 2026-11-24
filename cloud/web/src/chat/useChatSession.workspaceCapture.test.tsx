import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';

// The on-device classifier is on, and answers only when the test says so.
let answer!: (hint: string | null) => void;
vi.mock('../lib/localModel/classifier.js', () => ({
  classifyLocalComplexity: vi.fn(() => new Promise<string | null>((r) => { answer = r; })),
}));
vi.mock('../lib/localModel/capability.js', () => ({ detectLocalModelCapability: () => ({ supported: true }) }));
vi.mock('../lib/localModel/engine.js', () => ({ warmLocalModel: vi.fn(async () => {}) }));
vi.mock('../lib/prefs.js', async (orig) => ({ ...(await orig<typeof import('../lib/prefs.js')>()), localModelEnabled: () => true }));
vi.mock('../lib/api.js', () => ({
  getMessages: vi.fn(async () => ({ messages: [] })),
  fetchFeedback: vi.fn(async () => ({ feedback: {} })),
  selectBranch: vi.fn(async () => ({ messages: [] })),
  deleteMessage: vi.fn(async () => ({ messages: [] })),
}));

import { useChatSession } from './useChatSession.js';

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

afterEach(() => localStorage.clear());

describe('the desktop a run works on', () => {
  it('is the one chosen when the message was sent, even if the classifier answers after a switch', async () => {
    const fake = fakeSocket();
    let chosen: string | undefined = 'desk-a';
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, undefined, true, () => chosen));
    act(() => { view.result.current.send({ prompt: 'refactor the parser module' }); });
    // The user opens a chat that works on another computer before the classifier answers.
    chosen = 'desk-b';
    await act(async () => { answer('Complex'); });
    await waitFor(() => expect(fake.sent.some((e) => e.event === 'chat:run')).toBe(true));
    expect(fake.sent.find((e) => e.event === 'chat:run')?.payload['workspaceDeviceId']).toBe('desk-a');
  });
});
