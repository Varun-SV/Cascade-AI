import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { AlertTriangle, RefreshCw, SkipForward, Send } from 'lucide-react';
import { useAppDispatch, useAppSelector, dequeueEscalation } from '../store/index.js';

/**
 * A section stopped and asked a question.
 *
 * This is the reported bug: the Cockpit showed "Section escalated — needs a
 * decision" and then nothing happened, because nothing ever asked for the
 * decision. The run is parked inside the SDK while this is open.
 *
 * The countdown is shown because the wait is bounded, and — unlike the
 * boardroom gate, which auto-approves — an unanswered escalation FAILS the
 * section. Hiding that deadline would make the failure look arbitrary when it
 * arrives.
 */
export function EscalationModal({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  // The head of the queue. Sections in a wave escalate concurrently, so more
  // than one can be waiting; answering reveals the next rather than losing it.
  const pending = useAppSelector((s) => s.app.pendingEscalations[0] ?? null);
  const queued = useAppSelector((s) => s.app.pendingEscalations.length);
  const [note, setNote] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // Reset the note when a different section escalates (a run can escalate more
  // than once, and carrying guidance across sections would be wrong).
  useEffect(() => { setNote(''); }, [pending?.sectionId, pending?.taskId]);

  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pending?.sectionId, pending?.taskId, pending]);

  // Close at the local deadline instead of only relabelling. `escalation:timeout`
  // is not replayed on reconnect, so a socket that dropped at the wrong moment
  // left this full-screen modal up forever with three live buttons, every one of
  // them answering a request the server had already abandoned.
  const expired = !!pending && Date.now() - pending.receivedAt >= pending.timeoutMs;
  useEffect(() => {
    if (expired && pending) dispatch(dequeueEscalation(pending));
  }, [expired, dispatch, pending]);

  if (!pending || expired) return null;

  // Counting from receivedAt rather than mount keeps the deadline honest if the
  // user switches views and comes back.
  const remaining = pending.timeoutMs - (now - pending.receivedAt);
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  const urgent = seconds <= 60;

  const decide = (action: 'retry' | 'skip' | 'guidance', text?: string) => {
    socket?.emit('escalation:decide', {
      sessionId: pending.sessionId,
      requestId: pending.requestId,
      action,
      note: text,
    });
    dispatch(dequeueEscalation(pending));
  };

  const btn = (bg: string, color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 12.5,
    borderRadius: 7, cursor: 'pointer', border: 'none', background: bg, color, fontWeight: 600,
  });

  return (
    // zIndex 600: strictly above the command palette and Help panel (both
    // 500). The run is PARKED waiting on this decision — if either of those
    // can cover it, the user has no way to see the buttons and answer, and
    // the section fails on the escalation timeout with nothing having ever
    // appeared to go wrong.
    <div style={{ position: 'fixed', inset: 0, zIndex: 600, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 520, maxWidth: '94vw', maxHeight: '86vh', overflow: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 12, boxShadow: 'var(--shadow-3)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
          <AlertTriangle size={18} style={{ color: 'var(--warn)', flexShrink: 0 }} />
          <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>A section needs your decision</span>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{pending.sectionTitle}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          A worker in this section couldn&apos;t decide something on its own. The run is paused here.
        </div>

        {pending.issues.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 5 }}>What it hit</div>
            <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {pending.issues.slice(0, 6).map((issue, i) => (
                <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>· {issue}</div>
              ))}
            </div>
          </div>
        )}

        {pending.summary && (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {pending.summary}
          </div>
        )}

        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>
          Optional — tell it what to do differently, then choose &ldquo;Retry with guidance&rdquo;.
        </div>
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && note.trim()) {
              e.preventDefault();
              decide('guidance', note.trim());
            }
          }}
          rows={3}
          placeholder="e.g. skip the private repos and only summarise the public ones"
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'none', background: 'var(--bg-base)',
            border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)',
            padding: '8px 11px', fontSize: 12.5, outline: 'none', marginBottom: 12, fontFamily: 'inherit',
          }}
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
          <button style={btn('var(--bg-raised)', 'var(--text-muted)')} onClick={() => decide('skip')} title="Keep whatever this section produced and move on">
            <SkipForward size={14} /> Skip this section
          </button>
          <button style={btn('var(--bg-raised)', 'var(--text)')} onClick={() => decide('retry')} title="Run the section again unchanged">
            <RefreshCw size={14} /> Retry as-is
          </button>
          <button
            style={{ ...btn('linear-gradient(135deg, var(--accent), var(--accent-2))', '#fff'), opacity: note.trim() ? 1 : 0.5 }}
            disabled={!note.trim()}
            onClick={() => decide('guidance', note.trim())}
          >
            <Send size={14} /> Retry with guidance
          </button>
        </div>

        <div style={{ fontSize: 11, color: urgent ? 'var(--danger)' : 'var(--text-dim)' }}>
          Waiting {mm}:{ss} — if nobody answers, this section fails and the rest of the run continues.
        </div>
      </div>
    </div>
  );
}
