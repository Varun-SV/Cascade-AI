import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Settings, MessageSquare, LogIn } from 'lucide-react';
import { useWebSocket } from './hooks/useWebSocket.ts';
import { AgentGraph } from './components/AgentGraph.tsx';

interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadata: { totalTokens: number; totalCostUsd: number; taskCount: number };
}

interface RuntimeSession {
  sessionId: string;
  title: string;
  workspacePath: string;
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  updatedAt: string;
  latestPrompt?: string;
}

interface RuntimeNode {
  tierId: string;
  sessionId: string;
  parentId?: string;
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
  currentAction?: string;
  progressPct?: number;
  updatedAt: string;
}

interface RuntimeNodeLog {
  id: string;
  sessionId: string;
  tierId: string;
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
  currentAction?: string;
  progressPct?: number;
  timestamp: string;
}

interface RuntimeSnapshot {
  sessions: RuntimeSession[];
  nodes: RuntimeNode[];
  logs: RuntimeNodeLog[];
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('cascade_token') ?? '');
  const [theme, setTheme] = useState(() => localStorage.getItem('cascade_theme') ?? 'cascade');
  const [page, setPage] = useState<'dashboard' | 'sessions' | 'settings'>('dashboard');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [runtime, setRuntime] = useState<RuntimeSnapshot>({ sessions: [], nodes: [], logs: [] });
  const [streamLog, setStreamLog] = useState<string>('');
  const [stats, setStats] = useState<{ totalSessions: number; totalMessages: number; totalCostUsd: number } | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');

  const { connected, events } = useWebSocket({ url: '/', token });

  useEffect(() => {
    for (const ev of events) {
      if (ev.type === 'stream:token') {
        const d = ev.data as { text: string };
        setStreamLog((prev) => (prev + d.text).slice(-5000));
      }
    }
  }, [events]);

  useEffect(() => {
    if (!token) return;
    fetchSessions();
    fetchStats();
    fetchRuntime();

    const timer = setInterval(() => {
      fetchRuntime();
      fetchSessions();
      fetchStats();
    }, 2000);

    return () => clearInterval(timer);
  }, [token]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('cascade_theme', theme);
  }, [theme]);

  async function fetchSessions() {
    try {
      const r = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setSessions(await r.json() as Session[]);
    } catch { /* noop */ }
  }

  async function fetchStats() {
    try {
      const r = await fetch('/api/stats', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setStats(await r.json() as typeof stats);
    } catch { /* noop */ }
  }

  async function fetchRuntime() {
    try {
      const r = await fetch('/api/runtime', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const snapshot = await r.json() as RuntimeSnapshot;
      setRuntime(snapshot);
      if (!selectedNodeId && snapshot.nodes[0]?.tierId) {
        setSelectedNodeId(snapshot.nodes[0].tierId);
      }
    } catch { /* noop */ }
  }

  if (!token) return <LoginPage onLogin={setToken} />;

  return (
    <div className="flex h-screen bg-cascade-bg overflow-hidden">
      <Sidebar page={page} onNavigate={setPage} connected={connected} theme={theme} onThemeChange={setTheme} onLogout={() => { setToken(''); localStorage.removeItem('cascade_token'); }} />

      <main className="flex-1 overflow-auto p-6">
        {page === 'dashboard' && (
          <Dashboard
            stats={stats}
            runtime={runtime}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            streamLog={streamLog}
          />
        )}
        {page === 'sessions' && (
          <SessionsPage sessions={sessions} token={token} onRefresh={fetchSessions} />
        )}
        {page === 'settings' && (
          <SettingsPage token={token} />
        )}
      </main>
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password }),
      });
      if (r.ok) {
        const { token } = await r.json() as { token: string };
        localStorage.setItem('cascade_token', token);
        onLogin(token);
      } else {
        setError('Invalid password');
      }
    } catch {
      setError('Connection failed');
    }
  }

  return (
    <div className="min-h-screen bg-cascade-bg flex items-center justify-center">
      <div className="w-80 p-8 rounded-xl border border-cascade-border bg-cascade-surface">
        <div className="text-center mb-8">
          <div className="text-4xl text-cascade-500 mb-2">◈</div>
          <h1 className="text-xl font-bold text-white">Cascade AI</h1>
          <p className="text-sm text-gray-500 mt-1">Dashboard Login</p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2 bg-cascade-bg border border-cascade-border rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-cascade-500"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button type="submit"
            className="w-full py-2 bg-cascade-500 hover:bg-cascade-600 text-white rounded-lg transition-colors font-medium">
            <LogIn className="inline w-4 h-4 mr-2" />Sign In
          </button>
        </form>
      </div>
    </div>
  );
}

function Sidebar({ page, onNavigate, connected, theme, onThemeChange, onLogout }: {
  page: string;
  onNavigate: (p: 'dashboard' | 'sessions' | 'settings') => void;
  connected: boolean;
  theme: string;
  onThemeChange: (theme: string) => void;
  onLogout: () => void;
}) {
  const items = [
    { id: 'dashboard', icon: Activity, label: 'Dashboard' },
    { id: 'sessions', icon: MessageSquare, label: 'Sessions' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <aside className="w-56 bg-cascade-surface border-r border-cascade-border flex flex-col">
      <div className="p-4 border-b border-cascade-border">
        <div className="flex items-center gap-2">
          <span className="text-cascade-500 text-xl font-bold">◈</span>
          <span className="text-white font-bold">Cascade</span>
          <span className="text-xs text-gray-500 ml-auto">AI</span>
        </div>
        <div className="flex items-center gap-1 mt-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-600'}`} />
          <span className="text-xs text-gray-500">{connected ? 'Live' : 'Offline'}</span>
        </div>
      </div>

      <nav className="flex-1 p-2">
        {items.map(({ id, icon: Icon, label }) => (
          <button key={id}
            onClick={() => onNavigate(id as 'dashboard' | 'sessions' | 'settings')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors mb-1
              ${page === id ? 'bg-cascade-500/20 text-cascade-400' : 'text-gray-500 hover:text-white hover:bg-white/5'}`}>
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </nav>

      <div className="px-3 pb-3">
        <label className="text-xs text-gray-500 block mb-2">Theme</label>
        <select
          value={theme}
          onChange={(e) => onThemeChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-cascade-bg border border-cascade-border text-sm text-white outline-none"
        >
          {['cascade', 'dark', 'light', 'dracula', 'nord', 'solarized'].map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>

      <div className="p-2 border-t border-cascade-border">
        <button onClick={onLogout}
          className="w-full px-3 py-2 text-sm text-gray-500 hover:text-red-400 rounded-lg text-left transition-colors">
          Sign out
        </button>
      </div>
    </aside>
  );
}

function Dashboard({ stats, runtime, selectedNodeId, onSelectNode, streamLog }: {
  stats: { totalSessions: number; totalMessages: number; totalCostUsd: number } | null;
  runtime: RuntimeSnapshot;
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
  streamLog: string;
}) {
  const nodes = runtime.nodes.map((node) => ({
    id: node.tierId,
    role: node.role,
    label: node.label,
    status: node.status,
    action: node.currentAction,
  }));

  const edges = runtime.nodes
    .filter((node) => node.parentId)
    .map((node) => ({ from: node.parentId!, to: node.tierId }));

  const selectedNode = runtime.nodes.find((node) => node.tierId === selectedNodeId) ?? runtime.nodes[0] ?? null;
  const selectedLogs = useMemo(
    () => runtime.logs.filter((log) => log.tierId === selectedNode?.tierId).slice(0, 30),
    [runtime.logs, selectedNode],
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Dashboard</h1>

      {stats && (
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Sessions', value: stats.totalSessions },
            { label: 'Tasks', value: stats.totalMessages },
            { label: 'Total Cost', value: `$${stats.totalCostUsd.toFixed(4)}` },
          ].map(({ label, value }) => (
            <div key={label} className="p-4 rounded-xl border border-cascade-border bg-cascade-surface">
              <p className="text-sm text-gray-500">{label}</p>
              <p className="text-2xl font-bold text-cascade-400 mt-1">{value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Live Agent Graph</h2>
          {nodes.length > 0 ? (
            <AgentGraph nodes={nodes} edges={edges} selectedNodeId={selectedNode?.tierId} onSelectNode={onSelectNode} />
          ) : (
            <div className="h-48 rounded-xl border border-cascade-border bg-cascade-surface flex items-center justify-center">
              <p className="text-gray-600 text-sm">No active agents — start a task in the CLI</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-cascade-border bg-cascade-surface p-4 max-h-[480px] overflow-hidden flex flex-col">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Node Activity</h2>
          {selectedNode ? (
            <>
              <div className="mb-3">
                <div className="text-xs text-cascade-400 font-semibold">{selectedNode.role}</div>
                <div className="text-white font-semibold mt-1">{selectedNode.label}</div>
                <div className="text-xs text-gray-500 mt-1">{selectedNode.status} · session {selectedNode.sessionId}</div>
                {selectedNode.currentAction && (
                  <div className="text-sm text-gray-300 mt-2">{selectedNode.currentAction}</div>
                )}
              </div>
              <div className="overflow-auto space-y-2 pr-1">
                {selectedLogs.length > 0 ? selectedLogs.map((log) => (
                  <div key={log.id} className="rounded-lg border border-cascade-border bg-cascade-bg/60 p-2">
                    <div className="text-xs text-gray-500">{new Date(log.timestamp).toLocaleString()}</div>
                    <div className="text-sm text-white mt-1">{log.status}</div>
                    {log.currentAction && <div className="text-xs text-gray-400 mt-1">{log.currentAction}</div>}
                  </div>
                )) : (
                  <p className="text-sm text-gray-500">No activity logged for this node yet.</p>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-500">Select a node to inspect activity.</p>
          )}
        </div>
      </div>

      {runtime.sessions.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Workspace Runs</h2>
          <div className="grid gap-3">
            {runtime.sessions.slice(0, 8).map((session) => (
              <div key={session.sessionId} className="rounded-xl border border-cascade-border bg-cascade-surface p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-white font-medium">{session.title}</div>
                    <div className="text-xs text-gray-500 mt-1">{session.sessionId}</div>
                    {session.latestPrompt && <div className="text-sm text-gray-300 mt-2 line-clamp-2">{session.latestPrompt}</div>}
                  </div>
                  <div className="text-right text-xs text-gray-500">
                    <div>{session.status}</div>
                    <div className="mt-1">{new Date(session.updatedAt).toLocaleString()}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {streamLog && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Live Stream</h2>
          <div className="p-4 rounded-xl border border-cascade-border bg-cascade-surface max-h-48 overflow-auto font-mono text-sm text-green-400 whitespace-pre-wrap">
            {streamLog}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionsPage({ sessions, token, onRefresh }: { sessions: Session[]; token: string; onRefresh: () => void }) {
  const [selected, setSelected] = useState<Session | null>(null);

  async function deleteSession(id: string) {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setSelected(null);
    onRefresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white">Sessions</h1>
      {sessions.length === 0 ? (
        <p className="text-gray-500">No sessions yet. Run <code className="text-cascade-400">cascade</code> to start one.</p>
      ) : (
        <div className="grid gap-3">
          {sessions.map((s) => (
            <div key={s.id}
              onClick={() => setSelected(selected?.id === s.id ? null : s)}
              className={`p-4 rounded-xl border cursor-pointer transition-colors
                ${selected?.id === s.id ? 'border-cascade-500 bg-cascade-500/10' : 'border-cascade-border bg-cascade-surface hover:border-gray-600'}`}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-white">{s.title}</p>
                  <p className="text-xs text-gray-500 mt-1">{new Date(s.updatedAt).toLocaleString()}</p>
                </div>
                <div className="text-right text-xs text-gray-500">
                  <p>{s.metadata.totalTokens?.toLocaleString()} tok</p>
                  <p>${s.metadata.totalCostUsd?.toFixed(4)}</p>
                </div>
              </div>
              {selected?.id === s.id && (
                <div className="mt-3 pt-3 border-t border-cascade-border flex gap-2">
                  <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-900">
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsPage({ token }: { token: string }) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => {});
  }, [token]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white">Settings</h1>
      {config ? (
        <div className="p-4 rounded-xl border border-cascade-border bg-cascade-surface">
          <p className="text-sm text-gray-400 mb-2">Current Configuration</p>
          <pre className="text-xs text-green-400 overflow-auto max-h-96">
            {JSON.stringify(config, null, 2)}
          </pre>
        </div>
      ) : (
        <p className="text-gray-500">Loading config…</p>
      )}
      <div className="p-4 rounded-xl border border-cascade-border bg-cascade-surface">
        <p className="text-sm text-gray-400">To edit configuration, modify <code className="text-cascade-400">.cascade/config.json</code> in your project directory.</p>
      </div>
    </div>
  );
}
