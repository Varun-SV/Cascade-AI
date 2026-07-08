import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3, CalendarClock, ShieldCheck, RefreshCcw, Plus, Trash2, Play, Pause,
  Coins, Cpu, MessageSquare, ListChecks, Table2, ShieldAlert, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useAppSelector } from '../store/index.js';
import { HelpButton } from '../help/HelpButton.js';

// ─── Shared fetch helper ──────────────────────────────────────────────────────

function useApi() {
  const { backendPort, authToken } = useAppSelector((s) => s.app);
  return useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`http://localhost:${backendPort}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${authToken}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error((body?.['error'] as string) ?? `HTTP ${res.status}`);
    return body;
  }, [backendPort, authToken]);
}

const fmtUsd = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);
const fmtCompact = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v));

// ─── View shell with sub-tabs ─────────────────────────────────────────────────

type InsightsTab = 'costs' | 'schedules' | 'audit';

export function InsightsView() {
  const [tab, setTab] = useState<InsightsTab>('costs');

  const tabBtn = (id: InsightsTab, label: string, Icon: typeof BarChart3) => (
    <button
      onClick={() => setTab(id)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, height: '100%', padding: '0 4px',
        background: 'none', border: 'none', cursor: 'pointer',
        fontSize: 11.5, fontWeight: 600,
        color: tab === id ? 'var(--text)' : 'var(--text-dim)',
        borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`,
      }}
    >
      <Icon size={13} /> {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        height: 35, padding: '0 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-surface)', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0,
      }}>
        <BarChart3 size={14} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '-0.1px' }}>Insights</span>
        <div style={{ display: 'flex', gap: 14, height: '100%', marginLeft: 8 }}>
          {tabBtn('costs', 'Costs', Coins)}
          {tabBtn('schedules', 'Schedules', CalendarClock)}
          {tabBtn('audit', 'Audit log', ShieldCheck)}
        </div>
        <div style={{ flex: 1 }} />
        <HelpButton context="cost-analytics" />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'costs' && <CostsTab />}
        {tab === 'schedules' && <SchedulesTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}

// ─── Costs ────────────────────────────────────────────────────────────────────

interface CostData {
  totalCostUsd: number;
  totalTokens: number;
  totalSessions: number;
  totalRuns: number;
  perDay: Array<{ date: string; costUsd: number; tokens: number; runs: number }>;
  topSessions: Array<{ sessionId: string; title: string; costUsd: number; tokens: number; runs: number; updatedAt: string }>;
  budget?: { dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxCostPerRunUsd?: number };
}

function StatTile({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Coins }) {
  return (
    <div style={{ flex: 1, minWidth: 120, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
        <Icon size={12} style={{ color: 'var(--text-dim)' }} /> {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.3px' }}>{value}</div>
    </div>
  );
}

/** Round a max value up to a clean axis ceiling (1/2/5 × 10^n). */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const unit = v / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

/**
 * Spend-per-day column chart. Single series → single hue (the app accent),
 * no legend; thin columns with rounded data-ends and a square baseline;
 * hairline gridlines on clean ticks; per-column hover tooltip; a table
 * toggle carries the exact values.
 */
function DailySpendChart({ perDay }: { perDay: CostData['perDay'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const W = 760, H = 200, PAD_L = 46, PAD_R = 8, PAD_T = 14, PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const maxVal = niceCeil(Math.max(...perDay.map((d) => d.costUsd), 0.000001));
  const ticks = [0, maxVal / 2, maxVal];
  const band = plotW / perDay.length;
  const barW = Math.min(24, Math.max(3, band - 2)); // ≤24px thick, 2px surface gap

  const label = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;

  if (asTable) {
    return (
      <div>
        <ChartHeader title="Spend per day — last 30 days" asTable={asTable} onToggle={() => setAsTable(false)} />
        <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
                {['Day', 'Spend', 'Tokens', 'Runs'].map((h) => (
                  <th key={h} style={{ textAlign: h === 'Day' ? 'left' : 'right', padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...perDay].reverse().map((d) => (
                <tr key={d.date}>
                  <td style={{ padding: '4px 10px', color: 'var(--text)', borderBottom: '1px solid var(--border)' }}>{d.date}</td>
                  <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--text)', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(d.costUsd)}</td>
                  <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(d.tokens)}</td>
                  <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}>{d.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const hovered = hover != null ? perDay[hover] : null;

  return (
    <div>
      <ChartHeader title="Spend per day — last 30 days" asTable={asTable} onToggle={() => setAsTable(true)} />
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} onMouseLeave={() => setHover(null)}>
          {/* gridlines + ticks (hairline, recessive) */}
          {ticks.map((t) => {
            const y = PAD_T + plotH - (t / maxVal) * plotH;
            return (
              <g key={t}>
                <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
                <text x={PAD_L - 6} y={y + 3.5} textAnchor="end" fontSize={9.5} fill="var(--text-dim)">{fmtUsd(t)}</text>
              </g>
            );
          })}
          {/* columns — grow from the baseline, rounded cap at the data end only */}
          {perDay.map((d, i) => {
            const h = maxVal > 0 ? (d.costUsd / maxVal) * plotH : 0;
            const x = PAD_L + i * band + (band - barW) / 2;
            const y = PAD_T + plotH - h;
            const r = Math.min(4, barW / 2, h);
            const isHover = hover === i;
            return (
              <g key={d.date}>
                {/* invisible full-height hit target — bigger than the mark */}
                <rect x={PAD_L + i * band} y={PAD_T} width={band} height={plotH} fill="transparent"
                  onMouseEnter={() => setHover(i)} />
                {h > 0 && (
                  <path
                    d={`M ${x} ${PAD_T + plotH} V ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + barW - r} Q ${x + barW} ${y} ${x + barW} ${y + r} V ${PAD_T + plotH} Z`}
                    fill="var(--accent)" opacity={hover == null || isHover ? 1 : 0.45}
                    style={{ pointerEvents: 'none', transition: 'opacity 0.1s' }}
                  />
                )}
              </g>
            );
          })}
          {/* x labels: first, middle, last */}
          {[0, Math.floor(perDay.length / 2), perDay.length - 1].map((i) => perDay[i] && (
            <text key={i} x={PAD_L + i * band + band / 2} y={H - 7} textAnchor="middle" fontSize={9.5} fill="var(--text-dim)">
              {label(perDay[i]!.date)}
            </text>
          ))}
          {/* baseline */}
          <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + plotH} y2={PAD_T + plotH} stroke="var(--border-strong)" strokeWidth={1} />
        </svg>
        {hovered && hover != null && (
          <div style={{
            position: 'absolute',
            left: `${((PAD_L + hover * band + band / 2) / W) * 100}%`,
            top: 0, transform: 'translateX(-50%)',
            background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderRadius: 6,
            padding: '5px 9px', fontSize: 10.5, color: 'var(--text)', pointerEvents: 'none', whiteSpace: 'nowrap',
            boxShadow: 'var(--shadow-2)', zIndex: 2,
          }}>
            <b>{hovered.date}</b> · {fmtUsd(hovered.costUsd)} · {fmtCompact(hovered.tokens)} tok · {hovered.runs} run{hovered.runs !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

function ChartHeader({ title, asTable, onToggle }: { title: string; asTable: boolean; onToggle: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
      <div style={{ flex: 1 }} />
      <button
        onClick={onToggle}
        title={asTable ? 'Show as chart' : 'Show as table'}
        style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-dim)', fontSize: 10, padding: '2px 7px', cursor: 'pointer' }}
      >
        {asTable ? <BarChart3 size={10} /> : <Table2 size={10} />} {asTable ? 'chart' : 'table'}
      </button>
    </div>
  );
}

function CostsTab() {
  const api = useApi();
  const [data, setData] = useState<CostData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api('/api/costs')
      .then((d) => { setData(d as unknown as CostData); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  if (error) return <PanelMessage text={`Couldn't load cost analytics: ${error}`} onRetry={load} />;
  if (!data) return <PanelMessage text="Loading cost analytics…" />;

  const today = data.perDay[data.perDay.length - 1];
  const dailyBudget = data.budget?.dailyBudgetUsd;
  const budgetPct = dailyBudget && dailyBudget > 0 && today ? Math.min(100, (today.costUsd / dailyBudget) * 100) : null;
  const maxTop = Math.max(...data.topSessions.map((s) => s.costUsd), 0.000001);

  return (
    <div style={{ padding: 18, maxWidth: 860, margin: '0 auto' }}>
      {/* KPI row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        <StatTile label="Total spend" value={fmtUsd(data.totalCostUsd)} icon={Coins} />
        <StatTile label="Tokens" value={fmtCompact(data.totalTokens)} icon={Cpu} />
        <StatTile label="Sessions" value={String(data.totalSessions)} icon={MessageSquare} />
        <StatTile label="Runs" value={String(data.totalRuns)} icon={ListChecks} />
      </div>

      {/* Budget meter — only when a daily budget is configured */}
      {budgetPct != null && today && (
        <div style={{ marginBottom: 18, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            <span>Today vs daily budget</span>
            <span style={{ color: 'var(--text)' }}>{fmtUsd(today.costUsd)} of {fmtUsd(dailyBudget!)}</span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'color-mix(in srgb, var(--accent) 15%, transparent)', overflow: 'hidden' }}>
            <div style={{
              width: `${budgetPct}%`, height: '100%', borderRadius: 4,
              background: budgetPct >= 100 ? 'var(--danger)' : budgetPct >= 80 ? 'var(--warn)' : 'var(--accent)',
            }} />
          </div>
        </div>
      )}

      {/* Daily spend */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 18 }}>
        <DailySpendChart perDay={data.perDay} />
      </div>

      {/* Top sessions — horizontal bar list, single hue, value at the tip */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Most expensive sessions</div>
        {data.topSessions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No spend recorded yet — run a task and it appears here.</div>
        ) : (
          data.topSessions.map((s) => (
            <div key={s.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
              <span title={s.title} style={{ width: 180, fontSize: 11.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {s.title || 'Untitled session'}
              </span>
              <div style={{ flex: 1, height: 12, display: 'flex', alignItems: 'center' }}>
                <div style={{
                  width: `${Math.max(1.5, (s.costUsd / maxTop) * 100)}%`, height: 12,
                  background: 'var(--accent)', borderRadius: '0 4px 4px 0',
                }} />
              </div>
              <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', flexShrink: 0, minWidth: 62, textAlign: 'right' }}>
                {fmtUsd(s.costUsd)}
              </span>
            </div>
          ))
        )}
      </div>

      <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 11, padding: '5px 10px', cursor: 'pointer' }}>
        <RefreshCcw size={11} /> Refresh
      </button>
    </div>
  );
}

// ─── Schedules ────────────────────────────────────────────────────────────────

interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  prompt: string;
  enabled: boolean;
  lastRun?: string;
  armed?: boolean;
}

const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Daily at 09:00', expr: '0 9 * * *' },
  { label: 'Weekdays at 09:00', expr: '0 9 * * 1-5' },
  { label: 'Weekly (Mon 09:00)', expr: '0 9 * * 1' },
];

function SchedulesTab() {
  const api = useApi();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api('/api/schedules')
      .then((d) => { setSchedules(d as unknown as Schedule[]); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!name.trim() || !cron.trim() || !prompt.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api('/api/schedules', { method: 'POST', body: JSON.stringify({ name, cronExpression: cron, prompt }) });
      setName(''); setPrompt(''); setShowForm(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (s: Schedule) => {
    try {
      await api(`/api/schedules/${s.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (s: Schedule) => {
    try {
      await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: 'var(--bg-base)', border: '1px solid var(--border)',
    borderRadius: 7, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none',
  };

  return (
    <div style={{ padding: 18, maxWidth: 860, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Scheduled tasks</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowForm((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: showForm ? 'var(--bg-raised)' : 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: showForm ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 7, padding: '6px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
        >
          <Plus size={13} /> {showForm ? 'Cancel' : 'New schedule'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
        Cron-timed prompts that run while the app is open. Scheduled runs execute headless — dangerous tools are auto-approved, so scope prompts accordingly.
      </div>

      {error && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 10 }}>{error}</div>}

      {showForm && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly repo summary" style={inputStyle} />
            </div>
            <div style={{ width: 200 }}>
              <label style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Cron expression</label>
              <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {CRON_PRESETS.map((p) => (
              <button key={p.expr} onClick={() => setCron(p.expr)} style={{
                background: cron === p.expr ? 'var(--accent-soft)' : 'var(--bg-raised)',
                border: `1px solid ${cron === p.expr ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 5, color: cron === p.expr ? 'var(--accent)' : 'var(--text-muted)', fontSize: 10.5, padding: '3px 8px', cursor: 'pointer',
              }}>{p.label}</button>
            ))}
          </div>
          <label style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Prompt</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} placeholder="Summarize yesterday's commits and flag anything risky…" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', marginBottom: 10 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => void create()}
              disabled={saving || !name.trim() || !cron.trim() || !prompt.trim()}
              style={{
                background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: '#fff', border: 'none',
                borderRadius: 7, padding: '7px 16px', fontSize: 12, fontWeight: 600,
                cursor: saving ? 'wait' : 'pointer', opacity: !name.trim() || !cron.trim() || !prompt.trim() ? 0.5 : 1,
              }}
            >{saving ? 'Creating…' : 'Create schedule'}</button>
          </div>
        </div>
      )}

      {!schedules ? (
        <PanelMessage text="Loading schedules…" />
      ) : schedules.length === 0 ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12.5 }}>
          <CalendarClock size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
          <div>No scheduled tasks yet.</div>
        </div>
      ) : (
        schedules.map((s) => (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 8,
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10,
            opacity: s.enabled ? 1 : 0.6,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: s.enabled ? 'var(--success)' : 'var(--text-dim)',
              boxShadow: s.enabled ? '0 0 5px var(--success)' : 'none',
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.prompt}</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                {s.cronExpression}{s.lastRun ? ` · last ran ${new Date(s.lastRun).toLocaleString()}` : ' · never ran'}
              </div>
            </div>
            <button onClick={() => void toggle(s)} title={s.enabled ? 'Pause' : 'Resume'} style={{ background: 'none', border: 'none', cursor: 'pointer', color: s.enabled ? 'var(--warn)' : 'var(--success)', padding: 4, display: 'flex' }}>
              {s.enabled ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button onClick={() => void remove(s)} title="Delete schedule" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 4, display: 'flex' }}>
              <Trash2 size={14} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Audit log ────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  timestamp: string;
  eventType: string;
  tierId: string;
  payload: string;
}

function AuditTab() {
  const api = useApi();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; entries: number; firstBadRow?: number } | 'checking' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    api('/api/audit-chain?limit=200')
      .then((d) => {
        const body = d as unknown as { total: number; entries: AuditEntry[] };
        setEntries(body.entries); setTotal(body.total); setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const runVerify = async () => {
    setVerify('checking');
    try {
      const res = await api('/api/audit/verify');
      setVerify(res as unknown as { ok: boolean; entries: number; firstBadRow?: number });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVerify(null);
    }
  };

  const prettyPayload = (payload: string): string => {
    try { return JSON.stringify(JSON.parse(payload), null, 2); } catch { return payload; }
  };

  return (
    <div style={{ padding: 18, maxWidth: 860, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Tamper-evident audit log</span>
        {total > 0 && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{total} entries</span>}
        <div style={{ flex: 1 }} />
        <button onClick={load} title="Refresh" style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
          <RefreshCcw size={11} /> Refresh
        </button>
        <button
          onClick={() => void runVerify()}
          disabled={verify === 'checking'}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 12px', fontSize: 11.5, fontWeight: 600, cursor: verify === 'checking' ? 'wait' : 'pointer' }}
        >
          <ShieldCheck size={13} /> {verify === 'checking' ? 'Verifying…' : 'Verify integrity'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Every orchestration event is encrypted and hash-chained to its predecessor — any edit, delete, or reorder breaks the chain from that point on.
      </div>

      {verify && verify !== 'checking' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', marginBottom: 12, borderRadius: 9, fontSize: 12,
          background: verify.ok ? 'color-mix(in srgb, var(--success) 9%, transparent)' : 'color-mix(in srgb, var(--danger) 9%, transparent)',
          border: `1px solid ${verify.ok ? 'color-mix(in srgb, var(--success) 40%, transparent)' : 'color-mix(in srgb, var(--danger) 40%, transparent)'}`,
          color: verify.ok ? 'var(--success)' : 'var(--danger)', fontWeight: 600,
        }}>
          {verify.ok ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
          {verify.ok
            ? `Chain intact — all ${verify.entries} entries verify.`
            : `Chain BROKEN at row ${verify.firstBadRow} of ${verify.entries} — history was modified after the fact.`}
        </div>
      )}

      {error && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 10 }}>{error}</div>}

      {!entries ? (
        <PanelMessage text="Loading audit log…" />
      ) : entries.length === 0 ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12.5 }}>
          <ShieldCheck size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
          <div>No audit entries yet — they accumulate as runs execute.</div>
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {entries.map((e) => {
            const isOpen = expanded === e.id;
            return (
              <div key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  onClick={() => setExpanded(isOpen ? null : e.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', cursor: 'pointer', background: isOpen ? 'var(--bg-raised)' : 'var(--bg-surface)', fontSize: 11.5 }}
                >
                  {isOpen ? <ChevronDown size={12} style={{ color: 'var(--text-dim)', flexShrink: 0 }} /> : <ChevronRight size={12} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />}
                  <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 10.5, flexShrink: 0 }}>
                    {new Date(e.timestamp).toLocaleString()}
                  </span>
                  <span style={{
                    fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', flexShrink: 0,
                    color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 4, padding: '1px 7px',
                  }}>{e.eventType}</span>
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.tierId}</span>
                </div>
                {isOpen && (
                  <pre style={{
                    margin: 0, padding: '10px 14px 12px 34px', background: 'var(--bg-base)',
                    fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto',
                  }}>{prettyPayload(e.payload)}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────────

function PanelMessage({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div style={{ padding: '40px 18px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
      {text}
      {onRetry && (
        <div style={{ marginTop: 10 }}>
          <button onClick={onRetry} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 11, padding: '5px 12px', cursor: 'pointer' }}>Retry</button>
        </div>
      )}
    </div>
  );
}
