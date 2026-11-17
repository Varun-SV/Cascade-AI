import { useEffect, useState } from 'react';
import type { RelayStatus } from '../App.js';

/**
 * While a cloud run uses this app's browser: Take over pauses it so the user can use
 * its window themselves (to sign in, say); Hand back lets it carry on from there.
 */
export function RelayRunBanner() {
  const relay = window.cascade?.relay;
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!relay) return;
    relay.status().then(setStatus, () => setStatus(null));
    relay.onStatus((s) => { setStatus(s); if (!s.run) setError(null); });
  }, [relay]);

  if (!relay || !status?.run) return null;
  const act = async (fn: () => Promise<{ ok: true } | { error: string }>) => {
    const r = await fn().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setError('error' in r ? r.error : null);
  };

  return (
    <div
      role="status"
      style={{
        position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 250,
        display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', maxWidth: 'calc(100vw - 32px)',
        background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: 'var(--shadow-3)',
        fontSize: 12, color: 'var(--text)',
      }}
    >
      <span>
        {status.takenOver
          ? 'The cloud run is paused: its window is yours until you hand it back.'
          : 'A cloud run is using a Cascade run window. Close that window to end it.'}
      </span>
      {error && <span role="alert" style={{ color: 'var(--danger)' }}>{error}</span>}
      <button
        type="button"
        onClick={() => void act(status.takenOver ? relay.handBack : relay.takeOver)}
        style={{ flexShrink: 0, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
      >
        {status.takenOver ? 'Hand back' : 'Take over'}
      </button>
    </div>
  );
}
