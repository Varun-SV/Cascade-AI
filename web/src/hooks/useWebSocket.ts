import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import parser from 'socket.io-msgpack-parser';
import { useAppDispatch } from '../store';
import { setConnected, updateRTKSnapshot, updateSessionDetails, appendLog } from '../store/slices/runtimeSlice';

// Interfaces remain the same for now to maintain compatibility
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

export interface RuntimeSnapshot {
  scope?: string;
  source?: string;
  fetchedAt?: string;
  sessions: RuntimeSession[];
  nodes: RuntimeNode[];
  logs: RuntimeNodeLog[];
}

interface UseWebSocketOptions {
  url?: string;
  token?: string;
  activeSessionId?: string | null;
  onRuntimeRefresh?: (scope?: 'workspace' | 'global') => void;
  onStreamToken?: (data: { text: string }) => void;
}

export function useWebSocket({ url = '/', token, activeSessionId, onRuntimeRefresh, onStreamToken }: UseWebSocketOptions = {}) {
  const socketRef = useRef<Socket | null>(null);
  const dispatch = useAppDispatch();
  const [events, setEvents] = useState<Array<{ type: string; data: unknown; ts: number }>>([]);
  const refreshTimerRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const lastJoinedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const socket = io(url, {
      auth: token ? { token } : {},
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      parser,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      connectedRef.current = true;
      dispatch(setConnected(true));
      socket.emit('runtime:refresh', { scope: 'workspace' });
      
      // Re-join session room if we had one
      if (activeSessionId) {
        socket.emit('join:session', { sessionId: activeSessionId });
        lastJoinedSessionRef.current = activeSessionId;
      }
    });

    socket.on('disconnect', () => {
      connectedRef.current = false;
      dispatch(setConnected(false));
    });

    socket.on('runtime:update', (data: unknown) => {
      const snapshot = data as RuntimeSnapshot;
      dispatch(updateRTKSnapshot(snapshot));
    });

    socket.on('session:details', (data: unknown) => {
      const details = data as { sessionId: string; nodes: RuntimeNode[]; logs: RuntimeNodeLog[] };
      dispatch(updateSessionDetails(details));
    });

    socket.on('log:new', (data: unknown) => {
      const log = data as RuntimeNodeLog;
      dispatch(appendLog(log));
    });

    socket.on('runtime:refresh', (data: unknown) => {
      const payload = data as { scope?: 'workspace' | 'global' } | undefined;
      onRuntimeRefresh?.(payload?.scope);
    });
    
    socket.on('stream:token', (data: unknown) => {
      onStreamToken?.(data as { text: string });
    });

    const genericEvents = ['tier:status', 'tool:approval-request', 'plan'];
    for (const ev of genericEvents) {
      socket.on(ev, (data: unknown) => {
        setEvents((prev) => [...prev.slice(-100), { type: ev, data, ts: Date.now() }]);
      });
    }

    return () => {
      socket.disconnect();
    };
  }, [url, token, dispatch, onRuntimeRefresh, onStreamToken]);

  // Handle room switching
  useEffect(() => {
    if (socketRef.current && connectedRef.current && activeSessionId !== lastJoinedSessionRef.current) {
      if (lastJoinedSessionRef.current) {
        socketRef.current.emit('leave:session', { sessionId: lastJoinedSessionRef.current });
      }
      if (activeSessionId) {
        socketRef.current.emit('join:session', { sessionId: activeSessionId });
      }
      lastJoinedSessionRef.current = activeSessionId || null;
    }
  }, [activeSessionId]);

  return { events, socket: socketRef.current };
}
