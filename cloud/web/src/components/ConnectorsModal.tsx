import { useEffect, useMemo, useState } from 'react';
import { Plug, Trash2, Plus, Github, Slack, Globe, ShieldCheck, Loader2, ExternalLink, LogIn, Search, Zap } from 'lucide-react';
import Modal from './Modal.js';
import {
  fetchConnectors, fetchMcpServers, addMcpServer, setMcpServerEnabled, deleteMcpServer, startMcpOAuth,
  type ConnectorEntry, type McpServer,
} from '../lib/api.js';

// Small on/off pill (mirrors the Toggle used elsewhere, kept local to avoid a
// shared-import churn).
function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-accent-500' : 'bg-ink-700'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function ConnectorIcon({ id, color, name }: { id: string | null; color?: string; name?: string }) {
  if (id === 'github') return <Github size={16} className="text-ink-200" />;
  if (id === 'slack') return <Slack size={16} className="text-ink-200" />;
  if (id === 'google') return <Globe size={16} className="text-ink-200" />;
  // Brand letter-badge for the rest (no lucide brand icon), tinted with the
  // connector's colour so the directory reads at a glance.
  if (id && name) {
    const c = color || '#8b8b8b';
    return (
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold"
        style={{ background: `${c}22`, color: c }}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return <Plug size={16} className="text-ink-200" />;
}

export default function ConnectorsModal({ onClose }: { onClose: () => void }) {
  const [connectors, setConnectors] = useState<ConnectorEntry[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The connector being configured (token/url form), or 'custom', or null.
  const [adding, setAdding] = useState<ConnectorEntry | 'custom' | null>(null);
  const [form, setForm] = useState({ name: '', url: '', token: '' });
  // A hosted OAuth connector mid one-click redirect (shows a spinner on its card).
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const connectorById = useMemo(() => new Map(connectors.map((c) => [c.id, c])), [connectors]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connectors;
    return connectors.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
  }, [connectors, query]);

  function refresh() {
    return fetchMcpServers().then((r) => setServers(r.servers)).catch(() => setServers([]));
  }

  useEffect(() => {
    Promise.all([fetchConnectors().then((r) => setConnectors(r.connectors)).catch(() => {}), refresh()])
      .finally(() => setLoading(false));
    // Returning from an OAuth connect (top-level redirect back to the app).
    const params = new URLSearchParams(window.location.search);
    const mcp = params.get('mcp');
    if (mcp === 'connected') setNotice('Connected — the server is ready to use.');
    else if (mcp === 'error') setNotice('That connection could not be completed. Please try again.');
    if (mcp) {
      params.delete('mcp');
      window.history.replaceState({}, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
    }
  }, []);

  async function connectOAuth() {
    if (oauthBusy || !adding) return;
    setOauthBusy(true);
    setError(null);
    try {
      const payload = adding === 'custom'
        ? { name: form.name.trim(), url: form.url.trim() }
        : { connectorId: adding.id, url: form.url.trim() || undefined };
      const r = await startMcpOAuth(payload);
      if (r.oauth && r.authorizeUrl) { window.location.href = r.authorizeUrl; return; }
      setError('This server doesn’t offer OAuth sign-in — paste a token below instead.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start sign-in.');
    } finally {
      setOauthBusy(false);
    }
  }

  function startAdd(target: ConnectorEntry | 'custom') {
    setError(null);
    setAdding(target);
    setForm({
      name: target === 'custom' ? '' : target.name,
      url: target === 'custom' ? '' : target.url ?? '',
      token: '',
    });
  }

  // Directory click. A hosted OAuth connector goes STRAIGHT to sign-in (no form,
  // no URL, no token) — the Claude-style one-click. Everything else (token-based
  // like GitHub, or "bring your URL" like Slack/Google) opens the config form.
  async function pickConnector(c: ConnectorEntry) {
    if (connectingId) return;
    // Public, no-auth hosted server → add it directly, one click, no form.
    if (c.url && !c.requiresUrl && !c.oauth && !c.tokenLabel) {
      setConnectingId(c.id);
      setError(null);
      try {
        await addMcpServer({ connectorId: c.id });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not add that connector.');
        startAdd(c);
      } finally {
        setConnectingId(null);
      }
      return;
    }
    if (c.oauth && c.url && !c.requiresUrl) {
      setConnectingId(c.id);
      setError(null);
      try {
        const r = await startMcpOAuth({ connectorId: c.id });
        if (r.oauth && r.authorizeUrl) { window.location.href = r.authorizeUrl; return; }
        startAdd(c); // server didn't offer OAuth after all — fall back to the form
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start sign-in.');
        startAdd(c);
      } finally {
        setConnectingId(null);
      }
    } else {
      startAdd(c);
    }
  }

  async function submitAdd() {
    if (busy || !adding) return;
    setBusy(true);
    setError(null);
    try {
      const payload = adding === 'custom'
        ? { name: form.name.trim(), url: form.url.trim(), token: form.token.trim() || undefined }
        : { connectorId: adding.id, url: form.url.trim() || undefined, token: form.token.trim() || undefined };
      await addMcpServer(payload);
      await refresh();
      setAdding(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that connector.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: McpServer) {
    setServers((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await setMcpServerEnabled(s.id, !s.enabled);
    } catch {
      await refresh();
    }
  }

  async function remove(s: McpServer) {
    setServers((prev) => prev.filter((x) => x.id !== s.id));
    try {
      await deleteMcpServer(s.id);
    } catch {
      await refresh();
    }
  }

  // Which catalog connectors aren't configured yet (dedupe by connectorId).
  const configuredConnectorIds = new Set(servers.map((s) => s.connectorId).filter(Boolean));

  // Only show the "Sign in with OAuth" button when it can actually work: a custom
  // server (unknown — the user may point at an OAuth-speaking endpoint) or a
  // connector we know speaks OAuth. Token-only connectors like GitHub (no DCR)
  // just get the token field — no button that would only error.
  const showOAuth = adding === 'custom' || (!!adding && adding.oauth === true);

  return (
    <Modal title="Connectors & MCP" onClose={onClose} maxWidth="max-w-lg">
      <div className="flex flex-col gap-5 p-4">
        <p className="text-xs leading-relaxed text-ink-400">
          Give Cascade tools from other apps by connecting a remote{' '}
          <span className="text-ink-200">MCP server</span>. Enabled connections are available to every
          orchestrated run. Sign in with OAuth where supported, or paste a token — either way it's stored on the server and never shown again.
        </p>

        {notice && (
          <div className="rounded-lg border border-accent-500/20 bg-accent-500/[0.06] px-3 py-2 text-xs text-ink-200">{notice}</div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-ink-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : (
          <>
            {/* Your connections */}
            {servers.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Your connections</p>
                {servers.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 rounded-xl border border-elev/10 bg-elev/[0.04] px-3 py-2.5">
                    <ConnectorIcon id={s.connectorId} color={s.connectorId ? connectorById.get(s.connectorId)?.color : undefined} name={s.connectorId ? connectorById.get(s.connectorId)?.name : undefined} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink-100">{s.name}</span>
                        {s.hasAuth && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/10 px-1 py-px text-[10px] font-medium text-emerald-400">
                            <ShieldCheck size={9} /> auth
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-ink-500">{s.url}</div>
                    </div>
                    <Toggle on={s.enabled} onChange={() => toggle(s)} />
                    <button
                      type="button"
                      aria-label={`Remove ${s.name}`}
                      onClick={() => remove(s)}
                      className="rounded-md p-1 text-ink-500 hover:bg-danger-500/10 hover:text-danger-300"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add a connector */}
            {adding ? (
              <div className="flex flex-col gap-3 rounded-xl border border-accent-500/20 bg-accent-500/[0.04] p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-ink-100">
                  <ConnectorIcon id={adding === 'custom' ? null : adding.id} color={adding === 'custom' ? undefined : adding.color} name={adding === 'custom' ? undefined : adding.name} />
                  {adding === 'custom' ? 'Custom MCP server' : `Connect ${adding.name}`}
                </div>
                {adding !== 'custom' && adding.docsUrl && (
                  <a
                    href={adding.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-accent-300 hover:underline"
                  >
                    Get your {adding.tokenLabel} <ExternalLink size={10} />
                  </a>
                )}
                {adding === 'custom' && (
                  <input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Name (e.g. My Notion)"
                    className="rounded-lg border border-elev/10 bg-elev/[0.06] px-3 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-500"
                  />
                )}
                {(adding === 'custom' || adding.requiresUrl) && (
                  <input
                    value={form.url}
                    onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                    placeholder="https://your-mcp-server.example.com/mcp"
                    className="rounded-lg border border-elev/10 bg-elev/[0.06] px-3 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-500"
                  />
                )}
                {showOAuth && (
                  <>
                    <button
                      type="button"
                      onClick={connectOAuth}
                      disabled={oauthBusy || busy}
                      className="accent-grad flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {oauthBusy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />} Sign in with OAuth
                    </button>
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-ink-500">
                      <span className="h-px flex-1 bg-elev/10" /> or paste a token <span className="h-px flex-1 bg-elev/10" />
                    </div>
                  </>
                )}
                <input
                  type="password"
                  value={form.token}
                  onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                  placeholder={adding === 'custom' ? 'Auth token (optional)' : adding.tokenLabel}
                  className="rounded-lg border border-elev/10 bg-elev/[0.06] px-3 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-500"
                />
                {error && <p className="text-[11px] text-danger-300">{error}</p>}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setAdding(null)} className="rounded-lg px-3 py-1.5 text-sm text-ink-400 hover:text-ink-100">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitAdd}
                    disabled={busy}
                    className="accent-grad flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Connect
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Add a connector</p>
                  <div className="relative">
                    <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-500" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search…"
                      className="w-36 rounded-lg border border-elev/10 bg-elev/[0.06] py-1 pl-6 pr-2 text-xs text-ink-100 outline-none placeholder:text-ink-500 focus:w-44"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {filtered.map((c) => {
                    const oneClick = !!c.url && !c.requiresUrl && (!!c.oauth || !c.tokenLabel);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => pickConnector(c)}
                        disabled={!!connectingId}
                        className="flex items-start gap-2.5 rounded-xl border border-elev/10 bg-elev/[0.04] p-3 text-left transition-colors hover:border-accent-500/30 hover:bg-accent-500/[0.05] disabled:opacity-60"
                      >
                        {connectingId === c.id
                          ? <Loader2 size={16} className="mt-px shrink-0 animate-spin text-accent-300" />
                          : <ConnectorIcon id={c.id} color={c.color} name={c.name} />}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-sm font-medium text-ink-100">
                            {c.name}
                            {configuredConnectorIds.has(c.id) && (
                              <span className="rounded bg-ink-700/60 px-1 py-px text-[9px] text-ink-300">added</span>
                            )}
                            {oneClick && (
                              <span className="inline-flex items-center gap-0.5 rounded bg-accent-500/12 px-1 py-px text-[9px] font-medium text-accent-300">
                                <Zap size={8} /> 1-click
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] leading-snug text-ink-500">{c.description}</div>
                        </div>
                      </button>
                    );
                  })}
                  {filtered.length === 0 && (
                    <p className="col-span-full px-1 py-3 text-center text-[11px] text-ink-500">No connectors match “{query}”.</p>
                  )}
                  <button
                    type="button"
                    onClick={() => startAdd('custom')}
                    className="flex items-start gap-2.5 rounded-xl border border-dashed border-elev/15 p-3 text-left transition-colors hover:border-accent-500/30 hover:bg-accent-500/[0.05]"
                  >
                    <Plus size={16} className="text-ink-300" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink-100">Custom MCP server</div>
                      <div className="text-[11px] leading-snug text-ink-500">Point at any remote (https) MCP endpoint.</div>
                    </div>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
