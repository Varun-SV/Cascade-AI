import { useEffect, useState } from 'react';
import { RefreshCw, Download, RotateCw, CheckCircle2 } from 'lucide-react';

type Status = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

// Self-update panel: shows the current version, a manual "Check for Updates"
// button, live download progress, and a "Restart & Install" action. Background
// auto-update still runs on launch (main process); this gives the user control.
export function UpdatesPanel() {
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [latest, setLatest] = useState<string | undefined>();
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState('');

  useEffect(() => {
    window.cascade?.updates?.getVersion().then(setVersion).catch(() => { /* dev */ });
    window.cascade?.updates?.onStatus((s) => {
      setStatus(s.status as Status);
      if (s.version) setLatest(s.version);
      if (typeof s.percent === 'number') setPercent(s.percent);
      if (s.message) setMessage(s.message);
    });
  }, []);

  const check = async () => {
    setMessage('');
    setStatus('checking');
    const res = await window.cascade?.updates?.check();
    if (!res) { setStatus('error'); setMessage('Updater unavailable (development build).'); return; }
    if (!res.ok) {
      setStatus('error');
      setMessage(res.error === 'updater-unavailable' ? 'Updates are only available in the installed app.' : res.error ?? 'Check failed.');
    }
    // Otherwise the 'update:status' events drive the UI.
  };

  const install = () => window.cascade?.updates?.install();

  const label =
    status === 'checking' ? 'Checking for updates…'
    : status === 'available' ? `Update ${latest ?? ''} available — downloading…`
    : status === 'downloading' ? `Downloading update… ${percent}%`
    : status === 'downloaded' ? `Update ${latest ?? ''} ready to install`
    : status === 'not-available' ? "You're on the latest version."
    : status === 'error' ? (message || 'Update check failed.')
    : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Current version</div>
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
          {version ? `v${version}` : '—'}
        </div>
      </div>

      {label && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
          color: status === 'error' ? 'var(--danger)' : status === 'not-available' || status === 'downloaded' ? 'var(--success)' : 'var(--text-muted)',
        }}>
          {status === 'not-available' && <CheckCircle2 size={14} />}
          {label}
        </div>
      )}

      {status === 'downloading' && (
        <div style={{ height: 4, borderRadius: 4, background: 'var(--bg-raised)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${percent}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))', transition: 'width 0.2s linear' }} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {status === 'downloaded' ? (
          <button onClick={install} style={primaryBtn}>
            <RotateCw size={14} /> Restart &amp; Install
          </button>
        ) : (
          <button onClick={check} disabled={status === 'checking' || status === 'downloading'} style={{
            ...primaryBtn,
            opacity: status === 'checking' || status === 'downloading' ? 0.6 : 1,
            cursor: status === 'checking' || status === 'downloading' ? 'default' : 'pointer',
          }}>
            {status === 'downloading' ? <Download size={14} /> : <RefreshCw size={14} />} Check for Updates
          </button>
        )}
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
        Cascade checks for updates automatically on launch and downloads them in the
        background. Installed updates apply the next time you restart.
      </p>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
  border: 'none', borderRadius: 'var(--radius-md)', color: '#fff', fontWeight: 600,
  padding: '8px 16px', fontSize: 12, cursor: 'pointer', boxShadow: 'var(--shadow-1)',
};
