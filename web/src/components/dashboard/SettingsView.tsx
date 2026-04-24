import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDispatch } from '../../store';
import { clearFrontendGraphs } from '../../store/slices/runtimeSlice';

// ── Types ──────────────────────────────────────

interface Identity {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  isDefault: boolean;
  createdAt: string;
}

interface TierLimits {
  t1MaxTokens?: number;
  t2MaxTokens?: number;
  t3MaxTokens?: number;
}

interface BudgetConfig {
  dailyBudgetUsd?: number;
  sessionBudgetUsd?: number;
  warnAtPct: number;
}

type SettingsTab = 'identities' | 'tier-limits' | 'budget' | 'danger';

// ── Section Tabs ───────────────────────────────

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'identities',  label: 'Identities',  icon: '◎' },
  { id: 'tier-limits', label: 'Tier Limits',  icon: '⊟' },
  { id: 'budget',      label: 'Budget',       icon: '⟁' },
  { id: 'danger',      label: 'Danger Zone',  icon: '⚡' },
];

// ── Main Component ─────────────────────────────

export function SettingsView({ token }: { token: string }) {
  const dispatch = useAppDispatch();
  const [activeTab, setActiveTab] = useState<SettingsTab>('identities');

  return (
    <div className="flex h-full overflow-hidden animate-fade-in">
      {/* Side nav */}
      <nav className="w-44 flex-shrink-0 border-r border-[var(--border-base)] p-4 flex flex-col gap-1">
        <p className="section-label mb-3">Settings</p>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-sm)] text-sm transition-all text-left
              ${activeTab === t.id
                ? 'bg-[var(--accent)]/15 text-[var(--accent)] font-medium'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
          >
            <span className="text-[11px] font-mono opacity-70">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-2xl mx-auto">
          {activeTab === 'identities' && <IdentitiesPanel token={token} />}
          {activeTab === 'tier-limits' && <TierLimitsPanel token={token} />}
          {activeTab === 'budget' && <BudgetPanel token={token} />}
          {activeTab === 'danger' && <DangerPanel token={token} dispatch={dispatch} />}
        </div>
      </div>
    </div>
  );
}

// ── Identities Panel ───────────────────────────

function IdentitiesPanel({ token }: { token: string }) {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', systemPrompt: '', setDefault: false });
  const [error, setError] = useState('');

  const fetchIdentities = useCallback(async () => {
    try {
      const res = await fetch('/api/identities', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setIdentities(await res.json() as Identity[]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchIdentities(); }, [fetchIdentities]);

  const resetForm = () => { setForm({ name: '', description: '', systemPrompt: '', setDefault: false }); setError(''); };

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    const res = await fetch('/api/identities', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) { resetForm(); setCreating(false); await fetchIdentities(); }
    else setError('Failed to create identity');
  };

  const handleUpdate = async (id: string, updates: Partial<Identity> & { setDefault?: boolean }) => {
    await fetch(`/api/identities/${id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    setEditingId(null);
    await fetchIdentities();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/identities/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    await fetchIdentities();
  };

  if (loading) return <Spinner />;

  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-bold text-[var(--text-primary)]">Identities</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">Persona profiles that shape how agents behave.</p>
        </div>
        <button onClick={() => { resetForm(); setCreating(true); }} className="btn btn-primary h-8 text-sm px-3">
          + New Identity
        </button>
      </div>

      {/* Create form */}
      {creating && (
        <div className="glass-elevated rounded-[var(--radius-lg)] p-5 mb-6 border border-[var(--accent)]/30">
          <p className="font-medium text-[var(--text-primary)] mb-4">Create Identity</p>
          <IdentityForm form={form} onChange={setForm} error={error} />
          <div className="flex gap-2 mt-4">
            <button onClick={handleCreate} className="btn btn-primary text-sm">Create</button>
            <button onClick={() => { setCreating(false); resetForm(); }} className="btn glass text-sm">Cancel</button>
          </div>
        </div>
      )}

      {identities.length === 0 && !creating && (
        <div className="text-center py-12 text-[var(--text-muted)]">
          <p className="text-2xl mb-2">◎</p>
          <p>No identities yet. Create one above.</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {identities.map(identity => (
          <IdentityCard
            key={identity.id}
            identity={identity}
            token={token}
            editing={editingId === identity.id}
            onEdit={() => setEditingId(editingId === identity.id ? null : identity.id)}
            onSave={(updates) => handleUpdate(identity.id, updates)}
            onDelete={() => handleDelete(identity.id)}
            onSetDefault={() => handleUpdate(identity.id, { setDefault: true })}
          />
        ))}
      </div>
    </section>
  );
}

function IdentityForm({ form, onChange, error }: {
  form: { name: string; description: string; systemPrompt: string; setDefault: boolean };
  onChange: (f: typeof form) => void;
  error: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="section-label mb-1 block">Name *</label>
        <input className="input" placeholder="e.g. Senior Engineer" value={form.name} onChange={e => onChange({ ...form, name: e.target.value })} />
      </div>
      <div>
        <label className="section-label mb-1 block">Description</label>
        <input className="input" placeholder="Short description" value={form.description} onChange={e => onChange({ ...form, description: e.target.value })} />
      </div>
      <div>
        <label className="section-label mb-1 block">System Prompt</label>
        <textarea
          className="input resize-none"
          rows={3}
          placeholder="You are a senior engineer who writes concise, maintainable code..."
          value={form.systemPrompt}
          onChange={e => onChange({ ...form, systemPrompt: e.target.value })}
        />
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={form.setDefault} onChange={e => onChange({ ...form, setDefault: e.target.checked })} className="accent-[var(--accent)]" />
        <span className="text-sm text-[var(--text-muted)]">Set as default identity</span>
      </label>
      {error && <p className="text-[11px] text-[var(--error)] font-mono">{error}</p>}
    </div>
  );
}

function IdentityCard({ identity, editing, onEdit, onSave, onDelete, onSetDefault }: {
  identity: Identity;
  token: string;
  editing: boolean;
  onEdit: () => void;
  onSave: (updates: Partial<Identity> & { setDefault?: boolean }) => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  const [editForm, setEditForm] = useState({
    name: identity.name, description: identity.description ?? '', systemPrompt: identity.systemPrompt ?? '', setDefault: identity.isDefault,
  });
  const [confirmDel, setConfirmDel] = useState(false);

  return (
    <div className={`glass-elevated rounded-[var(--radius-lg)] p-4 border transition-all ${editing ? 'border-[var(--accent)]/40' : 'border-[var(--border-base)]'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-full bg-[var(--accent)]/20 flex items-center justify-center flex-shrink-0 text-[var(--accent)] font-bold text-sm">
            {identity.name[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-[var(--text-primary)] truncate">{identity.name}</p>
              {identity.isDefault && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/20 text-[var(--accent)] font-mono">Default</span>
              )}
            </div>
            {identity.description && (
              <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{identity.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!identity.isDefault && (
            <button onClick={onSetDefault} className="btn glass text-xs h-7 px-2">Set Default</button>
          )}
          <button onClick={onEdit} className="btn glass text-xs h-7 px-2">{editing ? 'Cancel' : 'Edit'}</button>
          {confirmDel
            ? <button onClick={onDelete} className="btn text-xs h-7 px-2 bg-[var(--error)] border-transparent text-white">Confirm</button>
            : <button onClick={() => setConfirmDel(true)} className="btn glass text-xs h-7 px-2 text-[var(--error)]">Delete</button>
          }
        </div>
      </div>

      {editing && (
        <div className="mt-4 pt-4 border-t border-[var(--border-base)]">
          <IdentityForm form={editForm} onChange={setEditForm} error="" />
          <div className="flex gap-2 mt-4">
            <button onClick={() => onSave(editForm)} className="btn btn-primary text-sm">Save Changes</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tier Limits Panel ──────────────────────────

function TierLimitsPanel({ token }: { token: string }) {
  const [limits, setLimits] = useState<TierLimits>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((cfg: { tierLimits?: TierLimits }) => { if (cfg.tierLimits) setLimits(cfg.tierLimits); })
      .catch(() => setError('Failed to load tier limits.'));
  }, [token]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tierLimits: limits }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError('Failed to save tier limits.');
    } finally {
      setSaving(false);
    }
  };

  const tiers: { key: keyof TierLimits; label: string; desc: string; placeholder: string }[] = [
    { key: 't1MaxTokens', label: 'T1 (Administrator)',  desc: 'Max output tokens for the planner tier',    placeholder: '4096' },
    { key: 't2MaxTokens', label: 'T2 (Manager)',        desc: 'Max output tokens for manager/coordinator', placeholder: '8192' },
    { key: 't3MaxTokens', label: 'T3 (Worker)',         desc: 'Max output tokens for each task worker',    placeholder: '32768' },
  ];

  return (
    <section>
      <h2 className="text-lg font-bold text-[var(--text-primary)] mb-1">Tier Token Limits</h2>
      <p className="text-sm text-[var(--text-muted)] mb-6">Cap the maximum output tokens per AI call for each tier. Leave blank to use model defaults.</p>

      <div className="glass-elevated rounded-[var(--radius-lg)] divide-y divide-[var(--border-base)]">
        {tiers.map(t => (
          <div key={t.key} className="flex items-center justify-between p-5 gap-6">
            <div>
              <p className="font-medium text-[var(--text-primary)]">{t.label}</p>
              <p className="text-sm text-[var(--text-muted)] mt-0.5">{t.desc}</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={128}
                max={200000}
                step={128}
                placeholder={t.placeholder}
                value={limits[t.key] ?? ''}
                onChange={e => setLimits(prev => ({ ...prev, [t.key]: e.target.value ? Number(e.target.value) : undefined }))}
                className="input w-28 text-right font-mono text-sm"
              />
              <span className="text-xs text-[var(--text-faint)] font-mono">tokens</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button onClick={handleSave} disabled={saving} className="btn btn-primary">
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Limits'}
        </button>
        {saved && <span className="text-xs text-green-400 font-mono">Persisted to .cascade/config.json</span>}
        {error && <span className="text-xs text-[var(--error)] font-mono">{error}</span>}
      </div>
    </section>
  );
}

// ── Budget Panel ───────────────────────────────

function BudgetPanel({ token }: { token: string }) {
  const [budget, setBudget] = useState<BudgetConfig>({ warnAtPct: 80 });
  const [stats, setStats] = useState<{ totalCostUsd: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((cfg: { budget?: BudgetConfig }) => { if (cfg.budget) setBudget(cfg.budget); })
      .catch(() => setError('Failed to load budget config.'));
    fetch('/api/stats', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((s: { totalCostUsd: number }) => setStats(s))
      .catch(() => { /* stats are informational — fail silently */ });
  }, [token]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError('Failed to save budget.');
    } finally {
      setSaving(false);
    }
  };

  const sessionPct = budget.sessionBudgetUsd && stats
    ? Math.min(100, (stats.totalCostUsd / budget.sessionBudgetUsd) * 100)
    : null;
  const warnPct = budget.warnAtPct;

  return (
    <section>
      <h2 className="text-lg font-bold text-[var(--text-primary)] mb-1">Cost Budget</h2>
      <p className="text-sm text-[var(--text-muted)] mb-6">Set spending limits. The agent will abort if a session budget is exceeded.</p>

      <div className="glass-elevated rounded-[var(--radius-lg)] divide-y divide-[var(--border-base)] mb-4">
        {/* Session budget */}
        <div className="p-5">
          <div className="flex items-center justify-between gap-6">
            <div>
              <p className="font-medium text-[var(--text-primary)]">Session Budget</p>
              <p className="text-sm text-[var(--text-muted)] mt-0.5">Max spend per REPL session. Exceeding this aborts the current run.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-faint)] font-mono text-sm">$</span>
              <input
                type="number" min={0} step={0.01} placeholder="0.50"
                value={budget.sessionBudgetUsd ?? ''}
                onChange={e => setBudget(prev => ({ ...prev, sessionBudgetUsd: e.target.value ? Number(e.target.value) : undefined }))}
                className="input w-24 text-right font-mono text-sm"
              />
            </div>
          </div>
          {sessionPct !== null && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-[var(--text-faint)] mb-1">
                <span>Session spend</span>
                <span>${stats?.totalCostUsd.toFixed(4)} / ${budget.sessionBudgetUsd?.toFixed(2)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-[var(--bg-base)] overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${sessionPct >= 100 ? 'bg-[var(--error)]' : sessionPct >= warnPct ? 'bg-yellow-400' : 'bg-[var(--accent)]'}`}
                  style={{ width: `${sessionPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Daily budget (display only) */}
        <div className="p-5">
          <div className="flex items-center justify-between gap-6">
            <div>
              <p className="font-medium text-[var(--text-primary)]">Daily Budget <span className="text-xs text-[var(--text-faint)] ml-1">(display only)</span></p>
              <p className="text-sm text-[var(--text-muted)] mt-0.5">Informational limit shown in the dashboard for reference.</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-faint)] font-mono text-sm">$</span>
              <input
                type="number" min={0} step={0.10} placeholder="5.00"
                value={budget.dailyBudgetUsd ?? ''}
                onChange={e => setBudget(prev => ({ ...prev, dailyBudgetUsd: e.target.value ? Number(e.target.value) : undefined }))}
                className="input w-24 text-right font-mono text-sm"
              />
            </div>
          </div>
        </div>

        {/* Warn-at slider */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="font-medium text-[var(--text-primary)]">Warn at</p>
              <p className="text-sm text-[var(--text-muted)] mt-0.5">Show a dashboard warning when spend reaches this % of limit.</p>
            </div>
            <span className="text-sm font-mono text-[var(--accent)]">{budget.warnAtPct}%</span>
          </div>
          <input
            type="range" min={10} max={99} step={5}
            value={budget.warnAtPct}
            onChange={e => setBudget(prev => ({ ...prev, warnAtPct: Number(e.target.value) }))}
            className="w-full accent-[var(--accent)]"
          />
          <div className="flex justify-between text-xs text-[var(--text-faint)] mt-1">
            <span>10%</span><span>50%</span><span>99%</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving} className="btn btn-primary">
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Budget'}
        </button>
        {saved && <span className="text-xs text-green-400 font-mono">Persisted to .cascade/config.json</span>}
        {error && <span className="text-xs text-[var(--error)] font-mono">{error}</span>}
      </div>
    </section>
  );
}

// ── Danger Panel ───────────────────────────────

function DangerPanel({ token, dispatch }: { token: string; dispatch: ReturnType<typeof useAppDispatch> }) {
  const [clearing, setClearing] = useState<string | null>(null);
  const [confirmSessions, setConfirmSessions] = useState(false);

  const doDelete = async (endpoint: string) => {
    setClearing(endpoint);
    try {
      await fetch(endpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    } finally {
      setClearing(null);
      setConfirmSessions(false);
    }
  };

  return (
    <section>
      <h2 className="text-lg font-bold text-[var(--error)] mb-1">Danger Zone</h2>
      <p className="text-sm text-[var(--text-muted)] mb-6">These actions are irreversible.</p>

      <div className="rounded-[var(--radius-lg)] border border-[var(--error)]/30 divide-y divide-[var(--error)]/10 overflow-hidden">
        <DangerRow
          title="Clear All Sessions"
          desc="Permanently delete all conversation sessions and messages."
          action={confirmSessions
            ? <button onClick={() => doDelete('/api/sessions')} disabled={!!clearing} className="btn text-sm bg-[var(--error)] border-transparent text-white">
                {clearing === '/api/sessions' ? 'Clearing…' : 'Confirm Delete'}
              </button>
            : <button onClick={() => setConfirmSessions(true)} className="btn glass text-sm border-[var(--error)]/40 text-[var(--error)]">Clear Sessions</button>
          }
        />
        <DangerRow
          title="Clear Graphs (Backend + Frontend)"
          desc="Delete all runtime node logs from DB and reset the topology view."
          action={
            <button
              onClick={async () => { await doDelete('/api/runtime'); dispatch(clearFrontendGraphs()); }}
              disabled={!!clearing}
              className="btn glass text-sm border-[var(--error)]/40 text-[var(--error)]"
            >
              {clearing === '/api/runtime' ? 'Clearing…' : 'Clear DB Graphs'}
            </button>
          }
        />
        <DangerRow
          title="Clear Graphs (Frontend Only)"
          desc="Reset the topology view locally without touching the server database."
          action={
            <button onClick={() => dispatch(clearFrontendGraphs())} className="btn glass text-sm">
              Clear View
            </button>
          }
        />
      </div>
    </section>
  );
}

function DangerRow({ title, desc, action }: { title: string; desc: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 p-5 bg-[var(--error)]/[0.03]">
      <div>
        <p className="font-medium text-[var(--text-primary)]">{title}</p>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">{desc}</p>
      </div>
      <div className="flex-shrink-0">{action}</div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-6 h-6 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
    </div>
  );
}
