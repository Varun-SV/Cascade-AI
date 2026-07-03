import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { ShieldAlert, Check, X, Infinity as InfinityIcon } from 'lucide-react';
import { useAppDispatch, useAppSelector, dequeueApproval } from '../store/index.js';

const VERDICT_COLOR: Record<string, string> = {
  approve: 'var(--success)',
  deny: 'var(--danger)',
  unsure: 'var(--text-dim)',
};

/**
 * Blocks a run until the user approves/denies a dangerous tool. A dangerous
 * tool is never auto-approved by a tier — the request escalates to here with
 * an advisory trail from T2/T1. Answers over the socket via `permission:decision`,
 * which resolves the backend's pending approval (see server makeApprovalCallback).
 */
export function ApprovalModal({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  const pending = useAppSelector((s) => s.app.pendingApprovals);
  const req = pending[0];

  const decide = (approved: boolean, always = false) => {
    if (!req) return;
    socket?.emit('permission:decision', { requestId: req.id, approved, always });
    dispatch(dequeueApproval(req.id));
  };

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); decide(true); }
      else if (e.key === 'Escape') { e.preventDefault(); decide(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.id]);

  if (!req) return null;

  const target = req.input ? JSON.stringify(req.input, null, 0) : '';

  const btn = (bg: string, color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 12.5,
    borderRadius: 7, cursor: 'pointer', border: 'none', background: bg, color, fontWeight: 600,
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 440, maxWidth: '92vw', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 12, boxShadow: 'var(--shadow-3)', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
          <ShieldAlert size={18} style={{ color: 'var(--warn)', flexShrink: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Approval needed</span>
          {pending.length > 1 && (
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-dim)' }}>+{pending.length - 1} more queued</span>
          )}
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
          {req.requestedBy ? <b style={{ color: 'var(--text)' }}>{req.requestedBy}</b> : 'A worker'} wants to run{' '}
          <code style={{ background: 'var(--bg-base)', padding: '1px 6px', borderRadius: 4, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{req.toolName}</code>
          {req.subtaskContext ? <> for “{req.subtaskContext}”.</> : '.'}
        </div>

        {target && (
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', marginBottom: 10, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {target}
          </div>
        )}

        {req.trail && req.trail.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 4 }}>Escalation trail</div>
            {req.trail.map((t, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>
                <b style={{ color: 'var(--text)' }}>{t.tier}</b>
                <span style={{ color: VERDICT_COLOR[t.verdict] ?? 'var(--text-dim)', textTransform: 'capitalize', flexShrink: 0 }}>{t.verdict}</span>
                {t.reason && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {t.reason}</span>}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button style={btn('var(--bg-raised)', 'var(--danger)')} onClick={() => decide(false)} title="Esc">
            <X size={14} /> Deny
          </button>
          <button style={btn('var(--bg-raised)', 'var(--text)')} onClick={() => decide(true, true)} title="Approve and don't ask again for this tool">
            <InfinityIcon size={14} /> Always
          </button>
          <button style={btn('linear-gradient(135deg, var(--accent), var(--accent-2))', '#fff')} onClick={() => decide(true)} title="Enter">
            <Check size={14} /> Approve
          </button>
        </div>
      </div>
    </div>
  );
}
