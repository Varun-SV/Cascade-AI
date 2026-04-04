import React, { useEffect, useMemo, useState } from 'react';
import { useAppSelector, useAppDispatch } from './store';
import { 
  setActiveSession, 
  setScope, 
  updateRTKSnapshot, 
  selectSessions, 
  selectActiveSession, 
  selectActiveNodes, 
  selectActiveLogs 
} from './store/slices/runtimeSlice';
import { useWebSocket, type RuntimeSnapshot } from './hooks/useWebSocket.ts';
import { LoginView } from './components/auth/LoginView.tsx';
import { DashboardLayout } from './components/layout/DashboardLayout.tsx';
import { Sidebar } from './components/layout/Sidebar.tsx';
import { AgentGraph } from './components/dashboard/AgentGraph.tsx';
import { Inspector } from './components/dashboard/Inspector.tsx';
import { formatNodeLabel } from './utils/runtime.ts';

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('cascade_token') ?? '');
  const [vibe, setVibe] = useState<'hacker' | 'linear'>(() => (localStorage.getItem('cascade_vibe') as any) ?? 'linear');

  useEffect(() => {
    localStorage.setItem('cascade_vibe', vibe);
  }, [vibe]);
  
  if (!token) {
    return (
      <LoginView 
        onLogin={(t) => { setToken(t); localStorage.setItem('cascade_token', t); }} 
        vibe={vibe}
        setVibe={setVibe}
      />
    );
  }

  return (
    <Dashboard 
      token={token} 
      onLogout={() => { setToken(''); localStorage.removeItem('cascade_token'); }} 
    />
  );
}

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const dispatch = useAppDispatch();
  const [activeTab, setActiveTab] = useState('topology');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [streamLog, setStreamLog] = useState<string>('');

  const sessions = useAppSelector(selectSessions);
  const activeSession = useAppSelector(selectActiveSession);
  const activeNodes = useAppSelector(selectActiveNodes);
  const activeLogs = useAppSelector(selectActiveLogs);
  const runtimeScope = useAppSelector(state => state.runtime.scope);

  const refreshRuntime = useMemo(() => async (scope: 'workspace' | 'global' = 'workspace') => {
    try {
      const res = await fetch(`/api/runtime?scope=${scope}`, { 
        headers: { Authorization: `Bearer ${token}` }, 
        cache: 'no-store' 
      });
      if (res.ok) {
        const snapshot = await res.json() as RuntimeSnapshot;
        dispatch(updateRTKSnapshot(snapshot));
      }
    } catch (err) {
      console.error('Failed to refresh runtime:', err);
    }
  }, [token, dispatch]);

  const { events } = useWebSocket({
    url: '/',
    token,
    activeSessionId: activeSession?.sessionId,
    onRuntimeRefresh: (scope) => {
      refreshRuntime(scope || runtimeScope);
    },
  });

  useEffect(() => {
    for (const ev of events) {
      if (ev.type === 'stream:token') {
        const d = ev.data as { text: string };
        setStreamLog((prev) => (prev + d.text).slice(-10000));
      }
    }
  }, [events]);

  useEffect(() => {
    refreshRuntime(runtimeScope);
  }, [refreshRuntime, runtimeScope]);

  const sessionEdges = useMemo(() => 
    activeNodes.filter(n => n.parentId).map(n => ({ from: n.parentId!, to: n.tierId }))
  , [activeNodes]);

  const selectedNode = useMemo(() => 
    activeNodes.find(n => n.tierId === selectedNodeId)
  , [activeNodes, selectedNodeId]);

  return (
    <DashboardLayout 
      sidebar={
        <Sidebar 
          activeTab={activeTab} 
          setActiveTab={setActiveTab} 
          onLogout={onLogout} 
        />
      }
    >
      {activeTab === 'topology' && (
        <div className="w-full h-full relative">
          <AgentGraph 
            nodes={activeNodes.map(n => ({
              id: n.tierId,
              role: n.role,
              label: formatNodeLabel(n.label, n.role),
              status: n.status,
              action: n.currentAction
            }))}
            edges={sessionEdges}
            selectedNodeId={selectedNodeId || undefined}
            onSelectNode={setSelectedNodeId}
          />
          
          {selectedNodeId && (
            <Inspector 
              selectedNode={selectedNode ? {
                id: selectedNode.tierId,
                data: {
                  label: formatNodeLabel(selectedNode.label, selectedNode.role),
                  status: selectedNode.status.toLowerCase(),
                  description: selectedNode.currentAction,
                  logs: [streamLog.split('\n').pop() || ''] 
                }
              } : null}
              onClose={() => setSelectedNodeId(null)}
            />
          )}
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="p-8 h-full flex flex-col">
          <div className="flex-1 bg-black/40 backdrop-blur-sm border border-white/5 rounded-3xl p-6 font-mono text-sm overflow-y-auto custom-scrollbar">
            {streamLog || 'Awaiting telemetry stream...'}
          </div>
        </div>
      )}

      {activeTab === 'logs' && (
        <div className="p-8 h-full overflow-y-auto">
          <div className="space-y-4">
            {activeLogs.map((log) => (
              <div key={log.id} className="p-4 bg-white/5 border border-white/5 rounded-2xl flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="text-blue-400 font-mono text-xs">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                  <span className="text-white font-bold">{log.label}</span>
                  <span className="text-slate-500 text-xs italic">{log.status}</span>
                </div>
                <div className="text-xs text-slate-400">{log.currentAction}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
