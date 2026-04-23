import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useAppSelector, useAppDispatch } from './store';
import {
  updateRTKSnapshot,
  selectActiveNodes,
  selectActiveSession,
  selectIsConnected,
} from './store/slices/runtimeSlice';
import {
  useWebSocket,
} from './hooks/useWebSocket';
import type { PermissionDecisionPayload, PermissionRequest, RuntimeNode, RuntimeSnapshotPayload } from './types/protocol';
import { LoginView } from './components/auth/LoginView';
import { NavRail, type NavTab } from './components/layout/NavRail';
import { TopBar } from './components/layout/TopBar';
import { AgentGraph } from './components/dashboard/AgentGraph';
import { InspectorPanel } from './components/dashboard/InspectorPanel';
import { EscalationCard } from './components/dashboard/EscalationCard';
import { SessionList } from './components/dashboard/SessionList';
import { LogViewer } from './components/dashboard/LogViewer';
import { SettingsView } from './components/dashboard/SettingsView';

// ── Root ───────────────────────────────────────

export default function App() {
  // null  → checking no-auth (show spinner)
  // ''    → authenticated without token (no-auth mode)
  // str   → authenticated with real token
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('cascade_token'));
  const [checking, setChecking] = useState(token === null);

  // Probe the server for no-auth access only when we have no stored token
  useEffect(() => {
    if (token !== null) return;
    (async () => {
      try {
        const res = await fetch('/api/runtime?scope=workspace', {
          headers: { Authorization: 'Bearer ' },
        });
        if (res.ok) {
          setToken('');
          localStorage.setItem('cascade_token', '');
        }
      } catch {
        // needs auth or server not reachable yet
      } finally {
        setChecking(false);
      }
    })();
  }, [token]);

  const handleLogin = useCallback((t: string) => {
    setToken(t);
    localStorage.setItem('cascade_token', t);
  }, []);

  const handleLogout = useCallback(() => {
    setToken(null);
    localStorage.removeItem('cascade_token');
  }, []);

  if (checking) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-[var(--bg-base)]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
          <p className="section-label">Connecting…</p>
        </div>
      </div>
    );
  }

  if (token === null) {
    return <LoginView onLogin={handleLogin} />;
  }

  return (
    <Dashboard
      token={token}
      onLogout={handleLogout}
      onNeedAuth={() => {
        setToken(null);
        localStorage.removeItem('cascade_token');
      }}
    />
  );
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
  const [nodeStreams, setNodeStreams] = useState<Record<string, string>>({});
  const [pendingEscalation, setPendingEscalation] = useState<PermissionRequest | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);

  const activeNodes   = useAppSelector(selectActiveNodes);
  const activeSession = useAppSelector(selectActiveSession);
  const isConnected   = useAppSelector(selectIsConnected);

  // Guard: never overwrite an unresolved escalation
  const pendingRef = useRef(pendingEscalation);
  pendingRef.current = pendingEscalation;

  // ── Refresh runtime snapshot ─────────────────
  const refreshRuntime = useCallback(async (scope: 'workspace' | 'global' = 'workspace') => {
    try {
      const res = await fetch(`/api/runtime?scope=${scope}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (res.status === 401) { onNeedAuth(); return; }
      if (res.ok) {
        const snapshot = (await res.json()) as RuntimeSnapshotPayload;
        dispatch(updateRTKSnapshot(snapshot));
      }
    } catch { /* retry on next WS ping */ }
  }, [token, dispatch, onNeedAuth]);

  // ── WebSocket ────────────────────────────────
  const { socket } = useWebSocket({
    url: '/',
    token,
    activeSessionId: activeSession?.sessionId,
    onRuntimeRefresh: (scope) => refreshRuntime(scope ?? 'workspace'),
    onStreamToken: (d) => {
      setNodeStreams((prev) => {
        const existing = prev[d.tierId] || '';
        return {
          ...prev,
          [d.tierId]: (existing + d.text).slice(-8000),
        };
      });
    },
    onCostUpdate: (d) => {
      if (typeof d.totalCostUsd === 'number') setCostUsd(d.totalCostUsd);
      if (typeof d.totalTokens  === 'number') setTotalTokens(d.totalTokens);
    },
    onEscalation: (req) => {
      if (!pendingRef.current) setPendingEscalation(req);
    },
  });

  useEffect(() => { refreshRuntime(); }, [refreshRuntime]);

  // ── Derived graph data ────────────────────────
  const graphNodes = useMemo(() => activeNodes.map((n: RuntimeNode) => ({
    id: n.tierId,
    role: n.role,
    label: n.label,
    status: n.status,
    action: n.currentAction,
    progressPct: n.progressPct,
  })), [activeNodes]);

  const graphEdges = useMemo(() =>
    activeNodes
      .filter((n: RuntimeNode) => n.parentId)
      .map((n: RuntimeNode) => ({ from: n.parentId!, to: n.tierId })),
  [activeNodes]);

  const selectedNode = useMemo(() =>
    activeNodes.find((n: RuntimeNode) => n.tierId === selectedNodeId) ?? null,
  [activeNodes, selectedNodeId]);


  // ── Escalation handler ────────────────────────
  const handleEscalationDecide = useCallback((approved: boolean, always: boolean) => {
      if (!pendingEscalation || !socket) return;
    socket.emit('permission:decision', {
      requestId: pendingEscalation.id,
      approved,
      always,
      decidedBy: 'USER',
    } satisfies PermissionDecisionPayload);
    setPendingEscalation(null);
  }, [pendingEscalation, socket]);

  const showInspector = selectedNodeId !== null;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg-base)]">
      <NavRail activeTab={activeTab} onTabChange={setActiveTab} onLogout={onLogout} />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar isConnected={isConnected} totalCostUsd={costUsd} totalTokens={totalTokens} />

        <div className="flex flex-1 min-h-0 overflow-hidden">
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
            {activeTab === 'logs'     && <LogViewer />}
            {activeTab === 'settings' && <SettingsView token={token} />}
          </main>

          {activeTab === 'topology' && showInspector && (
            <InspectorPanel
              node={selectedNode}
              streamLog={selectedNodeId ? nodeStreams[selectedNodeId] || '' : ''}
              onClose={() => setSelectedNodeId(null)}
            />
          )}
        </div>
      </div>

      {pendingEscalation && (
        <EscalationCard request={pendingEscalation} onDecide={handleEscalationDecide} />
      )}
    </div>
  );
}
