// ─────────────────────────────────────────────
//  Cascade extension — CDP over chrome.debugger, for one tab
// ─────────────────────────────────────────────
//
//  The relay and the policy speak to a `CdpClient`. On the CLI that's a DevTools
//  WebSocket; here it's the extension's one debugger attachment to the run's tab.
//  Several clients can share that attachment: each sees every event, and closing one
//  only stops it. The attachment itself is the tab policy's to make and to end.
//
//  Child targets (out-of-process frames, workers) come as flat sessions, which
//  chrome.debugger carries as `sessionId` beside the tab.

import type { CdpClient, CdpMessage } from '../../src/browser/relay/cdp-client.js';

/** The slice of chrome.debugger used, so a test can stand in for it. */
export interface DebuggerApi {
  sendCommand(target: { tabId: number; sessionId?: string }, method: string, params?: object): Promise<unknown>;
  onEvent: { addListener(fn: (source: { tabId?: number; sessionId?: string }, method: string, params?: object) => void): void; removeListener(fn: (...a: never[]) => void): void };
  onDetach: { addListener(fn: (source: { tabId?: number }, reason: string) => void): void; removeListener(fn: (...a: never[]) => void): void };
}

export function chromeTabCdp(tabId: number, api: DebuggerApi = chrome.debugger as unknown as DebuggerApi): CdpClient {
  let closed = false;
  const listeners: ((m: CdpMessage) => void)[] = [];
  const closers: (() => void)[] = [];
  const onEvent = (source: { tabId?: number; sessionId?: string }, method: string, params?: object): void => {
    if (closed || source.tabId !== tabId) return;
    const msg: CdpMessage = { method, params: (params ?? {}) as Record<string, unknown>, ...(source.sessionId ? { sessionId: source.sessionId } : {}) };
    for (const fn of listeners) fn(msg);
  };
  const shut = (): void => {
    if (closed) return;
    closed = true;
    api.onEvent.removeListener(onEvent as never);
    api.onDetach.removeListener(onDetach as never);
    for (const fn of closers) fn();
  };
  const onDetach = (source: { tabId?: number }): void => { if (source.tabId === tabId) shut(); };
  api.onEvent.addListener(onEvent);
  api.onDetach.addListener(onDetach);
  return {
    get closed() { return closed; },
    async send(method, params = {}, sessionId) {
      if (closed) throw new Error('CDP connection closed');
      try {
        return ((await api.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params)) ?? {}) as Record<string, unknown>;
      } catch (e) {
        // chrome.debugger reports a CDP error as a JSON string in the message.
        const text = e instanceof Error ? e.message : String(e);
        let message = text;
        try { const parsed = JSON.parse(text) as { message?: unknown }; if (typeof parsed?.message === 'string') message = parsed.message; } catch { /* plain text */ }
        throw new Error(message);
      }
    },
    on(fn) { listeners.push(fn); },
    onClose(fn) { closers.push(fn); },
    close: shut,
  };
}
