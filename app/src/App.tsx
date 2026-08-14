import { useEffect, useRef, useState } from 'react';
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
  enqueueApproval, clearApprovals, appendAgentStream, addPeerEdge, expirePeerEdges, runEnded, finalizeLastMessage,
  setPendingPlan, enqueueEscalation, dequeueEscalation, clearEscalationForSession, setWhyReport, appendCommsEvent,
  type RuntimeSession, type PendingPlan, type PendingEscalation, type WhyReport,
} from './store/index.js';
import { SettingsView } from './views/SettingsView.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { PlanApprovalModal } from './components/PlanApprovalModal.js';
import { EscalationModal } from './components/EscalationModal.js';
import { WhyPanel } from './components/WhyPanel.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ChangesModal } from './components/ChangesModal.js';
import { ContinueModal } from './components/ContinueModal.js';
import { useThemeSync } from './theme/useTheme.js';

/** A message on a cloud conversation's active path (with branching data). */
export interface CloudMsg {
  id?: string;
  parentId?: string | null;
  role: string;
  content: string;
  tier?: string | null;
  model?: string | null;
  costUsd?: number | null;
  siblingIds?: string[];
}

/** A locally-executed turn to persist into the shared cloud conversation. */
export interface CloudTurn {
  userContent: string;
  assistant: { content: string; tier?: string | null; model?: string | null; costUsd?: number | null };
  editOfMessageId?: string;
  regenerateFromUserMessageId?: string;
}

/** Live state of the built-in browser, pushed on every navigation. */
export interface DesktopBrowserState {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

declare global {
  interface Window {
    cascade?: {
      platform: string;
      getMeta(): Promise<{ port: number; token: string; platform: string; version: string; error: string | null }>;
      restartBackend(): Promise<{ port: number; token: string; error: string | null }>;
      setWorkspace(dir: string): Promise<{ ok: boolean }>;
      onBackendStatus(cb: (s: { port: number; token: string; error: string | null }) => void): void;
      getConfig(): Promise<{ provider: string; hasCredential: boolean; workspace: string; onboardingDone: boolean; migrationNotice?: string }>;
      setConfig(cfg: { provider: string; apiKey: string; workspace: string; baseUrl?: string }): Promise<{ onboardingDone: boolean }>;
      getSettings(): Promise<{ models: Record<string, string>; budget: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number }; providersWithKey: string[]; endpoints: Record<string, string>; azureDeployments?: Array<{ label?: string; baseUrl?: string; deploymentName?: string; apiVersion?: string; hasKey: boolean }>; webSearch?: { searxngUrl?: string; hasBraveKey: boolean; hasTavilyKey: boolean }; advanced?: Record<string, unknown> }>;
      updateSettings(data: { keys?: Record<string, string | undefined>; models?: Record<string, string | undefined>; budget?: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number }; endpoints?: Record<string, string | undefined>; azureDeployments?: Array<{ label?: string; apiKey?: string; baseUrl?: string; deploymentName?: string; apiVersion?: string }>; webSearch?: { searxngUrl?: string; braveApiKey?: string; tavilyApiKey?: string }; advanced?: Record<string, unknown> }): Promise<{ ok: boolean; error?: string; models?: Record<string, string>; budget?: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number }; providersWithKey?: string[]; advanced?: Record<string, unknown> }>;
      selectDirectory(): Promise<string | null>;
      saveJson(defaultName: string, content: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      openJson(): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }>;
      listModels(): Promise<{ ok: boolean; error?: string; models: Array<{ id: string; provider: string; isLocal: boolean; supportsToolUse?: boolean; contextWindow?: number; isVisionCapable?: boolean }>; ocProbe?: { status?: number; count?: number; error?: string } }>;
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
      cloud?: {
        status(): Promise<{ signedIn: boolean; user: CloudUser | null; serverUrl: string; storage: 'keychain' | 'encrypted-file' }>;
        login(provider: 'google' | 'github'): Promise<{ ok: boolean; error?: string; signedIn?: boolean; user?: CloudUser | null; storage?: 'keychain' | 'encrypted-file' }>;
        cancelLogin(): Promise<{ ok: boolean }>;
        logout(): Promise<{ ok: boolean; signedIn?: boolean }>;
        sessions(): Promise<{ ok: boolean; error?: string; conversations: Array<{ id: string; title: string; updatedAt?: number }> }>;
        messages(id: string): Promise<{ ok: boolean; error?: string; messages: CloudMsg[] }>;
        createConversation(title?: string): Promise<{ ok: boolean; error?: string; conversation?: { id: string; title: string | null } }>;
        appendTurn(id: string, turn: CloudTurn): Promise<{ ok: boolean; error?: string; messages: CloudMsg[] }>;
        selectBranch(id: string, messageId: string): Promise<{ ok: boolean; error?: string; messages: CloudMsg[] }>;
        deleteMessage(id: string, messageId: string): Promise<{ ok: boolean; error?: string; messages: CloudMsg[] }>;
        renameConversation(id: string, title: string): Promise<{ ok: boolean; error?: string }>;
        deleteConversation(id: string): Promise<{ ok: boolean; error?: string }>;
        syncPush(passphrase: string): Promise<{ ok: boolean; error?: string; version?: number }>;
        syncPull(passphrase: string): Promise<{ ok: boolean; error?: string; empty?: boolean; applied?: boolean; skipped?: { removed: string[]; clearedPins: string[]; revokedCredentials?: number } }>;
      };
      mcp?: {
        list(): Promise<{ servers: Array<{ name: string; target: string; kind: 'oauth' | 'token' | 'local' | 'open' }> }>;
        connectOAuth(url: string, name?: string): Promise<{ ok: boolean; error?: string; name?: string }>;
        remove(name: string): Promise<{ ok: boolean }>;
        tools(): Promise<{
          servers: Array<{
            server: string;
            tools: Array<{ server: string; tool: string; name: string; description: string }>;
            error?: string;
          }>;
          disabled: string[];
          error?: string;
        }>;
        setToolEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; disabled?: string[] }>;
      };
      /** Built-in browser. The page is a native view the main process
       *  positions over the renderer at the bounds we report. */
      browser?: {
        open(url: string | undefined, bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean; error?: string; state?: DesktopBrowserState }>;
        hide(): Promise<{ ok: boolean }>;
        close(): Promise<{ ok: boolean }>;
        setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean }>;
        navigate(url: string): Promise<{ ok: boolean; error?: string }>;
        back(): Promise<{ ok: boolean }>;
        forward(): Promise<{ ok: boolean }>;
        reload(): Promise<{ ok: boolean }>;
        stop(): Promise<{ ok: boolean }>;
        state(): Promise<DesktopBrowserState>;
        readPage(): Promise<{ url: string; title: string; text: string } | null>;
        openExternal(url: string): Promise<{ ok: boolean }>;
        /** Returns an unsubscribe — call it on unmount. */
        onState(cb: (s: DesktopBrowserState) => void): () => void;
      };
    };
  }
}

export interface CloudUser { id: string; email: string | null; name: string | null; plan?: string }

export function App() {
  const dispatch = useAppDispatch();
  const { backendPort, authToken, helpContext, showSettings, onboardingDone, backendError, view, sessionId, runSessionId } = useAppSelector((s) => s.app);
  // Local, not redux: read once at startup and shown on exactly one screen.
  const [migrationNotice, setMigrationNotice] = useState<string | undefined>();
  // The workspace this install already had. Only onboarding consumes it, to
  // avoid presenting a reopened wizard with a blank directory field.
  const [savedWorkspace, setSavedWorkspace] = useState('');
  const socketRef = useRef<Socket | null>(null);
  // The socket-setup effect below only re-runs when backendPort/authToken
  // change (not on every session switch) — its handlers need the LIVE
  // session ids, so track them in refs rather than closing over stale state.
  const sessionIdRef = useRef(sessionId);
  const runSessionIdRef = useRef(runSessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { runSessionIdRef.current = runSessionId; }, [runSessionId]);

  // Resolve + apply the System/Light/Dark appearance preference.
  useThemeSync();

  // Check onboarding status from Electron config on startup
  useEffect(() => {
    if (window.cascade?.getConfig) {
      window.cascade.getConfig().then((cfg) => {
        dispatch(setOnboardingDone(cfg.onboardingDone));
        if (cfg.migrationNotice) setMigrationNotice(cfg.migrationNotice);
        if (cfg.workspace) setSavedWorkspace(cfg.workspace);
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

    // Populate the session list immediately on connect (and whenever the
    // backend signals a refresh) — the server only broadcasts full sessions
    // after a run ends, so without this the sidebar stayed empty until the
    // first message was sent.
    const loadSessions = () => {
      fetch(`http://localhost:${backendPort}/api/runtime?scope=workspace`, { headers: { Authorization: `Bearer ${authToken}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { sessions?: RuntimeSession[] } | null) => { if (data?.sessions) dispatch(setSessions(data.sessions)); })
        .catch(() => { /* backend not ready */ });
    };

    // Re-subscribe to the open session's room on every connect. A reconnect
    // issues a NEW socket id and drops the old one's room memberships, so
    // without this the backend has no way to reach this client again — a run
    // that escalates while we were away would prompt into nowhere and sit there
    // until it timed out. The server replays a parked prompt on join.
    const rejoinSession = () => {
      const active = runSessionIdRef.current ?? sessionIdRef.current;
      if (active) socket.emit('join:session', { sessionId: active });
    };

    socket.on('connect', () => { dispatch(setConnected(true)); dispatch(setReconnecting(false)); rejoinSession(); loadSessions(); });
    socket.on('runtime:refresh', loadSessions);
    socket.on('disconnect', () => dispatch(setConnected(false)));
    socket.on('connect_error', () => dispatch(setReconnecting(true)));
    socket.on('reconnect', () => { dispatch(setConnected(true)); dispatch(setReconnecting(false)); rejoinSession(); });

    socket.on('cost:update', (data: { totalCostUsd: number; totalTokens: number; costUnknown?: boolean }) => {
      dispatch(updateCost(data));
    });

    socket.on('tier:status', (data: {
      tierId: string; role: string; label: string; status: string;
      progressPct?: number; currentAction?: string; parentId?: string; sessionId?: string; model?: string;
      nodeId?: string; dependsOn?: string[]; waveId?: number; blockedBy?: string[];
    }) => {
      // Tag the node with the run's session — always recorded (even for a
      // session not currently on screen) so Cockpit can filter its graph to
      // "this session's own nodes" when the user switches back to it.
      dispatch(upsertAgent({
        id: data.tierId,
        tier: data.role as 'T1' | 'T2' | 'T3',
        label: data.label,
        status: data.status as never,
        progressPct: data.progressPct,
        currentAction: data.currentAction,
        parentId: data.parentId,
        sessionId: data.sessionId,
        model: data.model,
        nodeId: data.nodeId,
        dependsOn: data.dependsOn,
        waveId: data.waveId,
        blockedBy: data.blockedBy,
      }));
    });

    socket.on('stream:token', (data: { text: string; tierId?: string; primary?: boolean; sessionId?: string }) => {
      // The transcript shows only the run's PRESENTER stream — the root tier's
      // synthesis (T3 for Simple, T2 for Moderate, T1 for Complex), tagged
      // `primary`. Background workers stream too but would interleave into a
      // garble, so they're excluded here (watch them per-node in the Cockpit).
      // Only apply it to the transcript if it belongs to the session actually
      // on screen — otherwise a still-running background session's tokens
      // were overwriting whatever session the user had since switched to.
      if (data.primary && (!data.sessionId || data.sessionId === sessionIdRef.current)) {
        dispatch(updateLastMessage({ content: data.text, streaming: true }));
      }
      // Every tier's tokens also accumulate on its node for the detail panel —
      // unscoped, since that just feeds the (also session-tagged) node data.
      if (data.tierId) dispatch(appendAgentStream({ id: data.tierId, text: data.text }));
    });

    // Peer coordination (T3↔T3 / T2↔T2) — draw a transient edge in the graph
    // and log the message into the bottom-panel Comms feed.
    socket.on('peer:message', (data: { fromId?: string; toId?: string; syncType?: string; payload?: string; sessionId?: string }) => {
      if (!data?.fromId) return;
      dispatch(addPeerEdge({
        id: crypto.randomUUID(), fromId: data.fromId, toId: data.toId ?? '*',
        syncType: data.syncType, at: Date.now(),
      }));
      dispatch(appendCommsEvent({
        id: crypto.randomUUID(), at: Date.now(), fromId: data.fromId, toId: data.toId,
        syncType: data.syncType ?? 'SHARE_OUTPUT', payload: data.payload, sessionId: data.sessionId,
      }));
    });

    // User steering injections also show in the Comms feed — they're part of
    // the run's communication history.
    socket.on('session:message-injected', (data: { message?: string; sessionId?: string; nodeId?: string }) => {
      if (!data?.message) return;
      dispatch(appendCommsEvent({
        id: crypto.randomUUID(), at: Date.now(), fromId: 'you', toId: data.nodeId,
        syncType: 'STEER', payload: data.message, sessionId: data.sessionId,
      }));
    });

    // Boardroom: T1's plan paused for review (planApproval in Settings).
    // The modal answers over `plan:decision`; an unanswered plan auto-approves
    // server-side after 2 minutes, so a closed window can't hang a run.
    socket.on('plan:approval-required', (data: PendingPlan) => {
      if (!data?.plan) return;
      dispatch(setPendingPlan(data));
    });

    // A section escalated: the run is parked until this is answered. Unlike the
    // boardroom gate, silence FAILS the section rather than proceeding, so the
    // modal shows a countdown.
    socket.on('escalation:decision-required', (data: Omit<PendingEscalation, 'receivedAt'>) => {
      if (!data?.sectionId) return;
      dispatch(enqueueEscalation({
        ...data,
        issues: Array.isArray(data.issues) ? data.issues : [],
        timeoutMs: typeof data.timeoutMs === 'number' ? data.timeoutMs : 5 * 60_000,
        receivedAt: Date.now(),
      }));
    });
    // The server gave up waiting — close the modal so a late answer can't land
    // on a section that has already been failed.
    // Drop only the section that timed out — without the id an older request's
    // timeout would clear a NEWER prompt the user is mid-answer on.
    socket.on('escalation:timeout', (data: { requestId?: string; sectionId?: string }) => {
      dispatch(dequeueEscalation({ requestId: data?.requestId, sectionId: data?.sectionId }));
    });

    // The decision trail of the run that just ended — powers the Why panel.
    socket.on('run:why', (data: WhyReport) => {
      if (data?.sessionId) dispatch(setWhyReport(data));
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
    // These handlers are GLOBAL (unlike the view components, App never
    // unmounts), so they also own ending the run lifecycle: runEnded keeps the
    // persistent Stop control honest, and finalizeLastMessage un-sticks the
    // transcript's streaming flag when a run finishes while another view is open.
    socket.on('session:error', (data: { sessionId?: string; error?: string }) => {
      dispatch(setBackendError(data?.error ? `Run failed: ${data.error}` : 'Run failed — check your model/key and try again.'));
      dispatch(clearApprovals());
      dispatch(setPendingPlan(null));
      dispatch(clearEscalationForSession(data?.sessionId));
      // Only end/finalize if this event belongs to the run/session actually
      // being tracked right now — otherwise a background session finishing
      // (or erroring) clobbered the Stop control and transcript of whatever
      // DIFFERENT session the user had since switched to.
      if (!data?.sessionId || data.sessionId === runSessionIdRef.current) dispatch(runEnded());
      if (!data?.sessionId || data.sessionId === sessionIdRef.current) dispatch(finalizeLastMessage({}));
    });
    socket.on('session:complete', (data: { sessionId?: string; result?: { output?: string } } | undefined) => {
      dispatch(setBackendError(null));
      dispatch(clearApprovals());
      dispatch(setPendingPlan(null));
      // Only for the session that finished. A background session completing
      // used to wipe the prompt belonging to a DIFFERENT run that was still
      // parked — taking away the only way to answer it, so that section then
      // waited out its full timeout and failed.
      dispatch(clearEscalationForSession(data?.sessionId));
      if (!data?.sessionId || data.sessionId === runSessionIdRef.current) dispatch(runEnded());
      if (!data?.sessionId || data.sessionId === sessionIdRef.current) dispatch(finalizeLastMessage({ finalOutput: data?.result?.output }));
    });

    // A dangerous tool escalated to the user — show the approval modal. The
    // modal answers with `permission:decision`, resolving the blocked run.
    socket.on('permission:user-required', (data: {
      sessionId?: string; id: string; toolName: string; input?: Record<string, unknown>;
      requestedBy?: string; subtaskContext?: string; sectionContext?: string;
      trail?: Array<{ tier: 'T2' | 'T1'; verdict: 'approve' | 'deny' | 'unsure'; reason?: string }>;
    }) => {
      if (!data?.id || !data?.toolName) return;
      dispatch(enqueueApproval({
        id: data.id, sessionId: data.sessionId, toolName: data.toolName, input: data.input,
        requestedBy: data.requestedBy, subtaskContext: data.subtaskContext,
        sectionContext: data.sectionContext, trail: data.trail,
      }));
    });

    return () => { socket.disconnect(); };
  }, [backendPort, authToken, dispatch]);

  // Age out transient peer-communication edges (~2.5s lifetime).
  useEffect(() => {
    const t = setInterval(() => dispatch(expirePeerEdges(Date.now() - 2500)), 1000);
    return () => clearInterval(t);
  }, [dispatch]);

  // Show onboarding full-screen on first run
  if (!onboardingDone) {
    // The notice rides into onboarding rather than a toast: this is the screen
    // the user has been sent to BECAUSE their provider was removed, so the
    // explanation belongs next to the thing they are being asked to redo.
    return <OnboardingView notice={migrationNotice} initialWorkspace={savedWorkspace} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* The onboarding path above only runs when NOTHING usable is left. The
          common case is a provider removed while others remain — onboarding
          never opens, and routing the notice only there meant the majority of
          affected users saw no explanation at all for a vanished key or a
          reset tier pin. */}
      {migrationNotice && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 14px', fontSize: 13,
          background: 'var(--bg-elev)', color: 'var(--text-dim)',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ flex: 1 }}>{migrationNotice}</span>
          <button
            type="button"
            onClick={() => setMigrationNotice(undefined)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', fontSize: 12, padding: '2px 6px',
            }}
          >
            Dismiss
          </button>
        </div>
      )}
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
        {/* Why panel anchors to the content area, like HelpPanel. */}
        <WhyPanel />
      </div>
      <StatusBar socket={socketRef.current} />
      {showSettings && <SettingsView socket={socketRef.current} />}
      <ApprovalModal socket={socketRef.current} />
      <PlanApprovalModal socket={socketRef.current} />
      <EscalationModal socket={socketRef.current} />
      <ChangesModal />
      <ContinueModal />
      <CommandPalette socket={socketRef.current} />
    </div>
  );
}
