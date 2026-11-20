import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    fire(event: string, payload?: unknown) { for (const h of [...(handlers.get(event) ?? [])]) h(payload); },
    socket: {
      connected: true,
      on(event: string, l: (...a: unknown[]) => void) { let s = handlers.get(event); if (!s) { s = new Set(); handlers.set(event, s); } s.add(l); return this; },
      off(event: string, l: (...a: unknown[]) => void) { handlers.get(event)?.delete(l); return this; },
      emit(event: string, payload: unknown) { sent.push([event, payload]); return this; },
    } as unknown as Socket,
  };
}

describe("useChatSession — a run in the user's own browser", () => {
  it('keeps the device it runs on and each step, newest last, for that run only', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { fake.fire('browser:live-view', { taskId: 't1', active: true, device: { name: 'Work laptop' } }); });
    expect(view.result.current.browserDevice).toEqual({ name: 'Work laptop' });

    act(() => {
      fake.fire('browser:step', { taskId: 't1', step: { kind: 'navigate', summary: 'Opened a.test', ok: true, at: 1, url: 'https://a.test/', title: 'A' } });
      fake.fire('browser:step', { taskId: 't1', step: { kind: 'click', summary: 'Clicked element e2', ok: false, at: 2 } });
      // Another run's step, and a malformed one: neither lands here.
      fake.fire('browser:step', { taskId: 't-other', step: { kind: 'click', summary: 'x', ok: true, at: 3 } });
      fake.fire('browser:step', { taskId: 't1', step: { kind: 'click' } });
    });
    expect(view.result.current.browserSteps?.map((s) => s.summary)).toEqual(['Opened a.test', 'Clicked element e2']);
  });

  it('keeps only the last 50 steps', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { fake.fire('browser:live-view', { taskId: 't1', active: true, device: { name: 'Work laptop' } }); });
    act(() => { for (let i = 0; i < 60; i++) fake.fire('browser:step', { taskId: 't1', step: { kind: 'scroll', summary: `step ${i}`, ok: true, at: i } }); });
    expect(view.result.current.browserSteps).toHaveLength(50);
    expect(view.result.current.browserSteps?.at(-1)?.summary).toBe('step 59');
  });

  it('a step says which of the run\'s tabs it was in, when it is a tab number', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { fake.fire('browser:live-view', { taskId: 't1', active: true, device: { name: 'Work laptop' } }); });
    act(() => {
      fake.fire('browser:step', { taskId: 't1', step: { kind: 'navigate', summary: 'Opened b.test', ok: true, at: 1, tab: 2 } });
      fake.fire('browser:step', { taskId: 't1', step: { kind: 'navigate', summary: 'Opened c.test', ok: true, at: 2, tab: 99 } });
    });
    expect(view.result.current.browserSteps?.map((s) => s.tab)).toEqual([2, undefined]);
  });

  it('Show the window asks the server for this run', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general'));
    act(() => { fake.fire('browser:live-view', { taskId: 't1', active: true, device: { name: 'Work laptop' } }); });
    act(() => { view.result.current.focusBrowser(); });
    expect(fake.sent).toContainEqual(['browser:focus', { taskId: 't1' }]);
  });
});
