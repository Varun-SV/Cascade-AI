import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { fetchWorkspaceDevices } from '../lib/api.js';
import {
  applyWorkspaceEvent, clearWaiting, parseWorkspaceEvent, workspaceDeviceForRun,
  type WorkspaceDevice, type WorkspaceEvent, type WorkspaceRunView,
} from '../lib/workspaceRun.js';

/**
 * Where a run works, and what it did there.
 *
 * The choice (Cloud, or one of the user's desktops) is remembered per conversation, in this
 * page only: a new chat starts on Cloud. The run's view (the folder's label, what is waiting
 * on the user's computer, the files it changed) comes from the server's `workspace:*` events
 * and is kept per conversation like the browser panel's. Nothing is stored or logged.
 *
 * `enabled` is `/api/config`'s `workspaceRelay`: with it off, this does nothing at all.
 */
export function useWorkspaceRun(socket: Socket | null, enabled: boolean, conversationId: string | undefined, busy: boolean) {
  const key = conversationId ?? '';
  const [devices, setDevices] = useState<WorkspaceDevice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [views, setViews] = useState<Record<string, WorkspaceRunView | undefined>>({});
  /** Whether the run now going has had its workspace attached: false means the computer is still being asked. */
  const [attachedThisRun, setAttachedThisRun] = useState(false);
  const keyRef = useRef(key);
  keyRef.current = key;

  /** Re-read the list. Called when the picker opens, so an app opened a moment ago shows as online. */
  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    fetchWorkspaceDevices().then(
      (r) => { setDevices(Array.isArray(r.devices) ? r.devices : []); setFailed(false); setLoading(false); },
      () => { setFailed(true); setLoading(false); },
    );
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * A first message starts a conversation with no id, and the server gives the run one:
   * the desktop that run was sent with goes with it, and the blank chat goes back to Cloud.
   * Called by the chat session for its own run's id only (`onFirstTurnConversation`), so
   * opening another chat while the first run starts carries nothing there.
   */
  const adoptFirstTurn = useCallback((conversationId: string, deviceId: string | undefined) => {
    setChoices((c) => {
      const { '': _blank, ...rest } = c;
      if (rest[conversationId] !== undefined || !deviceId) return c[''] === undefined ? c : rest;
      return { ...rest, [conversationId]: deviceId };
    });
  }, []);

  useEffect(() => {
    if (busy) return;
    setAttachedThisRun(false);
    // A run that is over is not waiting on anyone.
    setViews((v) => {
      let changed = false;
      const next: typeof v = {};
      for (const [k, view] of Object.entries(v)) {
        const cleared = clearWaiting(view);
        if (cleared !== view) changed = true;
        next[k] = cleared;
      }
      return changed ? next : v;
    });
  }, [busy]);

  useEffect(() => {
    if (!socket || !enabled) return;
    const on = (type: WorkspaceEvent['type']) => (raw: unknown) => {
      const parsed = parseWorkspaceEvent(type, raw);
      if (!parsed) return;
      const k = parsed.conversationId ?? keyRef.current;
      if (parsed.event.type === 'attached') setAttachedThisRun(true);
      setViews((v) => {
        const next = applyWorkspaceEvent(v[k], parsed.event);
        return next === v[k] ? v : { ...v, [k]: next };
      });
    };
    const handlers = (['attached', 'waiting', 'detached', 'call', 'result'] as const).map((t) => [`workspace:${t}`, on(t)] as const);
    for (const [name, fn] of handlers) socket.on(name, fn);
    return () => { for (const [name, fn] of handlers) socket.off(name, fn); };
  }, [socket, enabled]);

  const selected = enabled ? choices[key] : undefined;
  const select = useCallback((deviceId: string | undefined) => {
    setChoices((c) => {
      const next = { ...c };
      if (deviceId) next[keyRef.current] = deviceId; else delete next[keyRef.current];
      return next;
    });
  }, []);

  const deviceName = selected ? devices?.find((d) => d.id === selected)?.name : undefined;
  return {
    enabled,
    devices: devices ?? [],
    devicesKnown: devices !== null,
    loading,
    failed,
    refresh,
    /** The device chosen for this conversation, or undefined for Cloud. */
    selected,
    select,
    /** What goes in the run payload. */
    workspaceDeviceId: workspaceDeviceForRun(selected),
    /** For useChatSession's onFirstTurnConversation. */
    adoptFirstTurn,
    /** This run asked for a workspace and its computer has not answered yet. */
    awaitingConsent: enabled && busy && selected !== undefined && !attachedThisRun,
    awaitingDeviceName: deviceName ?? 'your computer',
    view: enabled ? views[key] : undefined,
  };
}
