import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { ChevronDown, ChevronRight, MessageSquareText, RotateCcw, SkipForward } from 'lucide-react';
import { useAppDispatch, useAppSelector, dequeueEscalation } from '../store/index.js';
import { CHOICES, clock, draftPreview, readIssues, wordCount, type EscalationChoice } from '../lib/escalation-view.js';

/**
 * A section stopped and asked a question, shown as a card on the cascade:
 * where in the run it stopped, what failed, what it has so far, and the three
 * ways on. The run is parked inside the SDK while this is open.
 *
 * The deadline drains along the top: unlike the boardroom gate, which
 * auto-approves, an unanswered escalation FAILS the section, and hiding that
 * would make the failure look arbitrary when it arrives.
 *
 * Same layout, words and keys as the web card (cloud/web/src/chat/EscalationModal.tsx).
 */
export function EscalationModal({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  // The head of the queue. Sections in a wave escalate concurrently, so more
  // than one can be waiting; answering reveals the next rather than losing it.
  const pending = useAppSelector((s) => s.app.pendingEscalations[0] ?? null);
  const queued = useAppSelector((s) => s.app.pendingEscalations.length);
  const [choice, setChoice] = useState<EscalationChoice | null>(null);
  const [note, setNote] = useState('');
  const [showDraft, setShowDraft] = useState(false);
  const [showGoal, setShowGoal] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // A different section asking starts from nothing: guidance never carries across.
  useEffect(() => { setChoice(null); setNote(''); setShowDraft(false); setShowGoal(false); }, [pending?.sectionId, pending?.taskId, pending?.requestId]);

  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pending?.sectionId, pending?.taskId, pending]);

  // Close at the local deadline instead of only relabelling: `escalation:timeout`
  // is not replayed on reconnect, so a dropped socket would leave live buttons
  // answering a request the server had already abandoned.
  const expired = !!pending && Date.now() - pending.receivedAt >= pending.timeoutMs;
  useEffect(() => {
    if (expired && pending) dispatch(dequeueEscalation(pending));
  }, [expired, dispatch, pending]);

  const ready = choice !== null && (choice !== 'guidance' || note.trim().length > 0);

  const decide = () => {
    if (!pending || !ready || !choice) return;
    socket?.emit('escalation:decide', {
      sessionId: pending.sessionId,
      requestId: pending.requestId,
      action: choice,
      note: choice === 'guidance' ? note.trim() : undefined,
    });
    dispatch(dequeueEscalation(pending));
  };

  // G / R / S choose and Enter confirms; never while typing, where a letter is a letter.
  useEffect(() => {
    if (!pending || expired) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = CHOICES.find((c) => c.key.toLowerCase() === e.key.toLowerCase());
      if (hit) { e.preventDefault(); setChoice(hit.id); }
      // Enter on a focused button or link is that control's own (View, a card, the goal):
      // it confirms only when nothing interactive has the focus.
      else if (e.key === 'Enter' && ready && !(e.target instanceof Element && e.target.closest('button, a, [role="button"], [role="radio"], summary'))) { e.preventDefault(); decide(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!pending || expired) return null;

  // Counting from receivedAt rather than mount keeps the deadline honest if the
  // user switches views and comes back.
  const remaining = pending.timeoutMs - (now - pending.receivedAt);
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const left = Math.max(0, Math.min(1, remaining / pending.timeoutMs));
  const urgent = seconds <= 60;
  const { checks, notes } = readIssues(pending.issues);
  const draft = draftPreview(pending.summary ?? '');
  const chosen = CHOICES.find((c) => c.id === choice);
  const icon = (id: EscalationChoice) => (id === 'guidance' ? <MessageSquareText size={15} /> : id === 'retry' ? <RotateCcw size={15} /> : <SkipForward size={15} />);

  const label: React.CSSProperties = { fontSize: 11.5, fontWeight: 500, color: 'var(--text-dim)', paddingTop: 1 };

  return (
    // zIndex 600: strictly above the command palette and Help panel (both
    // 500). The run is PARKED waiting on this decision; if either could cover
    // it, the section would fail on the timeout with nothing having appeared.
    <div style={{ position: 'fixed', inset: 0, zIndex: 600, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={pending.sectionTitle}
        style={{ width: 560, maxWidth: '94vw', maxHeight: '88vh', overflow: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 12, boxShadow: 'var(--shadow-3)' }}
      >
        {/* The time it has left, draining along the top. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px 0' }}>
          <div
            role="progressbar"
            aria-label={`Time left for ${pending.sectionTitle}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(left * 100)}
            style={{ flex: 1, height: 4, borderRadius: 999, background: 'var(--bg-raised)', overflow: 'hidden' }}
          >
            <div style={{ height: '100%', width: `${left * 100}%`, borderRadius: 999, background: urgent ? 'var(--danger)' : 'var(--t2)', transition: 'width 1s linear' }} />
          </div>
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: urgent ? 'var(--danger)' : 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
            {seconds > 0 ? `auto-fails in ${clock(seconds)}` : 'timed out'}
          </span>
        </div>

        {/* Where in the cascade it stopped. */}
        <div style={{ padding: '10px 18px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div aria-label="Where in the run" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, fontSize: 11 }}>
            <Crumb tier="var(--t1)">Plan</Crumb>
            <ChevronRight size={11} style={{ color: 'var(--text-dim)' }} />
            <Crumb tier="var(--t2)">{pending.position ? `Section ${pending.position.index} of ${pending.position.of}` : 'Section'}</Crumb>
            <ChevronRight size={11} style={{ color: 'var(--text-dim)' }} />
            <Crumb tier="var(--t3)">Review</Crumb>
            {queued > 1 && <span style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>{queued - 1} more waiting</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--text)', lineHeight: 1.35 }}>{pending.sectionTitle}</span>
            <span style={{ flexShrink: 0, marginTop: 2, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--warn)', border: '1px solid color-mix(in srgb, var(--warn) 40%, transparent)', background: 'color-mix(in srgb, var(--warn) 10%, transparent)', borderRadius: 999, padding: '2px 8px' }}>
              Paused
            </span>
          </div>
          {pending.goal && (
            <button
              type="button"
              onClick={() => setShowGoal((v) => !v)}
              aria-expanded={showGoal}
              style={{
                textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)',
                ...(showGoal ? { whiteSpace: 'pre-wrap' } : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
              }}
            >
              {pending.goal}
            </button>
          )}
        </div>

        {/* What failed, and what it has so far. */}
        <div style={{ margin: '0 18px', display: 'grid', gridTemplateColumns: '72px 1fr', columnGap: 12, rowGap: 10, padding: '10px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg-base)', fontSize: 12 }}>
          {(checks.length > 0 || notes.length > 0) && (
            <>
              <span style={label}>Checks</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {checks.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {checks.map((c) => (
                      <span key={c} style={{ fontSize: 11, fontWeight: 500, color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 12%, transparent)', borderRadius: 6, padding: '2px 7px' }}>✕ {c}</span>
                    ))}
                  </div>
                )}
                {notes.slice(0, 4).map((n, i) => <span key={i} style={{ color: 'var(--text-muted)', lineHeight: 1.45 }}>{n}</span>)}
              </div>
            </>
          )}
          {draft.words > 0 && (
            <>
              <span style={label}>Draft</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: 'var(--text)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{draft.line}</span>
                  <button
                    type="button"
                    onClick={() => setShowDraft((v) => !v)}
                    aria-expanded={showDraft}
                    style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, fontWeight: 500, color: 'var(--t2)' }}
                  >
                    <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{wordCount(draft.words)} ·</span>
                    {showDraft ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {showDraft ? 'Hide' : 'View'}
                  </button>
                </div>
                {showDraft && (
                  <div style={{ maxHeight: 192, overflow: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.5, color: 'var(--text-muted)', background: 'var(--bg-surface)', borderRadius: 6, padding: 8 }}>
                    {pending.summary.trim()}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* The three ways on. */}
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div role="radiogroup" aria-label={`What to do with ${pending.sectionTitle}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
            {CHOICES.map((c) => {
              const on = choice === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setChoice(c.id)}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left', cursor: 'pointer', padding: '10px 12px', borderRadius: 9,
                    border: `1px solid ${on ? 'color-mix(in srgb, var(--t2) 70%, transparent)' : 'var(--border)'}`,
                    background: on ? 'color-mix(in srgb, var(--t2) 12%, transparent)' : 'var(--bg-raised)',
                    boxShadow: on ? '0 0 0 1px color-mix(in srgb, var(--t2) 40%, transparent)' : 'none',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
                      <span style={{ color: on ? 'var(--t2)' : 'var(--text-dim)', display: 'flex' }}>{icon(c.id)}</span>
                      {c.label}
                    </span>
                    <kbd style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px' }}>{c.key}</kbd>
                  </span>
                  <span style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--text-dim)' }}>{c.detail}</span>
                </button>
              );
            })}
          </div>

          {choice === 'guidance' && (
            <textarea
              // Focused as it appears: the next keys typed are the notes, never a shortcut.
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); decide(); }
              }}
              rows={3}
              aria-label={`Notes for ${pending.sectionTitle}`}
              placeholder="What should it do differently? e.g. finish the stylesheet and keep it under one file"
              style={{ width: '100%', boxSizing: 'border-box', resize: 'none', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', padding: '9px 12px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit' }}
            />
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--text-dim)' }}>
              No answer in time fails this section; the rest of the run carries on.
            </span>
            <button
              type="button"
              onClick={decide}
              disabled={!ready}
              style={{
                flexShrink: 0, border: 'none', borderRadius: 7, padding: '8px 14px', fontSize: 12, fontWeight: 650, color: '#fff',
                background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
                opacity: ready ? 1 : 0.45, cursor: ready ? 'pointer' : 'not-allowed',
              }}
            >
              {chosen ? chosen.confirm : 'Choose how to continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One step of the cascade path, with its tier's colour. */
function Crumb({ tier, children }: { tier: string; children: React.ReactNode }): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '2px 8px', background: 'var(--bg-raised)', color: 'var(--text-muted)', fontWeight: 500 }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: tier }} />
      {children}
    </span>
  );
}
