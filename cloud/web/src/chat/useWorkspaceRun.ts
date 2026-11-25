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
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const [views, setViews] = useState<Record<string, WorkspaceRunView | undefined>>({});
  /**
   * The run now going, as it was sent: its conversation (the blank chat's '' until the
   * server names it) and the desktop it asked for. The consent notice is about this run
   * only, wherever the user looks meanwhile; `attached` is whether its computer answered.
   */
  const [run, setRun] = useState<{ key: string; deviceId: string | undefined; attached: boolean; named?: string } | null>(null);

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
    setRun((r) => (r && r.key === '' ? { ...r, key: conversationId } : r));
    setChoices((c) => {
      const { '': _blank, ...rest } = c;
      if (rest[conversationId] !== undefined || !deviceId) return c[''] === undefined ? c : rest;
      return { ...rest, [conversationId]: deviceId };
    });
  }, []);

  // A run starts: what it was sent with is what the composer shows now, the moment of the send.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const started = busy && !wasBusy.current;
    wasBusy.current = busy;
    if (started) setRun({ key: keyRef.current, deviceId: enabled ? choicesRef.current[keyRef.current] : undefined, attached: false });
  }, [busy, enabled]);

  useEffect(() => {
    if (busy) return;
    setRun(null);
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
    // Listened for whether or not /api/config has answered yet: a reload's replay (the
    // run's attachment first) can arrive before it, and is sent once. The server sends
    // these only when it has workspaces on, and what is shown still waits for `enabled`.
    if (!socket) return;
    const on = (type: WorkspaceEvent['type']) => (raw: unknown) => {
      const parsed = parseWorkspaceEvent(type, raw);
      if (!parsed) return;
      const k = parsed.conversationId ?? keyRef.current;
      // Its own run's computer answered (a first turn's id may not be adopted yet).
      // A first turn's chat has no id in the page until the run ends: the id its workspace
      // events carry is remembered, so the blank chat shows its workspace while it runs.
      if (parsed.event.type === 'attached') setRun((r) => (r && (r.key === k || r.key === '') ? { ...r, attached: true, ...(r.key === '' ? { named: k } : {}) } : r));
      setViews((v) => {
        const next = applyWorkspaceEvent(v[k], parsed.event);
        return next === v[k] ? v : { ...v, [k]: next };
      });
    };
    const handlers = (['attached', 'waiting', 'detached', 'call', 'result'] as const).map((t) => [`workspace:${t}`, on(t)] as const);
    for (const [name, fn] of handlers) socket.on(name, fn);
    return () => { for (const [name, fn] of handlers) socket.off(name, fn); };
  }, [socket]);

  const selected = enabled ? choices[key] : undefined;
  const select = useCallback((deviceId: string | undefined) => {
    setChoices((c) => {
      const next = { ...c };
      if (deviceId) next[keyRef.current] = deviceId; else delete next[keyRef.current];
      return next;
    });
  }, []);

  const askedDevice = run?.deviceId;
  const deviceName = askedDevice ? devices?.find((d) => d.id === askedDevice)?.name : undefined;
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
    awaitingConsent: enabled && busy && !!run && run.deviceId !== undefined && !run.attached && run.key === key,
    awaitingDeviceName: deviceName ?? 'your computer',
    view: enabled ? (views[key] ?? (key === '' && run?.key === '' && run.named ? views[run.named] : undefined)) : undefined,
  };
}
