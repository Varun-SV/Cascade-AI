import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Landmark, Check, X, MessageSquarePlus, Undo2 } from 'lucide-react';
import { useAppDispatch, useAppSelector, setPendingPlan, type PendingPlan } from '../store/index.js';

const TIER_COLOR: Record<string, string> = {
  Simple: 'var(--t3)',
  Moderate: 'var(--t2)',
  Complex: 'var(--t1)',
  'Highly Complex': 'var(--danger)',
};

/**
 * The boardroom: a Complex/Moderate run pauses here (planApproval in Settings)
 * before any manager or worker spawns. Shows T1's proposed org chart — the
 * sections, worker counts, and estimated cost — plus the automated reviewer's
 * critique when present. The user can drop sections, send a steering note
 * (T1 re-plans and re-asks), approve, or reject. Answers over `plan:decision`,
 * which resolves the run paused in Cascade.requestPlanApproval; an unanswered
 * plan auto-approves server-side after 2 minutes, matching the CLI.
 */
export function PlanApprovalModal({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  const pending = useAppSelector((s) => s.app.pendingPlan);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [noteMode, setNoteMode] = useState(false);
  const [note, setNote] = useState('');

  // Reset per-plan editing state when a new plan arrives (re-plan rounds
  // deliver a fresh payload for the same session).
  useEffect(() => { setDropped(new Set()); setNoteMode(false); setNote(''); }, [pending?.taskId, pending?.plan]);

  if (!pending) return null;

  const sections = pending.plan.sections ?? [];
  const keptCount = sections.length - dropped.size;

  const decide = (approved: boolean, steerNote?: string) => {
    let editedPlan: PendingPlan['plan'] | undefined;
    if (approved && dropped.size > 0 && keptCount > 0) {
      editedPlan = { ...pending.plan, sections: sections.filter((_, i) => !dropped.has(i)) };
    }
    socket?.emit('plan:decision', {
      sessionId: pending.sessionId,
      approved,
      note: steerNote,
      editedPlan,
    });
    dispatch(setPendingPlan(null));
  };

  const toggleDrop = (i: number) => {
    setDropped((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else if (sections.length - next.size > 1) next.add(i); // never drop the last
      return next;
    });
  };

  const complexity = pending.plan.complexity;
  const btn = (bg: string, color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 12.5,
    borderRadius: 7, cursor: 'pointer', border: 'none', background: bg, color, fontWeight: 600,
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 560, maxWidth: '94vw', maxHeight: '86vh', overflow: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 12, boxShadow: 'var(--shadow-3)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
          <Landmark size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>Boardroom — T1 proposes a plan</span>
          {complexity && (
            <span style={{
              marginLeft: 'auto', fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
              color: TIER_COLOR[complexity] ?? 'var(--text-muted)', padding: '2px 8px', borderRadius: 4,
              background: `color-mix(in srgb, ${TIER_COLOR[complexity] ?? 'var(--text-muted)'} 14%, transparent)`,
            }}>{complexity}</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          The run is paused — nothing spawns until you decide. Auto-approves in 2 minutes.
        </div>

        {pending.plan.reasoning && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', marginBottom: 12, lineHeight: 1.55 }}>
            {pending.plan.reasoning}
          </div>
        )}

        {pending.critique && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--warn)', marginBottom: 4 }}>Reviewer critique</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'color-mix(in srgb, var(--warn) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)', borderRadius: 8, padding: '8px 11px', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {pending.critique}
            </div>
          </div>
        )}

        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6 }}>
          Sections <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— click ✕ to drop one before approving</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {sections.map((s, i) => {
            const isDropped = dropped.has(i);
            const workers = s.t3Subtasks?.length ?? 0;
            return (
              <div key={`${s.sectionTitle}-${i}`} style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px',
                background: isDropped ? 'transparent' : 'var(--bg-raised)',
                border: `1px solid ${isDropped ? 'color-mix(in srgb, var(--danger) 35%, transparent)' : 'var(--border)'}`,
                borderRadius: 8, opacity: isDropped ? 0.55 : 1,
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t2)', flexShrink: 0, marginTop: 1 }}>{i + 1}.</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', textDecoration: isDropped ? 'line-through' : 'none' }}>
                    {s.sectionTitle}
                  </div>
                  {s.description && (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.45 }}>{s.description}</div>
                  )}
                  {workers > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 3, fontWeight: 600 }}>
                      {workers} worker{workers !== 1 ? 's' : ''}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => toggleDrop(i)}
                  title={isDropped ? 'Restore this section' : 'Drop this section from the plan'}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: isDropped ? 'var(--success)' : 'var(--text-dim)', padding: 2, flexShrink: 0 }}
                >
                  {isDropped ? <Undo2 size={13} /> : <X size={13} />}
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          {pending.summary ? (
            <>Will spawn <b style={{ color: 'var(--text)' }}>{pending.summary}</b></>
          ) : (
            <>
              Will spawn <b style={{ color: 'var(--t2)' }}>{keptCount} manager{keptCount !== 1 ? 's' : ''}</b>
              {' · '}<b style={{ color: 'var(--t3)' }}>{pending.t3Count} worker{pending.t3Count !== 1 ? 's' : ''}</b>
              {' · est. '}<b style={{ color: 'var(--success)' }}>${pending.estCostUsd.toFixed(4)}</b>
            </>
          )}
        </div>

        {noteMode ? (
          <div style={{ marginBottom: 4 }}>
            <input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && note.trim()) { e.preventDefault(); decide(true, note.trim()); }
                else if (e.key === 'Escape') { e.preventDefault(); setNoteMode(false); setNote(''); }
              }}
              placeholder="Steer T1 — e.g. split section 2, add tests, drop the docs section…"
              style={{
                width: '100%', boxSizing: 'border-box', background: 'var(--bg-base)', border: '1px solid var(--accent)',
                borderRadius: 7, color: 'var(--text)', padding: '8px 11px', fontSize: 12.5, outline: 'none', marginBottom: 8,
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={btn('var(--bg-raised)', 'var(--text-muted)')} onClick={() => { setNoteMode(false); setNote(''); }}>Cancel</button>
              <button
                style={{ ...btn('linear-gradient(135deg, var(--accent), var(--accent-2))', '#fff'), opacity: note.trim() ? 1 : 0.5 }}
                disabled={!note.trim()}
                onClick={() => decide(true, note.trim())}
              >
                <MessageSquarePlus size={14} /> Send note — T1 re-plans
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button style={btn('var(--bg-raised)', 'var(--danger)')} onClick={() => decide(false)}>
              <X size={14} /> Reject
            </button>
            <button style={btn('var(--bg-raised)', 'var(--text)')} onClick={() => setNoteMode(true)} title="Send a steering note — T1 revises the plan and asks again">
              <MessageSquarePlus size={14} /> Steer & re-plan
            </button>
            <button style={btn('linear-gradient(135deg, var(--accent), var(--accent-2))', '#fff')} onClick={() => decide(true)}>
              <Check size={14} /> Approve{dropped.size > 0 ? ` ${keptCount} of ${sections.length}` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
