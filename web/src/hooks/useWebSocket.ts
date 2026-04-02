import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

interface UseWebSocketOptions {
  url?: string;
  token?: string;
}

export function useWebSocket({ url = '/', token }: UseWebSocketOptions = {}) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<Array<{ type: string; data: unknown; ts: number }>>([]);

  useEffect(() => {
    const socket = io(url, {
      auth: token ? { token } : {},
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    const eventTypes = [
      'cascade:event', 'tier:status', 'stream:token',
      'tool:approval-request', 'plan',
    ];
    for (const ev of eventTypes) {
      socket.on(ev, (data: unknown) => {
        setEvents((prev) => [...prev.slice(-200), { type: ev, data, ts: Date.now() }]);
      });
    }

    return () => {
      socket.disconnect();
    };
  }, [url, token]);

  const emit = (event: string, data: unknown) => {
    socketRef.current?.emit(event, data);
  };

  const clearEvents = () => setEvents([]);

  return { connected, events, emit, clearEvents, socket: socketRef.current };
}
