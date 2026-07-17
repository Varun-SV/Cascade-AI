import { useEffect, useState } from 'react';
import { Plug, Trash2, Plus, Github, Slack, Globe, ShieldCheck, Loader2, ExternalLink } from 'lucide-react';
import Modal from './Modal.js';
import {
  fetchConnectors, fetchMcpServers, addMcpServer, setMcpServerEnabled, deleteMcpServer,
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

function ConnectorIcon({ id }: { id: string | null }) {
  if (id === 'github') return <Github size={16} className="text-ink-200" />;
  if (id === 'slack') return <Slack size={16} className="text-ink-200" />;
  if (id === 'google') return <Globe size={16} className="text-ink-200" />;
  return <Plug size={16} className="text-ink-200" />;
}

export default function ConnectorsModal({ onClose }: { onClose: () => void }) {
  const [connectors, setConnectors] = useState<ConnectorEntry[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The connector being configured (token/url form), or 'custom', or null.
  const [adding, setAdding] = useState<ConnectorEntry | 'custom' | null>(null);
  const [form, setForm] = useState({ name: '', url: '', token: '' });

  function refresh() {
    return fetchMcpServers().then((r) => setServers(r.servers)).catch(() => setServers([]));
  }

  useEffect(() => {
    Promise.all([fetchConnectors().then((r) => setConnectors(r.connectors)).catch(() => {}), refresh()])
      .finally(() => setLoading(false));
  }, []);

  function startAdd(target: ConnectorEntry | 'custom') {
    setError(null);
    setAdding(target);
    setForm({
      name: target === 'custom' ? '' : target.name,
      url: target === 'custom' ? '' : target.url ?? '',
      token: '',
    });
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

  return (
    <Modal title="Connectors & MCP" onClose={onClose} maxWidth="max-w-lg">
      <div className="flex flex-col gap-5 p-4">
        <p className="text-xs leading-relaxed text-ink-400">
          Give Cascade tools from other apps by connecting a remote{' '}
          <span className="text-ink-200">MCP server</span>. Enabled connections are available to every
          orchestrated run. Tokens are stored on the server and never shown again.
        </p>

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
                    <ConnectorIcon id={s.connectorId} />
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
                  <ConnectorIcon id={adding === 'custom' ? null : adding.id} />
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
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Add a connector</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {connectors.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => startAdd(c)}
                      className="flex items-start gap-2.5 rounded-xl border border-elev/10 bg-elev/[0.04] p-3 text-left transition-colors hover:border-accent-500/30 hover:bg-accent-500/[0.05]"
                    >
                      <ConnectorIcon id={c.id} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-ink-100">
                          {c.name}
                          {configuredConnectorIds.has(c.id) && (
                            <span className="rounded bg-ink-700/60 px-1 py-px text-[9px] text-ink-300">added</span>
                          )}
                        </div>
                        <div className="text-[11px] leading-snug text-ink-500">{c.description}</div>
                      </div>
                    </button>
                  ))}
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
