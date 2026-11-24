import { useEffect, useState } from 'react';
import type { WorkspaceStatus } from '../App.js';

/**
 * Always visible while a cloud run is working in a folder here: its label and Stop,
 * which ends its access at once. Afterwards, Undo puts the folder back as it was.
 */
export function WorkspaceServingBanner() {
  const ws = window.cascade?.workspace;
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ws) return;
    ws.status().then(setStatus, () => setStatus(null));
    ws.onStatus(setStatus);
  }, [ws]);
  if (!ws || !status) return null;
  const { serving, lastRun } = status;
  if (!serving && !lastRun) return null;

  const box: React.CSSProperties = {
    position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 260, display: 'flex', alignItems: 'center', gap: 12,
    padding: '9px 12px', maxWidth: 'calc(100vw - 32px)', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 10,
    boxShadow: 'var(--shadow-3)', fontSize: 12, color: 'var(--text)',
  };
  const small = (primary: boolean): React.CSSProperties => ({
    flexShrink: 0, borderRadius: 6, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
    background: primary ? 'var(--danger, #e5484d)' : 'var(--bg-raised)', color: primary ? '#fff' : 'var(--text)', border: primary ? 'none' : '1px solid var(--border)',
  });

  if (serving) {
    return (
      <div role="status" style={box}>
        <span><strong>Serving a Cloud run</strong> · {serving.label}{serving.allowAll ? ' · everything allowed' : ''}</span>
        {message && <span role="alert" style={{ color: 'var(--danger)' }}>{message}</span>}
        <button type="button" style={small(true)} onClick={() => void ws.stop().then((r) => setMessage('error' in r ? r.error : null))}>Stop</button>
      </div>
    );
  }
  const run = lastRun!;
  const undo = async () => {
    setBusy(true);
    const r = await ws.undo().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    setMessage('error' in r ? r.error : `Put back: ${r.restored} restored, ${r.removed} removed${r.skipped ? `, ${r.skipped} left (changed since)` : ''}.`);
  };
  return (
    <div role="status" style={box}>
      <span>
        {run.label} finished{run.changed ? ` · ${run.changed} file${run.changed === 1 ? '' : 's'} changed` : ''}
        {run.undone ? ' · undone' : run.note ? ` · ${run.note}` : ''}
      </span>
      {message && <span role="alert">{message}</span>}
      {run.canUndo && <button type="button" disabled={busy} style={small(false)} onClick={() => void undo()}>Undo this run&apos;s changes</button>}
      <button type="button" style={small(false)} onClick={() => { setMessage(null); void ws.dismissLast(); }}>Dismiss</button>
    </div>
  );
}
