import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from './store';
import {
  setActiveSession,
  updateRTKSnapshot,
  selectActiveNodes,
  selectActiveSession,
} from './store/slices/runtimeSlice';
import { useWebSocket, type RuntimeSnapshot } from './hooks/useWebSocket';
import { LoginView } from './components/auth/LoginView';
import { NavRail } from './components/layout/NavRail';
import { TopBar } from './components/layout/TopBar';
import { AgentGraph } from './components/dashboard/AgentGraph';
import { InspectorPanel } from './components/dashboard/InspectorPanel';
import { EscalationCard } from './components/dashboard/EscalationCard';
import { SessionList } from './components/dashboard/SessionList';
import { LogViewer } from './components/dashboard/LogViewer';

// Inline type matching src/types.ts PermissionRequest
interface PermissionRequest {
  id: string;
  requestedBy: string;
  parentT2Id: string;
  toolName: string;
  input: Record<string, unknown>;
  isDangerous: boolean;
  subtaskContext: string;
  sectionContext: string;
  taskContext?: string;
}

type NavTab = 'topology' | 'sessions' | 'logs' | 'settings';

// ── Root ───────────────────────────────────────

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('cascade_token') ?? '');

  const handleLogin = useCallback((t: string) => {
    setToken(t);
    localStorage.setItem('cascade_token', t);
  }, []);

  const handleLogout = useCallback(() => {
    setToken('');
    localStorage.removeItem('cascade_token');
  }, []);

  if (!token && token !== '') {
    // Still loading (checking no-auth)
    return (
      <div className="flex items-center justify-center w-full h-full">
        <div className="w-8 h-8 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
      </div>
    );
  }

  return <Dashboard token={token} onLogout={handleLogout} onNeedAuth={() => setToken('')} />;
}

// ── Dashboard ──────────────────────────────────

function Dashboard({
  token,
  onLogout,
  onNeedAuth,
}: {
  token: string;
  onLogout: () => void;
  onNeedAuth: () => void;
}) {
  const dispatch = useAppDispatch();
  const [activeTab, setActiveTab] = useState<NavTab>('topology');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [streamLog, setStreamLog] = useState('');
  const [pendingEscalation, setPendingEscalation] = useState<PermissionRequest | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);

  const activeNodes = useAppSelector(selectActiveNodes);
  const activeSession = useAppSelector(selectActiveSession);

  // ── Refresh runtime snapshot ─────────────────
  const refreshRuntime = useCallback(async (scope: 'workspace' | 'global' = 'workspace') => {
    try {
      const res = await fetch(`/api/runtime?scope=${scope}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (res.status === 401) { onNeedAuth(); return; }
      if (res.ok) {
        const snapshot = await res.json() as RuntimeSnapshot;
        dispatch(updateRTKSnapshot(snapshot));
      }
    } catch { /* network error, retry on next WS ping */ }
  }, [token, dispatch, onNeedAuth]);

  // ── WebSocket ────────────────────────────────
  const { events, socket } = useWebSocket({
    url: '/',
    token,
    activeSessionId: activeSession?.sessionId,
    onRuntimeRefresh: (scope) => refreshRuntime(scope || 'workspace'),
    onStreamToken: (d) => setStreamLog((prev) => (prev + d.text).slice(-8000)),
  });

  // Listen for cost updates and permission escalations via WS events
  useEffect(() => {
    const costEvent = [...events].reverse().find((e: { type: string; data: unknown; ts: number }) => e.type === 'cost:update');
    if (costEvent) {
      const d = costEvent.data as { totalCostUsd?: number; totalTokens?: number };
      if (d.totalCostUsd) setCostUsd(d.totalCostUsd);
      if (d.totalTokens) setTotalTokens(d.totalTokens);
    }

    const escEvent = [...events].reverse().find((e: { type: string; data: unknown; ts: number }) => e.type === 'permission:user-required');
    if (escEvent && !pendingEscalation) {
      setPendingEscalation(escEvent.data as PermissionRequest);
    }
  }, [events]);

  useEffect(() => { refreshRuntime(); }, [refreshRuntime]);

  // ── Derived data ─────────────────────────────
  const graphNodes = useMemo(() => activeNodes.map((n) => ({
    id: n.tierId,
    role: n.role,
    label: n.label,
    status: n.status,
    action: n.currentAction,
    progressPct: n.progressPct,
  })), [activeNodes]);

  const graphEdges = useMemo(() =>
    activeNodes.filter((n) => n.parentId).map((n) => ({ from: n.parentId!, to: n.tierId })),
  [activeNodes]);

  const selectedNode = useMemo(() =>
    activeNodes.find((n) => n.tierId === selectedNodeId) ?? null,
  [activeNodes, selectedNodeId]);

  const isConnected = useAppSelector((s) => s.runtime.connected);

  // ── Escalation decision handler ──────────────
  const handleEscalationDecide = useCallback((approved: boolean, always: boolean) => {
    if (!pendingEscalation || !socket) return;
    socket.emit('permission:decision', {
      requestId: pendingEscalation.id,
      approved,
      always,
      decidedBy: 'USER',
    });
    setPendingEscalation(null);
  }, [pendingEscalation, socket]);

  const showInspector = selectedNodeId !== null;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg-base)]">
      {/* Navigation Rail */}
      <NavRail activeTab={activeTab} onTabChange={setActiveTab} onLogout={onLogout} />

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Top Bar */}
        <TopBar isConnected={isConnected} totalCostUsd={costUsd} totalTokens={totalTokens} />

        {/* Content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Primary content panel */}
          <main className="flex-1 min-w-0 overflow-hidden relative dot-grid">
            {activeTab === 'topology' && (
              <AgentGraph
                nodes={graphNodes}
                edges={graphEdges}
                selectedNodeId={selectedNodeId ?? undefined}
                onSelectNode={setSelectedNodeId}
              />
            )}
            {activeTab === 'sessions' && <SessionList />}
            {activeTab === 'logs' && <LogViewer />}
            {activeTab === 'settings' && (
              <div className="flex items-center justify-center h-full animate-fade-in">
                <p className="text-[var(--text-muted)] text-sm">Settings panel — coming soon</p>
              </div>
            )}
          </main>

          {/* Inspector panel (topology tab only) */}
          {activeTab === 'topology' && (showInspector || !graphNodes.length) && (
            <InspectorPanel
              node={selectedNode}
              streamLog={streamLog}
              onClose={() => setSelectedNodeId(null)}
            />
          )}
        </div>
      </div>

      {/* Permission Escalation Card (modal overlay) */}
      {pendingEscalation && (
        <EscalationCard
          request={pendingEscalation}
          onDecide={handleEscalationDecide}
        />
      )}
    </div>
  );
}
