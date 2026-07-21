import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Copy, Check, ArrowRight, Loader2, RefreshCw, Send, Download, Globe, X,
  Cloud, LogOut, Github, MessageSquare, ShieldCheck, ChevronRight, ChevronLeft, Trash2,
  UploadCloud, DownloadCloud, KeyRound,
} from 'lucide-react';
import { useAppDispatch, useAppSelector, setShowContinue } from '../store/index.js';
import type { CloudUser, CloudMsg } from '../App.js';
import { fetchSessionTranscript } from '../utils/sessionLoad.js';
import { createCloudHandoff, fetchCloudHandoff } from '../lib/cloudHandoff.js';

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface ImportMessage { role: string; content: string }

/**
 * Import a transcript into the local backend as a new session the user can keep
 * going. Shared by the code-based handoff (Receive) and signed-in cloud chats.
 */
async function importTranscript(
  backendPort: number, authToken: string, title: string, messages: ImportMessage[],
): Promise<void> {
  const now = new Date().toISOString();
  const bundle = {
    format: 'cascade-export@1',
    sessions: [{ title, messages: messages.map((m) => ({ role: m.role, content: m.content, timestamp: now })) }],
  };
  const res = await fetch(`http://localhost:${backendPort}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) throw new Error('Import failed — is the local backend running?');
}

type CloudAccount =
  | { state: 'unsupported' }
  | { state: 'loading' }
  | { state: 'signedOut'; serverUrl: string }
  | { state: 'signedIn'; user: CloudUser | null; serverUrl: string; storage: 'keychain' | 'encrypted-file' };

type Tab = 'send' | 'receive' | 'cloud';

const primaryBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
  padding: '9px 12px', fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
  background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: '#fff', border: 'none',
};

/**
 * "Continue elsewhere" — the desktop's cloud bridge. A signed-in account header
 * (optional Cascade Cloud login via loopback OAuth) sits above three tabs:
 * Send this chat (mint a one-time code), Bring a chat here (redeem a code), and
 * Your cloud chats (browse + continue the chats you started on the web).
 */
export function ContinueModal() {
  const dispatch = useAppDispatch();
  const { showContinue, activeSessionId, sessionId, sessions, backendPort, authToken } = useAppSelector((s) => s.app);

  const currentId = activeSessionId ?? sessionId;
  const currentSession = sessions.find((s) => s.sessionId === currentId);
  const [tab, setTab] = useState<Tab>(currentId ? 'send' : 'receive');
  const [account, setAccount] = useState<CloudAccount>({ state: 'loading' });

  const close = useCallback(() => dispatch(setShowContinue(false)), [dispatch]);

  const refreshAccount = useCallback(async () => {
    const api = window.cascade?.cloud;
    if (!api) { setAccount({ state: 'unsupported' }); return; }
    try {
      const s = await api.status();
      setAccount(s.signedIn
        ? { state: 'signedIn', user: s.user, serverUrl: s.serverUrl, storage: s.storage }
        : { state: 'signedOut', serverUrl: s.serverUrl });
    } catch {
      setAccount({ state: 'unsupported' });
    }
  }, []);

  useEffect(() => { if (showContinue) void refreshAccount(); }, [showContinue, refreshAccount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  if (!showContinue) return null;

  const signedIn = account.state === 'signedIn';
  const tabStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '7px 8px', fontSize: 11.5, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: 6,
    border: 'none', background: active ? 'var(--bg-raised)' : 'transparent',
    color: disabled ? 'var(--text-dim)' : active ? 'var(--text)' : 'var(--text-muted)', opacity: disabled ? 0.5 : 1,
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={close}
    >
      <div
        style={{ width: 400, maxHeight: '86vh', overflowY: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 10, boxShadow: 'var(--shadow-3)', padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Continue elsewhere</span>
          <button onClick={close} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex' }}>
            <X size={15} />
          </button>
        </div>

        <AccountHeader account={account} onChange={refreshAccount} onSignedIn={() => setTab('cloud')} />

        <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 8, background: 'var(--bg-base)', border: '1px solid var(--border)', marginBottom: 14 }}>
          <button style={tabStyle(tab === 'send')} onClick={() => setTab('send')}><Send size={12} /> Send</button>
          <button style={tabStyle(tab === 'receive')} onClick={() => setTab('receive')}><Download size={12} /> Receive</button>
          <button
            style={tabStyle(tab === 'cloud', !signedIn)}
            onClick={() => { if (signedIn) setTab('cloud'); }}
            disabled={!signedIn}
            title={signedIn ? 'Your cloud chats' : 'Sign in to browse your cloud chats'}
          >
            <Cloud size={12} /> Cloud chats
          </button>
        </div>

        {tab === 'send' && <SendTab sessionTitle={currentSession?.title ?? null} sessionId={currentId} backendPort={backendPort} authToken={authToken} />}
        {tab === 'receive' && <ReceiveTab backendPort={backendPort} authToken={authToken} onDone={close} />}
        {tab === 'cloud' && <CloudChatsTab signedIn={signedIn} backendPort={backendPort} authToken={authToken} onDone={close} />}
      </div>
    </div>
  );
}

// ── Account header (optional Cascade Cloud sign-in) ──

function AccountHeader({ account, onChange, onSignedIn }: {
  account: CloudAccount;
  onChange: () => Promise<void>;
  onSignedIn: () => void;
}) {
  const [busy, setBusy] = useState<null | 'google' | 'github'>(null);
  const [error, setError] = useState<string | null>(null);

  if (account.state === 'unsupported') return null; // renderer without the cloud bridge (e.g. plain browser)

  const wrap: React.CSSProperties = { padding: '11px 12px', borderRadius: 9, background: 'var(--bg-raised)', border: '1px solid var(--border)', marginBottom: 12 };

  if (account.state === 'loading') {
    return <div style={{ ...wrap, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', fontSize: 11.5 }}><Loader2 size={13} className="spin" /> Checking your account…</div>;
  }

  async function signIn(provider: 'google' | 'github') {
    const api = window.cascade?.cloud;
    if (!api) return;
    setBusy(provider);
    setError(null);
    try {
      const r = await api.login(provider);
      if (!r.ok) { setError(r.error || 'Sign-in failed.'); return; }
      await onChange();
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    const api = window.cascade?.cloud;
    if (!api) return;
    await api.logout();
    await onChange();
  }

  if (account.state === 'signedIn') {
    const u = account.user;
    const label = u?.name || u?.email || 'Signed in';
    const initial = (u?.name || u?.email || '?').trim().charAt(0).toUpperCase();
    return (
      <div style={{ ...wrap, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' }}>{initial}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}{u?.plan ? <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}> · {u.plan}</span> : null}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-dim)' }}>
              <ShieldCheck size={10} /> {account.storage === 'keychain' ? 'Secured by your OS keychain' : 'Encrypted on this device'}
            </div>
          </div>
          <button onClick={signOut} title="Sign out" style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 11, fontWeight: 500, padding: '5px 8px', cursor: 'pointer' }}>
            <LogOut size={12} /> Sign out
          </button>
        </div>
        <SyncBlock />
      </div>
    );
  }

  // Signed out
  const oauthBtn: React.CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '8px 10px', fontSize: 11.5, fontWeight: 600, borderRadius: 7, cursor: 'pointer', background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border-strong)' };
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
        <Cloud size={13} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Sign in to Cascade Cloud</span>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)' }}>
        Optional — browse and continue the chats you started on the web. Your keys and local work stay on this machine.
      </p>
      {error && <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--danger)' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={{ ...oauthBtn, opacity: busy ? 0.6 : 1 }} onClick={() => signIn('google')} disabled={!!busy}>
          {busy === 'google' ? <Loader2 size={13} className="spin" /> : <Globe size={13} />} Google
        </button>
        <button style={{ ...oauthBtn, opacity: busy ? 0.6 : 1 }} onClick={() => signIn('github')} disabled={!!busy}>
          {busy === 'github' ? <Loader2 size={13} className="spin" /> : <Github size={13} />} GitHub
        </button>
      </div>
      {busy && <p style={{ margin: '8px 0 0', fontSize: 10.5, color: 'var(--text-dim)' }}>Finish signing in in the browser tab that just opened…</p>}
    </div>
  );
}

// ── Key sync (signed-in) — push/pull encrypted settings ──

function SyncBlock() {
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState<null | 'push' | 'pull'>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (!window.cascade?.cloud?.syncPush) return null; // older preload — feature absent

  async function run(kind: 'push' | 'pull') {
    const api = window.cascade?.cloud;
    if (!api?.syncPush || !api.syncPull) return;
    if (!pass) { setStatus('Enter a passphrase first.'); return; }
    setBusy(kind);
    setStatus(null);
    try {
      const r = kind === 'push' ? await api.syncPush(pass) : await api.syncPull(pass);
      if (!r.ok) { setStatus(r.error || 'Sync failed.'); return; }
      if (kind === 'push') setStatus(`Synced to your account${'version' in r && r.version ? ` (v${r.version})` : ''}.`);
      else setStatus('empty' in r && r.empty ? 'Nothing synced to your account yet.' : 'Applied your synced settings here.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, padding: 0 }}>
        <RefreshCw size={12} /> Sync your keys &amp; settings across devices
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--text-dim)' }}>
        <KeyRound size={11} /> Encrypted with a passphrase only you know — we store only ciphertext.
      </div>
      <input
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        placeholder="Passphrase"
        style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 9px', fontSize: 12, outline: 'none' }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => run('push')} disabled={!!busy} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 10px', fontSize: 11.5, fontWeight: 600, borderRadius: 7, cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: '#fff', border: 'none', opacity: busy ? 0.6 : 1 }}>
          {busy === 'push' ? <Loader2 size={13} className="spin" /> : <UploadCloud size={13} />} Push
        </button>
        <button onClick={() => run('pull')} disabled={!!busy} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 10px', fontSize: 11.5, fontWeight: 500, borderRadius: 7, cursor: 'pointer', background: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border)', opacity: busy ? 0.6 : 1 }}>
          {busy === 'pull' ? <Loader2 size={13} className="spin" /> : <DownloadCloud size={13} />} Pull
        </button>
      </div>
      {status && <p style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)' }}>{status}</p>}
    </div>
  );
}

// ── Your cloud chats (signed-in) ──

function CloudChatsTab({ signedIn, backendPort, authToken, onDone }: {
  signedIn: boolean;
  backendPort: number;
  authToken: string;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [convos, setConvos] = useState<Array<{ id: string; title: string }>>([]);
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);

  const load = useCallback(async () => {
    const api = window.cascade?.cloud;
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.sessions();
      if (!r.ok) { setError(r.error || 'Could not load your cloud chats.'); return; }
      setConvos(r.conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your cloud chats.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (signedIn) void load(); }, [signedIn, load]);

  if (!signedIn) {
    return (
      <p style={{ padding: '20px 12px', textAlign: 'center', fontSize: 11.5, color: 'var(--text-dim)', border: '1px dashed var(--border)', borderRadius: 8 }}>
        Sign in above to browse the chats you started on the web.
      </p>
    );
  }

  if (open) {
    return (
      <CloudChatViewer
        conversation={open}
        backendPort={backendPort}
        authToken={authToken}
        onBack={() => { setOpen(null); void load(); }}
        onImported={onDone}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <p style={{ flex: 1, margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>
          Your shared cloud chats — the same ones on web + CLI. Open one to read it, navigate its branches, or bring it here to continue.
        </p>
        <button onClick={load} disabled={loading} title="Refresh" style={{ display: 'flex', background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: 5, cursor: 'pointer', opacity: loading ? 0.5 : 1 }}>
          <RefreshCw size={12} className={loading ? 'spin' : undefined} />
        </button>
      </div>

      {error && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--danger)' }}>{error}</p>}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '24px 0', color: 'var(--text-dim)', fontSize: 11.5 }}>
          <Loader2 size={14} className="spin" /> Loading your cloud chats…
        </div>
      ) : convos.length === 0 ? (
        <p style={{ padding: '20px 12px', textAlign: 'center', fontSize: 11.5, color: 'var(--text-dim)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          No cloud chats yet. Start one on the web, desktop, or CLI and it’ll show up here.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 300, overflowY: 'auto' }}>
          {convos.map((c) => (
            <button
              key={c.id}
              onClick={() => setOpen(c)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '9px 10px', borderRadius: 7, cursor: 'pointer', background: 'var(--bg-raised)', border: '1px solid var(--border)', color: 'var(--text)' }}
            >
              <MessageSquare size={13} style={{ flexShrink: 0, color: 'var(--text-dim)' }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.title?.trim() || 'Untitled chat'}
              </span>
              <ChevronRight size={14} style={{ color: 'var(--text-dim)' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Cloud chat viewer — read the active path, navigate branches (‹ i/n ›),
//    delete a message + its subtree, or bring the chat here to continue. ──

function CloudChatViewer({ conversation, backendPort, authToken, onBack, onImported }: {
  conversation: { id: string; title: string };
  backendPort: number;
  authToken: string;
  onBack: () => void;
  onImported: () => void;
}) {
  const [msgs, setMsgs] = useState<CloudMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  const load = useCallback(async () => {
    const api = window.cascade?.cloud;
    if (!api) return;
    setLoading(true); setError(null);
    try {
      const r = await api.messages(conversation.id);
      if (!r.ok) { setError(r.error || 'Could not load that chat.'); return; }
      setMsgs(r.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that chat.');
    } finally { setLoading(false); }
  }, [conversation.id]);

  useEffect(() => { void load(); }, [load]);

  async function switchBranch(messageId: string) {
    const api = window.cascade?.cloud;
    if (!api || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api.selectBranch(conversation.id, messageId);
      if (!r.ok) { setError(r.error || 'Could not switch branch.'); return; }
      setMsgs(r.messages);
    } finally { setBusy(false); }
  }

  async function removeMessage(messageId: string) {
    const api = window.cascade?.cloud;
    if (!api || busy) return;
    if (!window.confirm('Delete this message and everything below it? This can’t be undone.')) return;
    setBusy(true); setError(null);
    try {
      const r = await api.deleteMessage(conversation.id, messageId);
      if (!r.ok) { setError(r.error || 'Could not delete that message.'); return; }
      setMsgs(r.messages);
    } finally { setBusy(false); }
  }

  async function bringHere() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const messages = msgs.filter((m) => m.content.trim()).map((m) => ({ role: m.role, content: m.content }));
      if (messages.length === 0) throw new Error('That chat has no messages yet.');
      await importTranscript(backendPort, authToken, conversation.title?.trim() || 'Cloud chat', messages);
      setImported(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not bring that chat here.');
    } finally { setBusy(false); }
  }

  if (imported) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: '8px 0' }}>
        <Check size={26} style={{ color: 'var(--success)' }} />
        <p style={{ fontSize: 12, color: 'var(--text)', textAlign: 'center', lineHeight: 1.5 }}>
          Imported into your sidebar as <b>“{conversation.title?.trim() || 'Cloud chat'} (imported)”</b> — open it to continue.
        </p>
        <button style={primaryBtn} onClick={onImported}>Done</button>
      </div>
    );
  }

  const iconBtn: React.CSSProperties = { display: 'flex', background: 'none', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-muted)', padding: 3, cursor: 'pointer' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onBack} title="Back" style={iconBtn}><ChevronLeft size={14} /></button>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {conversation.title?.trim() || 'Untitled chat'}
        </span>
        <button onClick={load} disabled={loading || busy} title="Refresh" style={{ ...iconBtn, opacity: loading || busy ? 0.5 : 1 }}>
          <RefreshCw size={12} className={loading ? 'spin' : undefined} />
        </button>
      </div>

      {error && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--danger)' }}>{error}</p>}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '24px 0', color: 'var(--text-dim)', fontSize: 11.5 }}>
          <Loader2 size={14} className="spin" /> Loading…
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
          {msgs.map((m, idx) => {
            const sibs = m.siblingIds ?? [];
            const pos = m.id ? sibs.indexOf(m.id) : -1;
            const hasBranches = sibs.length > 1 && pos >= 0;
            return (
              <div key={m.id ?? idx} style={{ borderRadius: 7, background: 'var(--bg-raised)', border: '1px solid var(--border)', padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', color: m.role === 'user' ? 'var(--accent)' : 'var(--text-muted)' }}>
                    {m.role === 'user' ? 'YOU' : 'CASCADE'}
                  </span>
                  {hasBranches && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10.5, color: 'var(--text-dim)' }}>
                      <button onClick={() => sibs[pos - 1] && switchBranch(sibs[pos - 1]!)} disabled={busy || pos === 0} title="Previous version" style={{ ...iconBtn, padding: 1, opacity: pos === 0 ? 0.3 : 1 }}><ChevronLeft size={11} /></button>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{pos + 1}/{sibs.length}</span>
                      <button onClick={() => sibs[pos + 1] && switchBranch(sibs[pos + 1]!)} disabled={busy || pos === sibs.length - 1} title="Next version" style={{ ...iconBtn, padding: 1, opacity: pos === sibs.length - 1 ? 0.3 : 1 }}><ChevronRight size={11} /></button>
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button onClick={() => m.id && removeMessage(m.id)} disabled={busy || !m.id} title="Delete this message and its replies" style={{ ...iconBtn, border: 'none', color: 'var(--text-dim)' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
                <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {m.content.length > 600 ? m.content.slice(0, 600) + '…' : m.content}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button style={{ ...primaryBtn, opacity: busy || loading ? 0.5 : 1 }} onClick={bringHere} disabled={busy || loading}>
        {busy ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />} Bring this branch here to continue
      </button>
    </div>
  );
}

// ── Send this chat (mint a one-time handoff code) ──

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

// ── Bring a chat here (redeem a code from the web) ──

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
      await importTranscript(backendPort, authToken, snap.title || 'Continued chat', snap.messages);
      setImported(snap.title || 'Continued chat');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code is invalid or has expired.');
    } finally {
      setBusy(false);
    }
  }

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
