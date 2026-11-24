import { useEffect, useState } from 'react';
import type { WorkspaceStatus } from '../App.js';
import { PRESETS } from '../lib/workspace-tools.js';

/**
 * Settings → Workspaces: let runs on Cascade Cloud work in a folder on this computer.
 * Off until turned on; uses the device paired under Cloud runs. Each run asks which folder.
 */
export function WorkspaceSettingsPanel({ onPair }: { onPair: () => void }) {
  const ws = window.cascade?.workspace;
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ws) return;
    ws.status().then(setStatus, () => setStatus(null));
    ws.onStatus(setStatus);
  }, [ws]);
  if (!ws) return <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not available in this build.</p>;
  const act = async (fn: () => Promise<WorkspaceStatus | { error: string }>) => {
    setBusy(true); setError(null);
    const r = await fn().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    if ('error' in r) setError(r.error); else setStatus(r);
  };
  const on = !!status?.enabled;
  const state = !status ? '' : !status.paired ? 'Not paired' : !on ? 'Off' : status.serving ? 'On: a run is working in a folder now' : status.connected ? 'On: runs can ask' : 'On: connecting…';
  const d = status?.defaults;
  const presetTitle = d?.preset ? PRESETS.find((p) => p.id === d.preset)?.title : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5, color: 'var(--text)' }}>
      <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Let a Cascade Cloud run read and work on files in a folder on this computer while this app is open. Each run asks here first:
        which folder, which tools. Risky actions ask again, a checkpoint lets you undo the run&apos;s changes, and Stop ends its access at once.
        The folder&apos;s location never leaves this computer.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input type="checkbox" role="switch" checked={on} disabled={busy || (!status?.paired && !on)} onChange={(e) => void act(async () => (e.target.checked ? ws.enable() : ws.disable()))} />
        <span style={{ fontWeight: 600 }}>Let Cascade Cloud runs work in a folder on this computer</span>
      </label>
      {status && <p style={{ margin: 0, color: 'var(--text-muted)' }}>{state}{status.name && status.paired ? ` · as “${status.name}”` : ''}</p>}
      {status && !status.paired && (
        <p style={{ margin: 0 }}>
          This app isn&apos;t paired with Cascade Cloud yet.{' '}
          <button type="button" onClick={onPair} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 12.5, textDecoration: 'underline' }}>Pair it under Cloud runs</button>
          {' '}(the same pairing serves both).
        </p>
      )}
      {(error ?? status?.error) && <p role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error ?? status?.error}</p>}
      {d && (d.folder || presetTitle) && (
        <div style={{ color: 'var(--text-muted)' }}>
          <div>Last folder: <span style={{ color: 'var(--text)' }}>{d.folder ?? 'none'}</span>{presetTitle ? ` · ${presetTitle}` : ''}</div>
          <button
            type="button" disabled={busy} onClick={() => void act(ws.clearDefaults)}
            style={{ marginTop: 6, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 11px', fontSize: 12, cursor: 'pointer' }}
          >
            Forget the remembered folder
          </button>
        </div>
      )}
    </div>
  );
}
