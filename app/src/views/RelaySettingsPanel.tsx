import { useEffect, useState } from 'react';
import type { RelayStatus } from '../App.js';

/**
 * Settings → Cloud runs: let runs on Cascade Cloud use this app's browser. Off until
 * turned on; needs a Cascade Cloud sign-in to pair. Each run is still asked about.
 */
export function RelaySettingsPanel() {
  const relay = window.cascade?.relay;
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!relay) return;
    relay.status().then(setStatus, () => setStatus(null));
    relay.onStatus(setStatus);
  }, [relay]);

  if (!relay) return <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not available in this build.</p>;
  const act = async (fn: () => Promise<RelayStatus | { error: string }>) => {
    setBusy(true);
    setError(null);
    const r = await fn().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    if ('error' in r) setError(r.error); else setStatus(r);
  };
  const on = !!status?.enabled;
  const state = !status ? '' : !on ? 'Off' : status.connected ? (status.run ? 'On: a run is using a window now' : 'On: runs can ask') : 'On: connecting…';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5, color: 'var(--text)' }}>
      <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Let runs on Cascade Cloud use a browser in this app while it&apos;s open. Each run asks here first, and opens only the
        sites you name, in a window of its own with an empty profile that&apos;s wiped when it ends.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox" role="switch" checked={on} disabled={busy}
          onChange={(e) => void act(e.target.checked ? relay.enable : relay.disable)}
        />
        <span style={{ fontWeight: 600 }}>Cloud runs can use this app&apos;s browser</span>
      </label>
      {status && <p style={{ margin: 0, color: 'var(--text-muted)' }}>{state}{status.name ? ` · as “${status.name}”` : ''}{status.server ? ` on ${status.server}` : ''}</p>}
      {(error ?? status?.error) && <p role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error ?? status?.error}</p>}
      {status?.paired && (
        <div>
          <button
            type="button" disabled={busy}
            onClick={() => { if (window.confirm('Remove this app as a device? Its key is deleted here and it is removed from your account.')) void act(relay.forget); }}
            style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 12px', fontSize: 12, cursor: 'pointer' }}
          >
            Remove this app as a device
          </button>
        </div>
      )}
    </div>
  );
}
