import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, ArrowRight, Loader2, RefreshCw, Send, Download, Globe, X } from 'lucide-react';
import { useAppDispatch, useAppSelector, setShowContinue } from '../store/index.js';
import { fetchSessionTranscript } from '../utils/sessionLoad.js';
import { createCloudHandoff, fetchCloudHandoff } from '../lib/cloudHandoff.js';

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * "Open-and-continue" handoff between the desktop app and the web app. Send
 * tab: snapshot the active session into a short code to pick up on the web.
 * Receive tab: enter a code from the web to import that chat here (via the
 * local backend's cascade-export bundle import) and keep going.
 */
export function ContinueModal() {
  const dispatch = useAppDispatch();
  const { showContinue, activeSessionId, sessionId, sessions, backendPort, authToken } = useAppSelector((s) => s.app);

  const currentId = activeSessionId ?? sessionId;
  const currentSession = sessions.find((s) => s.sessionId === currentId);
  const [tab, setTab] = useState<'send' | 'receive'>(currentId ? 'send' : 'receive');

  const close = useCallback(() => dispatch(setShowContinue(false)), [dispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  if (!showContinue) return null;

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '7px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', borderRadius: 6,
    border: 'none', background: active ? 'var(--bg-raised)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-muted)',
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={close}
    >
      <div
        style={{ width: 380, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: 'var(--shadow-3)', padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Continue elsewhere</span>
          <button onClick={close} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex' }}>
            <X size={15} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 8, background: 'var(--bg-base)', border: '1px solid var(--border)', marginBottom: 14 }}>
          <button style={tabStyle(tab === 'send')} onClick={() => setTab('send')}><Send size={12} /> Send this chat</button>
          <button style={tabStyle(tab === 'receive')} onClick={() => setTab('receive')}><Download size={12} /> Bring a chat here</button>
        </div>

        {tab === 'send'
          ? <SendTab sessionTitle={currentSession?.title ?? null} sessionId={currentId} backendPort={backendPort} authToken={authToken} />
          : <ReceiveTab backendPort={backendPort} authToken={authToken} onDone={close} />}
      </div>
    </div>
  );
}

function SendTab({ sessionTitle, sessionId, backendPort, authToken }: {
  sessionTitle: string | null;
  sessionId: string | null;
  backendPort: number;
  authToken: string;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useCallback(async () => {
    if (!sessionId) { setError('Open a session first, then send it.'); return; }
    setBusy(true);
    setError(null);
    try {
      const transcript = await fetchSessionTranscript(backendPort, authToken, sessionId);
      const messages = (transcript ?? [])
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));
      if (messages.length === 0) { setError('This session has no messages to send yet.'); return; }
      const res = await createCloudHandoff({ title: sessionTitle, skillId: null, messages });
      setCode(res.code);
      setExpiresAt(res.expiresAt);
      setRemaining(res.expiresAt - Date.now()); // seed so the first render isn't a false "expired"
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a code.');
    } finally {
      setBusy(false);
    }
  }, [sessionId, sessionTitle, backendPort, authToken]);

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setRemaining(expiresAt - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const expired = !!code && remaining <= 0;

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — code is still visible */ }
  }

  const primaryBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
    padding: '9px 12px', fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
    background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: '#fff', border: 'none',
  };

  if (!sessionId) {
    return (
      <p style={{ padding: '20px 12px', textAlign: 'center', fontSize: 11.5, color: 'var(--text-dim)', border: '1px dashed var(--border)', borderRadius: 8 }}>
        Open a session from the sidebar first, then come back here to continue it on the web.
      </p>
    );
  }

  if (!code) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>
          Get a one-time code to pick this chat up in Cascade on the web. The transcript is held briefly to transfer it, then discarded.
        </p>
        {error && <p style={{ fontSize: 11.5, color: 'var(--danger)' }}>{error}</p>}
        <button style={{ ...primaryBtn, opacity: busy ? 0.5 : 1 }} onClick={create} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />} Create a code
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '18px 12px', borderRadius: 10, background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
        <button onClick={copy} title="Copy code" style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 'none', cursor: 'pointer' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700, letterSpacing: '0.18em', color: expired ? 'var(--text-dim)' : 'var(--text)', textDecoration: expired ? 'line-through' : 'none' }}>
            {code}
          </span>
          {copied ? <Check size={16} style={{ color: 'var(--success)' }} /> : <Copy size={16} style={{ color: 'var(--text-dim)' }} />}
        </button>
        {expired
          ? <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)' }}>Code expired — create a new one.</span>
          : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>expires in {formatRemaining(remaining)}</span>}
      </div>

      <ol style={{ display: 'flex', flexDirection: 'column', gap: 5, margin: 0, padding: 0, listStyle: 'none', fontSize: 11.5, color: 'var(--text-muted)' }}>
        <li style={{ display: 'flex', gap: 8 }}><Globe size={13} style={{ marginTop: 1, flexShrink: 0, color: 'var(--text-dim)' }} /> Open Cascade on the web and sign in.</li>
        <li style={{ display: 'flex', gap: 8 }}><span style={{ width: 13, flexShrink: 0 }} /> Go to <b style={{ color: 'var(--text)' }}>Continue elsewhere → Bring a chat here</b>.</li>
        <li style={{ display: 'flex', gap: 8 }}><span style={{ width: 13, flexShrink: 0 }} /> Enter this code to keep going.</li>
      </ol>

      <button
        onClick={create}
        disabled={busy}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '7px 10px', fontSize: 11.5, fontWeight: 500, borderRadius: 7, cursor: 'pointer', background: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border)', opacity: busy ? 0.5 : 1 }}
      >
        {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} New code
      </button>
    </div>
  );
}

function ReceiveTab({ backendPort, authToken, onDone }: { backendPort: number; authToken: string; onDone: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function redeem() {
    const code = value.trim();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const snap = await fetchCloudHandoff(code);
      const now = new Date().toISOString();
      const bundle = {
        format: 'cascade-export@1',
        sessions: [{
          title: snap.title || 'Continued chat',
          messages: snap.messages.map((m) => ({ role: m.role, content: m.content, timestamp: now })),
        }],
      };
      const res = await fetch(`http://localhost:${backendPort}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(bundle),
      });
      if (!res.ok) throw new Error('Import failed — is the local backend running?');
      setImported(snap.title || 'Continued chat');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code is invalid or has expired.');
    } finally {
      setBusy(false);
    }
  }

  const primaryBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
    padding: '9px 12px', fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
    background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: '#fff', border: 'none',
  };

  if (imported) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: '8px 0' }}>
        <Check size={26} style={{ color: 'var(--success)' }} />
        <p style={{ fontSize: 12, color: 'var(--text)', textAlign: 'center', lineHeight: 1.5 }}>
          Imported <b>{imported}</b>. It’s in your sidebar as <b>“{imported} (imported)”</b> — open it to continue.
        </p>
        <button style={primaryBtn} onClick={onDone}>Done</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>
        Enter a code from the web to bring that chat here as a new session you can continue.
      </p>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void redeem(); } }}
        placeholder="XXXX-XXXX"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        style={{ width: '100%', boxSizing: 'border-box', textAlign: 'center', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', fontSize: 17, letterSpacing: '0.18em', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', padding: '10px', outline: 'none' }}
      />
      {error && <p style={{ fontSize: 11.5, color: 'var(--danger)' }}>{error}</p>}
      <button style={{ ...primaryBtn, opacity: busy || !value.trim() ? 0.5 : 1 }} onClick={redeem} disabled={busy || !value.trim()}>
        {busy ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />} Continue this chat
      </button>
    </div>
  );
}
