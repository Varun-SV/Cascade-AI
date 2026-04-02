import React, { useEffect, useState } from 'react';
import { Activity, Settings, MessageSquare, List, BarChart2, LogIn } from 'lucide-react';
import { useWebSocket } from './hooks/useWebSocket.ts';
import { AgentGraph } from './components/AgentGraph.tsx';

// ── Types ─────────────────────────────────────

interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadata: { totalTokens: number; totalCostUsd: number; taskCount: number };
}

interface TierEvent {
  tierId: string;
  role: string;
  status: string;
  action?: string;
}

interface AgentNode {
  id: string;
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
  action?: string;
}

// ── Main App ──────────────────────────────────

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('cascade_token') ?? '');
  const [page, setPage] = useState<'dashboard' | 'sessions' | 'settings' | 'login'>('dashboard');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agentNodes, setAgentNodes] = useState<AgentNode[]>([]);
  const [streamLog, setStreamLog] = useState<string>('');
  const [stats, setStats] = useState<{ totalSessions: number; totalMessages: number; totalCostUsd: number } | null>(null);

  const { connected, events } = useWebSocket({ url: '/', token });

  // Process WebSocket events
  useEffect(() => {
    for (const ev of events) {
      if (ev.type === 'tier:status') {
        const d = ev.data as TierEvent;
        setAgentNodes((prev) => {
          const existing = prev.find((n) => n.id === d.tierId);
          const role = d.role as AgentNode['role'];
          if (existing) {
            return prev.map((n) => n.id === d.tierId
              ? { ...n, status: d.status as AgentNode['status'], action: d.action }
              : n);
          }
          return [...prev, {
            id: d.tierId,
            role,
            label: d.tierId,
            status: d.status as AgentNode['status'],
            action: d.action,
          }];
        });
      }
      if (ev.type === 'stream:token') {
        const d = ev.data as { text: string };
        setStreamLog((prev) => (prev + d.text).slice(-5000));
      }
    }
  }, [events]);

  // Load data
  useEffect(() => {
    if (!token) return;
    fetchSessions();
    fetchStats();
  }, [token]);

  async function fetchSessions() {
    try {
      const r = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setSessions(await r.json() as Session[]);
    } catch { /* network error */ }
  }

  async function fetchStats() {
    try {
      const r = await fetch('/api/stats', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setStats(await r.json() as typeof stats);
    } catch { /* network error */ }
  }

  if (!token) return <LoginPage onLogin={setToken} />;

  return (
    <div className="flex h-screen bg-cascade-bg overflow-hidden">
      {/* Sidebar */}
      <Sidebar page={page} onNavigate={setPage} connected={connected} onLogout={() => { setToken(''); localStorage.removeItem('cascade_token'); }} />

      {/* Main */}
      <main className="flex-1 overflow-auto p-6">
        {page === 'dashboard' && (
          <Dashboard stats={stats} agentNodes={agentNodes} streamLog={streamLog} />
        )}
        {page === 'sessions' && (
          <SessionsPage sessions={sessions} token={token} />
        )}
        {page === 'settings' && (
          <SettingsPage token={token} />
        )}
      </main>
    </div>
  );
}

// ── Login ─────────────────────────────────────

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

// ── Sidebar ───────────────────────────────────

function Sidebar({ page, onNavigate, connected, onLogout }: {
  page: string;
  onNavigate: (p: 'dashboard' | 'sessions' | 'settings') => void;
  connected: boolean;
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

      <div className="p-2 border-t border-cascade-border">
        <button onClick={onLogout}
          className="w-full px-3 py-2 text-sm text-gray-500 hover:text-red-400 rounded-lg text-left transition-colors">
          Sign out
        </button>
      </div>
    </aside>
  );
}

// ── Dashboard Page ────────────────────────────

function Dashboard({ stats, agentNodes, streamLog }: {
  stats: { totalSessions: number; totalMessages: number; totalCostUsd: number } | null;
  agentNodes: AgentNode[];
  streamLog: string;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Dashboard</h1>

      {/* Stats */}
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

      {/* Agent Graph */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Live Agent Graph</h2>
        {agentNodes.length > 0 ? (
          <AgentGraph nodes={agentNodes} edges={[]} />
        ) : (
          <div className="h-48 rounded-xl border border-cascade-border bg-cascade-surface flex items-center justify-center">
            <p className="text-gray-600 text-sm">No active agents — start a task in the CLI</p>
          </div>
        )}
      </div>

      {/* Stream log */}
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

// ── Sessions Page ─────────────────────────────

function SessionsPage({ sessions, token }: { sessions: Session[]; token: string }) {
  const [selected, setSelected] = useState<Session | null>(null);

  async function deleteSession(id: string) {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setSelected(null);
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

// ── Settings Page ─────────────────────────────

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
