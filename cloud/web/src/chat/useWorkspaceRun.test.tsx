import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';

const fetchWorkspaceDevices = vi.fn();
vi.mock('../lib/api.js', () => ({ fetchWorkspaceDevices: (...a: unknown[]) => fetchWorkspaceDevices(...a) }));
import { useWorkspaceRun } from './useWorkspaceRun.js';

function fakeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    fire(event: string, payload?: unknown) { for (const h of [...(handlers.get(event) ?? [])]) h(payload); },
    socket: {
      on(event: string, l: (...a: unknown[]) => void) { let s = handlers.get(event); if (!s) { s = new Set(); handlers.set(event, s); } s.add(l); return this; },
      off(event: string, l: (...a: unknown[]) => void) { handlers.get(event)?.delete(l); return this; },
    } as unknown as Socket,
  };
}

beforeEach(() => {
  fetchWorkspaceDevices.mockReset();
  fetchWorkspaceDevices.mockResolvedValue({ devices: [{ id: 'd1', name: 'Work PC', online: true }] });
});

describe('useWorkspaceRun', () => {
  it('does nothing, and asks for nothing, when the server has no workspace relay', () => {
    const fake = fakeSocket();
    const { result } = renderHook(() => useWorkspaceRun(fake.socket, false, 'c1', false));
    act(() => result.current.select('d1'));
    expect(fetchWorkspaceDevices).not.toHaveBeenCalled();
    expect(result.current.workspaceDeviceId).toBeUndefined();
    expect(result.current.enabled).toBe(false);
  });

  it('reads the devices, remembers the choice per conversation, and sends it only for that conversation', async () => {
    const fake = fakeSocket();
    const { result, rerender } = renderHook(({ c }) => useWorkspaceRun(fake.socket, true, c, false), { initialProps: { c: 'c1' as string | undefined } });
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    expect(result.current.workspaceDeviceId).toBeUndefined();
    act(() => result.current.select('d1'));
    expect(result.current.workspaceDeviceId).toBe('d1');
    rerender({ c: 'c2' });
    expect(result.current.workspaceDeviceId).toBeUndefined();
    rerender({ c: 'c1' });
    expect(result.current.workspaceDeviceId).toBe('d1');
    act(() => result.current.select(undefined));
    expect(result.current.workspaceDeviceId).toBeUndefined();
  });

  it('re-reads the list when asked (the picker opening)', async () => {
    const fake = fakeSocket();
    const { result } = renderHook(() => useWorkspaceRun(fake.socket, true, 'c1', false));
    await waitFor(() => expect(result.current.devicesKnown).toBe(true));
    fetchWorkspaceDevices.mockResolvedValue({ devices: [{ id: 'd1', name: 'Work PC', online: false }] });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.devices[0]!.online).toBe(false));
    expect(fetchWorkspaceDevices).toHaveBeenCalledTimes(2);
  });

  it('a first message carries the blank chat\'s choice to the conversation the server names', async () => {
    const fake = fakeSocket();
    const { result, rerender } = renderHook(({ c, busy }) => useWorkspaceRun(fake.socket, true, c, busy), { initialProps: { c: undefined as string | undefined, busy: false } });
    await waitFor(() => expect(result.current.devicesKnown).toBe(true));
    act(() => result.current.select('d1'));
    rerender({ c: undefined, busy: true });
    expect(result.current.awaitingConsent).toBe(true);
    // Opening another chat while that run starts carries nothing there.
    rerender({ c: 'existing', busy: true });
    expect(result.current.selected).toBeUndefined();
    // The run's own conversation, as the chat session reports it, gets its desktop.
    act(() => result.current.adoptFirstTurn('new-convo', 'd1'));
    rerender({ c: 'new-convo', busy: true });
    expect(result.current.selected).toBe('d1');
    rerender({ c: undefined, busy: false });
    expect(result.current.selected).toBeUndefined();
  });

  it('waits for consent until the workspace attaches, then shows the run and its changed files', async () => {
    const fake = fakeSocket();
    const { result, rerender } = renderHook(({ busy }) => useWorkspaceRun(fake.socket, true, 'c1', busy), { initialProps: { busy: false } });
    await waitFor(() => expect(result.current.devicesKnown).toBe(true));
    act(() => result.current.select('d1'));
    rerender({ busy: true });
    expect(result.current.awaitingConsent).toBe(true);
    expect(result.current.awaitingDeviceName).toBe('Work PC');
    act(() => fake.fire('workspace:attached', { conversationId: 'c1', runId: 'r1', label: 'proj', device: { id: 'd1', name: 'Work PC' }, tools: ['file_write'] }));
    expect(result.current.awaitingConsent).toBe(false);
    act(() => {
      fake.fire('workspace:call', { conversationId: 'c1', runId: 'r1', id: 'k1', tool: 'file_write', change: { kind: 'write', path: 'a.txt', content: 'x' } });
      fake.fire('workspace:waiting', { conversationId: 'c1', runId: 'r1', tool: 'file_write', worker: 'T3-1', label: 'proj', device: { id: 'd1', name: 'Work PC' } });
      // Another conversation's event does not land here.
      fake.fire('workspace:waiting', { conversationId: 'other', runId: 'r9', tool: 'shell' });
    });
    expect(result.current.view?.changes.map((f) => f.path)).toEqual(['a.txt']);
    expect(result.current.view?.waitingTool).toBe('file_write');
    act(() => fake.fire('workspace:result', { conversationId: 'c1', runId: 'r1', id: 'k1', tool: 'file_write', ok: true, worker: 'T3-1' }));
    expect(result.current.view?.waitingTool).toBeUndefined();
    // The run ending clears a wait the server never answered.
    act(() => fake.fire('workspace:waiting', { conversationId: 'c1', runId: 'r1', tool: 'file_delete' }));
    rerender({ busy: false });
    expect(result.current.view?.waitingTool).toBeUndefined();
  });

  it("the consent notice belongs to the run's own chat and computer, not to whichever chat is open", async () => {
    const fake = fakeSocket();
    const { result, rerender } = renderHook(({ c, busy }) => useWorkspaceRun(fake.socket, true, c, busy), { initialProps: { c: 'A' as string, busy: false } });
    await waitFor(() => expect(result.current.devicesKnown).toBe(true));
    // B is set to a desktop; A's run goes to Cloud.
    rerender({ c: 'B', busy: false });
    act(() => result.current.select('d1'));
    rerender({ c: 'A', busy: false });
    rerender({ c: 'A', busy: true });
    expect(result.current.awaitingConsent).toBe(false);
    // Looking at B while A's run goes: B's computer was never asked.
    rerender({ c: 'B', busy: true });
    expect(result.current.awaitingConsent).toBe(false);
    rerender({ c: 'B', busy: false });
    // Now B's run asks d1, and the notice stays with B.
    rerender({ c: 'B', busy: true });
    expect(result.current.awaitingConsent).toBe(true);
    expect(result.current.awaitingDeviceName).toBe('Work PC');
    rerender({ c: 'A', busy: true });
    expect(result.current.awaitingConsent).toBe(false);
    rerender({ c: 'B', busy: true });
    act(() => fake.fire('workspace:attached', { conversationId: 'B', runId: 'r2', label: 'proj', device: { id: 'd1', name: 'Work PC' }, tools: ['file_read'] }));
    expect(result.current.awaitingConsent).toBe(false);
  });

  it('stops listening when unmounted', async () => {
    const fake = fakeSocket();
    const { result, unmount } = renderHook(() => useWorkspaceRun(fake.socket, true, 'c1', true));
    await waitFor(() => expect(result.current.devicesKnown).toBe(true));
    unmount();
    expect(() => fake.fire('workspace:attached', { runId: 'r', label: 'l', device: { id: 'd', name: 'n' } })).not.toThrow();
  });
});
