import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
// The embedded backend's Socket.IO server encodes packets with the msgpack
// parser (see src/dashboard/websocket.ts). The client MUST use the same parser
// or the handshake never completes and the app is stuck "offline" forever.
import parser from 'socket.io-msgpack-parser';
import { ActivityBar } from './layout/ActivityBar.js';
import { TitleBar } from './layout/TitleBar.js';
import { SessionSidebar } from './layout/SessionSidebar.js';
import { TabBar } from './layout/TabBar.js';
import { MainContent } from './layout/MainContent.js';
import { BottomPanel } from './layout/BottomPanel.js';
import { StatusBar } from './layout/StatusBar.js';
import { HelpPanel } from './help/HelpPanel.js';
import { OnboardingView } from './views/OnboardingView.js';
import {
  useAppDispatch, useAppSelector,
  setConnected, setReconnecting, setBackendError, setMeta, updateCost, upsertAgent, updateLastMessage,
  setSessions, removeSession, setOnboardingDone,
  type RuntimeSession,
} from './store/index.js';
import { SettingsView } from './views/SettingsView.js';
import { useThemeSync } from './theme/useTheme.js';

declare global {
  interface Window {
    cascade?: {
      platform: string;
      getMeta(): Promise<{ port: number; token: string; platform: string; version: string; error: string | null }>;
      restartBackend(): Promise<{ port: number; token: string; error: string | null }>;
      onBackendStatus(cb: (s: { port: number; token: string; error: string | null }) => void): void;
      getConfig(): Promise<{ provider: string; apiKey: string; workspace: string; onboardingDone: boolean }>;
      setConfig(cfg: { provider: string; apiKey: string; workspace: string; baseUrl?: string }): Promise<void>;
      getSettings(): Promise<{ models: Record<string, string>; budget: { maxCostPerRun?: number; autoBias?: string }; providersWithKey: string[]; endpoints: Record<string, string> }>;
      updateSettings(data: { keys?: Record<string, string | undefined>; models?: Record<string, string | undefined>; budget?: { maxCostPerRun?: number; autoBias?: string }; endpoints?: Record<string, string | undefined> }): Promise<{ ok: boolean; error?: string; models?: Record<string, string>; budget?: { maxCostPerRun?: number; autoBias?: string }; providersWithKey?: string[] }>;
      selectDirectory(): Promise<string | null>;
      listModels(): Promise<{ ok: boolean; error?: string; models: Array<{ id: string; provider: string; isLocal: boolean }>; ocProbe?: { status?: number; count?: number; error?: string } }>;
      theme: {
        get(): Promise<{ preference: 'system' | 'light' | 'dark' | 'midnight'; shouldUseDark: boolean }>;
        set(preference: 'system' | 'light' | 'dark' | 'midnight'): Promise<{ preference: 'system' | 'light' | 'dark' | 'midnight'; shouldUseDark: boolean }>;
        onChanged(cb: (s: { preference: 'system' | 'light' | 'dark' | 'midnight'; shouldUseDark: boolean }) => void): void;
      };
      updates: {
        getVersion(): Promise<string>;
        check(): Promise<{ ok: boolean; error?: string; version?: string; current?: string }>;
        install(): Promise<void>;
        onStatus(cb: (s: { status: string; version?: string; percent?: number; message?: string }) => void): void;
      };
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
        writeFile(path: string, content: string): Promise<{ ok: boolean }>;
        mkdir(path: string): Promise<{ ok: boolean }>;
        createFile(path: string): Promise<{ ok: boolean }>;
        rename(oldPath: string, newPath: string): Promise<{ ok: boolean }>;
        delete(path: string): Promise<{ ok: boolean }>;
        search(root: string, query: string): Promise<Array<{ file: string; line: number; text: string }>>;
      };
    };
  }
}

export function App() {
  const dispatch = useAppDispatch();
  const { backendPort, authToken, helpContext, showSettings, onboardingDone, backendError, view } = useAppSelector((s) => s.app);
  const socketRef = useRef<Socket | null>(null);

  // Resolve + apply the System/Light/Dark appearance preference.
  useThemeSync();

  // Check onboarding status from Electron config on startup
  useEffect(() => {
    if (window.cascade?.getConfig) {
      window.cascade.getConfig().then((cfg) => {
        dispatch(setOnboardingDone(cfg.onboardingDone));
      }).catch(() => {
        dispatch(setOnboardingDone(true)); // fail-open in dev
      });
    }
  }, [dispatch]);

  // Fetch Electron meta (port + token) from preload bridge, and subscribe to
  // live backend-health pushes so an on-demand restart reconnects automatically.
  useEffect(() => {
    if (window.cascade) {
      window.cascade.getMeta().then((meta) => {
        dispatch(setMeta({ port: meta.port, token: meta.token }));
        dispatch(setBackendError(meta.error));
      });
      window.cascade.onBackendStatus?.((s) => {
        dispatch(setMeta({ port: s.port, token: s.token }));
        dispatch(setBackendError(s.error));
      });
    } else {
      dispatch(setMeta({ port: 3000, token: '' }));
    }
  }, [dispatch]);

  // Connect to Socket.IO backend once port is known
  useEffect(() => {
    if (!backendPort) return;
    const socket = io(`http://localhost:${backendPort}`, {
      auth: { token: authToken },
      transports: ['websocket'],
      parser,
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

    socket.on('stream:token', (data: { text: string; tierId?: string }) => {
      // Only T1's stream is the user-facing reply. T2/T3 stream too (ids are
      // `T2_…`/`T3_…`, see BaseTier), and appending them here interleaved
      // parallel tiers' text — and their `<think>` blocks — into one garbled
      // message. Their progress stays visible via tier:status → AgentGraph
      // action labels; their models still think internally.
      if (data.tierId && !data.tierId.startsWith('T1')) return;
      dispatch(updateLastMessage({ content: data.text, streaming: true }));
    });

    // Session list updates
    socket.on('runtime:update', (data: { sessions?: RuntimeSession[] }) => {
      if (data.sessions) dispatch(setSessions(data.sessions));
    });

    socket.on('session:deleted', (data: { sessionId: string }) => {
      dispatch(removeSession(data.sessionId));
    });

    // Surface run failures. The cockpit/chat only render agents from socket
    // events, so a run that errors before any tier spawns used to vanish with
    // no feedback. Show the error instead, and clear it when a run completes.
    socket.on('session:error', (data: { error?: string }) => {
      dispatch(setBackendError(data?.error ? `Run failed: ${data.error}` : 'Run failed — check your model/key and try again.'));
    });
    socket.on('session:complete', () => { dispatch(setBackendError(null)); });

    return () => { socket.disconnect(); };
  }, [backendPort, authToken, dispatch]);

  // Show onboarding full-screen on first run
  if (!onboardingDone) {
    return <OnboardingView />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <TitleBar />
      {backendError && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
          background: 'var(--danger-soft, #2a1015)', color: 'var(--danger, #ff6b81)',
          borderBottom: '1px solid var(--danger, #ff6b81)', fontSize: 12.5, flexShrink: 0,
        }}>
          <span style={{ flex: 1 }}>{backendError}</span>
          <button onClick={() => dispatch(setBackendError(null))} title="Dismiss"
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}
      {/* position: relative anchors the absolutely-positioned HelpPanel to the
          content area (below the title bar) so its close button is never hidden
          under the draggable title strip / native window controls. */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        <ActivityBar />
        {/* The Code view has its own session picker in the docked chat panel —
            a full-width always-on session list there just eats editor space. */}
        {view !== 'code' && <SessionSidebar socket={socketRef.current} />}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <TabBar />
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
