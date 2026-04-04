import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export interface RuntimeSession {
  sessionId: string;
  title: string;
  workspacePath: string;
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  updatedAt: string;
  latestPrompt?: string;
  isGlobal?: boolean;
}

export interface RuntimeNode {
  tierId: string;
  sessionId: string;
  parentId?: string;
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
  currentAction?: string;
  progressPct?: number;
  updatedAt: string;
  workspacePath?: string;
  isGlobal?: boolean;
}

export interface RuntimeNodeLog {
  id: string;
  sessionId: string;
  tierId: string;
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
  currentAction?: string;
  progressPct?: number;
  timestamp: string;
  workspacePath?: string;
  isGlobal?: boolean;
}

interface UseWebSocketOptions {
  url?: string;
  token?: string;
  onRuntimeUpdate?: (snapshot: RuntimeSnapshot) => void;
  onRuntimeRefresh?: (scope?: 'workspace' | 'global') => void;
}

export interface RuntimeSnapshot {
  scope?: string;
  source?: string;
  fetchedAt?: string;
  sessions: RuntimeSession[];
  nodes: RuntimeNode[];
  logs: RuntimeNodeLog[];
}

export function useWebSocket({ url = '/', token, onRuntimeUpdate, onRuntimeRefresh }: UseWebSocketOptions = {}) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<Array<{ type: string; data: unknown; ts: number }>>([]);
  const refreshTimerRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const requestedInitialRefreshRef = useRef(false);

  useEffect(() => {
    const socket = io(url, {
      auth: token ? { token } : {},
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 500,
      timeout: 10000,
    });

    socketRef.current = socket;

    const requestRuntime = () => {
      if (!requestedInitialRefreshRef.current) {
        requestedInitialRefreshRef.current = true;
        socket.emit('runtime:refresh', { scope: 'workspace' });
      }
    };

    socket.on('connect', () => {
      connectedRef.current = true;
      setConnected(true);
      requestRuntime();
    });
    socket.on('disconnect', () => {
      connectedRef.current = false;
      setConnected(false);
    });

    const eventTypes = [
      'cascade:event', 'tier:status', 'stream:token',
      'tool:approval-request', 'plan',
    ];
    for (const ev of eventTypes) {
      socket.on(ev, (data: unknown) => {
        setEvents((prev) => [...prev.slice(-200), { type: ev, data, ts: Date.now() }]);
      });
    }

    socket.on('runtime:update', (data: unknown) => {
      const snapshot = data as RuntimeSnapshot;
      setEvents((prev) => [...prev.slice(-200), { type: 'runtime:update', data: snapshot, ts: Date.now() }]);
      onRuntimeUpdate?.(snapshot);
    });

    socket.on('runtime:refresh', (data: unknown) => {
      const payload = data as { scope?: 'workspace' | 'global' } | undefined;
      setEvents((prev) => [...prev.slice(-200), { type: 'runtime:refresh', data: payload, ts: Date.now() }]);
      onRuntimeRefresh?.(payload?.scope);
    });

    if (refreshTimerRef.current) {
      window.clearInterval(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setInterval(() => {
      if (connectedRef.current) {
        socket.emit('runtime:refresh', { scope: 'workspace' });
      }
    }, 15000);

    return () => {
      if (refreshTimerRef.current) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      requestedInitialRefreshRef.current = false;
      socket.disconnect();
    };
  }, [url, token, onRuntimeUpdate, onRuntimeRefresh]);

  const emit = (event: string, data: unknown) => {
    socketRef.current?.emit(event, data);
  };

  const clearEvents = () => setEvents([]);

  return { connected, events, emit, clearEvents, socket: socketRef.current };
}
