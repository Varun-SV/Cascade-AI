import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { ActivityBar } from './layout/ActivityBar.js';
import { TitleBar } from './layout/TitleBar.js';
import { MainContent } from './layout/MainContent.js';
import { BottomPanel } from './layout/BottomPanel.js';
import { StatusBar } from './layout/StatusBar.js';
import { HelpPanel } from './help/HelpPanel.js';
import {
  useAppDispatch, useAppSelector,
  setConnected, setReconnecting, setMeta, updateCost, upsertAgent, updateLastMessage, appendMessage,
} from './store/index.js';
import { SettingsView } from './views/SettingsView.js';

// Extend window for the Electron preload bridge
declare global {
  interface Window {
    cascade?: {
      platform: string;
      getMeta(): Promise<{ port: number; token: string; platform: string; version: string }>;
      pty: {
        spawn(cwd: string): Promise<{ ok: boolean; error?: string }>;
        write(data: string): void;
        resize(cols: number, rows: number): void;
        kill(): void;
        onData(cb: (data: string) => void): void;
        onExit(cb: () => void): void;
      };
      fs: {
        readDir(path: string): Promise<Array<{ name: string; fullPath: string; isDirectory: boolean }>>;
        readFile(path: string): Promise<string>;
      };
    };
  }
}

export function App() {
  const dispatch = useAppDispatch();
  const { backendPort, authToken, helpContext, showSettings } = useAppSelector((s) => s.app);
  const socketRef = useRef<Socket | null>(null);

  // Fetch Electron meta (port + token) from preload bridge
  useEffect(() => {
    if (window.cascade) {
      window.cascade.getMeta().then((meta) => {
        dispatch(setMeta({ port: meta.port, token: meta.token }));
      });
    } else {
      // Dev fallback: connect to the Vite-proxied backend
      dispatch(setMeta({ port: 3000, token: '' }));
    }
  }, [dispatch]);

  // Connect to Socket.IO backend once port is known
  useEffect(() => {
    if (!backendPort) return;
    const socket = io(`http://localhost:${backendPort}`, {
      auth: { token: authToken },
      transports: ['websocket'],
    });
    socketRef.current = socket;

    socket.on('connect', () => { dispatch(setConnected(true)); dispatch(setReconnecting(false)); });
    socket.on('disconnect', () => dispatch(setConnected(false)));
    socket.on('connect_error', () => dispatch(setReconnecting(true)));
    socket.on('reconnect', () => { dispatch(setConnected(true)); dispatch(setReconnecting(false)); });

    socket.on('cost:update', (data: { totalCostUsd: number; totalTokens: number }) => {
      dispatch(updateCost(data));
    });

    socket.on('tier:status', (data: {
      tierId: string; role: string; label: string; status: string;
      progressPct?: number; currentAction?: string; parentId?: string;
    }) => {
      dispatch(upsertAgent({
        id: data.tierId,
        tier: data.role as 'T1' | 'T2' | 'T3',
        label: data.label,
        status: data.status as never,
        progressPct: data.progressPct,
        currentAction: data.currentAction,
        parentId: data.parentId,
      }));
    });

    socket.on('stream:token', (data: { text: string }) => {
      dispatch(updateLastMessage({ content: data.text, streaming: true }));
    });

    return () => { socket.disconnect(); };
  }, [backendPort, authToken, dispatch]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Custom draggable title bar (replaces native OS chrome/menu) */}
      <TitleBar />
      {/* Main area: activity bar + content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <ActivityBar />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <MainContent socket={socketRef.current} />
          <BottomPanel />
        </div>
        {helpContext && <HelpPanel />}
      </div>
      <StatusBar />
      {showSettings && <SettingsView socket={socketRef.current} />}
    </div>
  );
}
