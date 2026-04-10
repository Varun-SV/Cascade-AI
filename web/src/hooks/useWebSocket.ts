import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import parser from 'socket.io-msgpack-parser';
import { useAppDispatch } from '../store';
import type {
  PermissionRequest,
  RuntimeNode,
  RuntimeNodeLog,
  RuntimeRefreshPayload,
  RuntimeScope,
  RuntimeSession,
  RuntimeSnapshotPayload,
  SessionSubscriptionPayload,
} from '../types/protocol';
import {
  setConnected,
  updateRTKSnapshot,
  updateSessionDetails,
  appendLog,
} from '../store/slices/runtimeSlice';

export interface CostUpdate {
  totalCostUsd?: number;
  totalTokens?: number;
}

// ── Hook options ───────────────────────────────

interface UseWebSocketOptions {
  url?: string;
  token?: string;
  activeSessionId?: string | null;
  /** Called when the server requests a runtime refresh */
  onRuntimeRefresh?: (scope?: RuntimeScope) => void;
  /** Called on every streamed LLM token */
  onStreamToken?: (data: { text: string }) => void;
  /** Called on cost:update events */
  onCostUpdate?: (data: CostUpdate) => void;
  /** Called when the server requires a human permission decision */
  onEscalation?: (request: PermissionRequest) => void;
}

// ── Hook ───────────────────────────────────────

/**
 * Manages the Socket.IO connection.
 *
 * Returns a *reactive* socket reference — `socket` is `null` before the
 * connection is established and non-null once connected.  This allows
 * consumers to safely add `socket.on` listeners in a `useEffect([socket])`
 * without the previous stale-ref problem (ref.current is always null on the
 * first render because the socket is created inside an effect).
 *
 * All application-level event callbacks (cost, escalation, stream) are
 * registered here so consumers don't need to manage socket.on/off themselves.
 */
export function useWebSocket({
  url = '/',
  token,
  activeSessionId,
  onRuntimeRefresh,
  onStreamToken,
  onCostUpdate,
  onEscalation,
}: UseWebSocketOptions = {}) {
  // Reactive: causes re-render when the socket connects or disconnects
  const [socket, setSocket] = useState<Socket | null>(null);
  const dispatch = useAppDispatch();

  // Stable refs for callbacks — updating them never triggers reconnection
  const cbRefresh = useRef(onRuntimeRefresh);
  const cbStream = useRef(onStreamToken);
  const cbCost = useRef(onCostUpdate);
  const cbEscalation = useRef(onEscalation);
  cbRefresh.current = onRuntimeRefresh;
  cbStream.current = onStreamToken;
  cbCost.current = onCostUpdate;
  cbEscalation.current = onEscalation;

  // Ref for activeSessionId so the connect handler always sees the latest value
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const lastJoinedRef = useRef<string | null>(null);

  // ── Create / destroy socket ──────────────────
  useEffect(() => {
    const s = io(url, {
      auth: token ? { token } : {},
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      parser,
    });

    s.on('connect', () => {
      dispatch(setConnected(true));
      s.emit('runtime:refresh', { scope: 'workspace' } satisfies RuntimeRefreshPayload);

      // Rejoin last session room (uses ref so it's always fresh)
      const sid = activeSessionIdRef.current;
      if (sid) {
        s.emit('join:session', { sessionId: sid } satisfies SessionSubscriptionPayload);
        lastJoinedRef.current = sid;
      }

      setSocket(s);
    });

    s.on('disconnect', () => {
      dispatch(setConnected(false));
      setSocket(null);
    });

    // Redux-dispatched events
    s.on('runtime:update', (d: unknown) => {
      dispatch(updateRTKSnapshot(d as RuntimeSnapshotPayload));
    });

    s.on('session:details', (d: unknown) => {
      const payload = d as { sessionId: string; nodes: RuntimeNode[]; logs: RuntimeNodeLog[] };
      dispatch(updateSessionDetails(payload));
    });

    s.on('log:new', (d: unknown) => {
      dispatch(appendLog(d as RuntimeNodeLog));
    });

    // Callback-dispatched events (caller decides what state to set)
    s.on('runtime:refresh', (d: unknown) => {
      const p = d as RuntimeRefreshPayload | undefined;
      cbRefresh.current?.(p?.scope);
    });

    s.on('stream:token', (d: unknown) => {
      cbStream.current?.(d as { text: string });
    });

    s.on('cost:update', (d: unknown) => {
      cbCost.current?.(d as CostUpdate);
    });

    s.on('permission:user-required', (d: unknown) => {
      cbEscalation.current?.(d as PermissionRequest);
    });

    return () => {
      s.disconnect();
      setSocket(null);
      lastJoinedRef.current = null;
    };
    // url and token changes require a new socket connection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token, dispatch]);

  // ── Room switching ───────────────────────────
  useEffect(() => {
    if (!socket) return;
    if (activeSessionId === lastJoinedRef.current) return;

    if (lastJoinedRef.current) {
      socket.emit('leave:session', { sessionId: lastJoinedRef.current } satisfies SessionSubscriptionPayload);
    }
    if (activeSessionId) {
      socket.emit('join:session', { sessionId: activeSessionId } satisfies SessionSubscriptionPayload);
    }
    lastJoinedRef.current = activeSessionId ?? null;
  }, [socket, activeSessionId]);

  return { socket };
}
