import { useEffect, useState } from 'react';
import { Gauge, Cpu, RefreshCcw, ShieldAlert, X, PiggyBank, HelpCircle } from 'lucide-react';
import { useAppDispatch, useAppSelector, setShowWhyPanel, setWhyReport, type WhyReport } from '../store/index.js';

const KIND_META: Record<WhyReport['decisions'][number]['kind'], { label: string; icon: typeof Gauge; color: string }> = {
  complexity: { label: 'Complexity', icon: Gauge,       color: 'var(--t1)' },
  model:      { label: 'Model',      icon: Cpu,         color: 'var(--t2)' },
  failover:   { label: 'Failover',   icon: RefreshCcw,  color: 'var(--warn)' },
  escalation: { label: 'Escalation', icon: ShieldAlert, color: 'var(--danger)' },
};

const TIER_COLOR: Record<string, string> = { T1: 'var(--t1)', T2: 'var(--t2)', T3: 'var(--t3)' };

/**
 * The run inspector — desktop `/why`. Explains how the current session's last
 * run was routed: the complexity verdict and the classifier's reasoning, which
 * model served each tier, provider failovers, permission escalations, the
 * per-tier cost split, and the delegation-savings receipt. Live data arrives
 * over `run:why` (stored per session); opening the panel for a session that
 * ran before this window connected falls back to GET /api/sessions/:id/why.
 */
export function WhyPanel() {
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.app.showWhyPanel);
  const { whyBySession, activeSessionId, sessionId, backendPort, authToken } = useAppSelector((s) => s.app);
  const currentSessionId = activeSessionId ?? sessionId;
  const report = currentSessionId ? whyBySession[currentSessionId] : undefined;
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'missing'>('idle');

  // REST fallback when the panel opens without a live-captured report.
  useEffect(() => {
    if (!open || report || !currentSessionId || !backendPort) return;
    setFetchState('loading');
    fetch(`http://localhost:${backendPort}/api/sessions/${currentSessionId}/why`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: WhyReport | null) => {
        if (data) { dispatch(setWhyReport(data)); setFetchState('idle'); }
        else setFetchState('missing');
      })
      .catch(() => setFetchState('missing'));
  }, [open, report, currentSessionId, backendPort, authToken, dispatch]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch(setShowWhyPanel(false)); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dispatch]);

  if (!open) return null;

  const tierCosts = Object.entries(report?.costByTier ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const maxTierCost = Math.max(...tierCosts.map(([, c]) => c), 0.000001);

  return (
    <aside style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 380, maxWidth: '90vw', zIndex: 300,
      background: 'var(--bg-surface)', borderLeft: '1px solid var(--border-strong)',
      boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column',
      animation: 'fadeIn 0.15s var(--ease)',
    }}>
      <div style={{ height: 40, padding: '0 14px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <HelpCircle size={15} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 700, fontSize: 13 }}>Why? — run inspector</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => dispatch(setShowWhyPanel(false))}
          title="Close (Esc)"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex' }}
        ><X size={15} /></button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {!report ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.6, marginTop: 12 }}>
            {fetchState === 'loading'
              ? 'Loading the decision trail…'
              : 'No decision trail for this session yet. Run a task, then come back — every run records how it was routed.'}
          </div>
        ) : (
          <>
            {/* Receipt */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 12,
              background: report.savedUsd > 0 ? 'color-mix(in srgb, var(--success) 8%, transparent)' : 'var(--bg-raised)',
              border: `1px solid ${report.savedUsd > 0 ? 'color-mix(in srgb, var(--success) 35%, transparent)' : 'var(--border)'}`,
              borderRadius: 10,
            }}>
              <PiggyBank size={20} style={{ color: report.savedUsd > 0 ? 'var(--success)' : 'var(--text-dim)', flexShrink: 0 }} />
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ color: 'var(--text)', fontWeight: 700 }}>
                  ${report.totalCostUsd.toFixed(4)} · {report.totalTokens >= 1000 ? `${(report.totalTokens / 1000).toFixed(1)}k` : report.totalTokens} tokens
                  {report.durationMs != null && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {(report.durationMs / 1000).toFixed(1)}s</span>}
                </div>
                <div style={{ color: report.savedUsd > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                  {report.savedUsd > 0
                    ? <>saved ${report.savedUsd.toFixed(4)} — {report.savedPct}% vs. all-T1</>
                    : 'no delegation savings on this run'}
                </div>
              </div>
            </div>

            {/* Per-tier cost bars */}
            {tierCosts.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6 }}>Cost by tier</div>
                {tierCosts.map(([tier, cost]) => (
                  <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <span style={{ width: 22, fontSize: 10.5, fontWeight: 800, color: TIER_COLOR[tier] ?? 'var(--text-muted)', flexShrink: 0 }}>{tier}</span>
                    <div style={{ flex: 1, height: 8, background: 'var(--bg-base)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.max(2, (cost / maxTierCost) * 100)}%`, height: '100%', background: TIER_COLOR[tier] ?? 'var(--accent)', borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', flexShrink: 0, minWidth: 54, textAlign: 'right' }}>${cost.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Decision trail */}
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6 }}>Decision trail</div>
            {report.decisions.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>The run recorded no routing decisions.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {report.decisions.map((d, i) => {
                  const meta = KIND_META[d.kind] ?? KIND_META.model;
                  const Icon = meta.icon;
                  return (
                    <div key={i} style={{ display: 'flex', gap: 10, position: 'relative', paddingBottom: 12 }}>
                      {/* timeline rail */}
                      {i < report.decisions.length - 1 && (
                        <span style={{ position: 'absolute', left: 11, top: 22, bottom: 0, width: 1, background: 'var(--border)' }} />
                      )}
                      <span style={{
                        width: 23, height: 23, borderRadius: '50%', flexShrink: 0, zIndex: 1,
                        background: `color-mix(in srgb, ${meta.color} 14%, var(--bg-surface))`,
                        border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', color: meta.color,
                      }}><Icon size={11} /></span>
                      <div style={{ minWidth: 0, paddingTop: 2 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, letterSpacing: 0.4, textTransform: 'uppercase' }}>{meta.label}</span>
                        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, wordBreak: 'break-word' }}>{d.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
