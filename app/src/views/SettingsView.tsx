import { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { X, Monitor, Sun, Moon, Sparkles, RefreshCw, List } from 'lucide-react';
import { useAppDispatch, useAppSelector, type ThemePref } from '../store/index.js';
import { setShowSettings } from '../store/index.js';
import { setThemePreference } from '../theme/useTheme.js';
import { UpdatesPanel } from './UpdatesPanel.js';

type Tab = 'keys' | 'models' | 'budget' | 'appearance' | 'updates';
type Bias = 'balanced' | 'quality' | 'cost';

// Provider → ProviderType key used by the Cascade core + the curated models
// each one exposes in the tier pickers. 'auto' means "let routing decide".
interface ProviderDef { id: string; label: string; models: string[]; freeText?: boolean }
const TIER_PROVIDERS: ProviderDef[] = [
  { id: 'auto', label: 'Auto (best model)', models: [] },
  { id: 'anthropic', label: 'Anthropic', models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] },
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'] },
  { id: 'gemini', label: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-2.0-pro'] },
  { id: 'openai-compatible', label: 'OpenAI-Compatible', models: [], freeText: true },
  { id: 'ollama', label: 'Ollama (local)', models: [], freeText: true },
];

interface TierSel { provider: string; model: string }

// Parse a stored override ('auto' | 'provider:model' | bare model id) into a
// { provider, model } selection for the two dropdowns.
function parseOverride(val: string | undefined): TierSel {
  if (!val || val === 'auto') return { provider: 'auto', model: '' };
  if (val.includes(':')) {
    const [provider, ...rest] = val.split(':');
    if (TIER_PROVIDERS.some((p) => p.id === provider)) return { provider, model: rest.join(':') };
  }
  const lower = val.toLowerCase();
  if (lower.includes('claude')) return { provider: 'anthropic', model: val };
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3')) return { provider: 'openai', model: val };
  if (lower.includes('gemini')) return { provider: 'gemini', model: val };
  return { provider: 'openai-compatible', model: val };
}

// Compose a { provider, model } selection back into a stored override string.
function composeOverride(sel: TierSel): string {
  if (sel.provider === 'auto') return 'auto';
  if (!sel.model) return 'auto';
  return `${sel.provider}:${sel.model}`;
}

interface Props { socket: Socket | null }

export function SettingsView({ socket }: Props) {
  const dispatch = useAppDispatch();
  const [tab, setTab] = useState<Tab>('keys');
  const themePref = useAppSelector((s) => s.app.themePref);

  // API keys (sent under the Cascade ProviderType used by the core)
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [providersWithKey, setProvidersWithKey] = useState<string[]>([]);
  // OpenAI-compatible (vLLM / llama.cpp / LM Studio …) key + endpoint, and Ollama endpoint.
  const [ocKey, setOcKey] = useState('');
  const [ocUrl, setOcUrl] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('');

  // Per-tier provider + model
  const [t1, setT1] = useState<TierSel>({ provider: 'auto', model: '' });
  const [t2, setT2] = useState<TierSel>({ provider: 'auto', model: '' });
  const [t3, setT3] = useState<TierSel>({ provider: 'auto', model: '' });

  // Budget
  const [maxCost, setMaxCost] = useState('');
  const [bias, setBias] = useState<Bias>('balanced');

  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Real models discovered from the user's endpoints (Ollama tags +
  // OpenAI-compatible / llama.cpp /v1/models), used to populate the per-tier
  // pickers so a local model id never has to be typed by hand (and matches
  // exactly what the server reports, which is what routing needs).
  const [dynModels, setDynModels] = useState<Array<{ id: string; provider: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [customTiers, setCustomTiers] = useState<Record<string, boolean>>({});

  // Apply a redacted config snapshot to the panel (the keys themselves are never
  // sent back — only which providers already have one).
  const applyConfig = (cfg: {
    models?: Record<string, string>;
    budget?: { maxCostPerRun?: number; autoBias?: string };
    providersWithKey?: string[];
    endpoints?: Record<string, string>;
  }) => {
    setT1(parseOverride(cfg.models?.t1));
    setT2(parseOverride(cfg.models?.t2));
    setT3(parseOverride(cfg.models?.t3));
    if (typeof cfg.budget?.maxCostPerRun === 'number') setMaxCost(String(cfg.budget.maxCostPerRun));
    if (cfg.budget?.autoBias === 'balanced' || cfg.budget?.autoBias === 'quality' || cfg.budget?.autoBias === 'cost') {
      setBias(cfg.budget.autoBias);
    }
    if (cfg.providersWithKey) setProvidersWithKey(cfg.providersWithKey);
    if (cfg.endpoints?.['openai-compatible']) setOcUrl(cfg.endpoints['openai-compatible']);
    if (cfg.endpoints?.['ollama']) setOllamaUrl(cfg.endpoints['ollama']);
  };

  // Pre-load via the Electron IPC bridge first — this works even when the
  // Socket.IO backend never started, so the panel always reflects reality.
  useEffect(() => {
    window.cascade?.getSettings?.().then(applyConfig).catch(() => { /* no backend yet */ });
  }, []);

  // Pull the user's REAL available models from their configured endpoints. This
  // runs a fresh discovery over the saved config (no backend restart needed), so
  // an OpenAI-compatible / Ollama endpoint's models appear as soon as it's saved.
  const fetchModels = async () => {
    if (!window.cascade?.listModels) return;
    setModelsLoading(true);
    try { const res = await window.cascade.listModels(); setDynModels(res?.models ?? []); }
    catch { setDynModels([]); }
    finally { setModelsLoading(false); }
  };
  useEffect(() => { fetchModels(); }, []);

  // Also listen to the live backend snapshot when a socket is connected.
  useEffect(() => {
    if (!socket) return;
    const onCurrent = (cfg: {
      models?: Record<string, string>;
      budget?: { maxCostPerRun?: number; autoBias?: Bias };
      providersWithKey?: string[];
    }) => applyConfig(cfg);
    socket.on('config:current', onCurrent);
    socket.emit('config:get');
    return () => { socket.off('config:current', onCurrent); };
  }, [socket]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch(setShowSettings(false)); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  const save = async () => {
    setSaveError('');
    const payload = {
      keys: { anthropic: anthropicKey || undefined, openai: openaiKey || undefined, gemini: geminiKey || undefined, 'openai-compatible': ocKey || undefined },
      models: { t1: composeOverride(t1), t2: composeOverride(t2), t3: composeOverride(t3) },
      budget: { maxCostPerRun: maxCost ? parseFloat(maxCost) : undefined, autoBias: bias },
      endpoints: { 'openai-compatible': ocUrl.trim() || undefined, ollama: ollamaUrl.trim() || undefined },
    };

    // Primary path: persist via the Electron IPC bridge. This works even when the
    // Socket.IO backend never started — the old code emitted only on the socket
    // and silently did nothing when it was null (the "can't save keys" bug).
    let persisted = false;
    try {
      if (window.cascade?.updateSettings) {
        const res = await window.cascade.updateSettings(payload);
        if (res?.ok) { persisted = true; applyConfig(res); }
        else if (res?.error && res.error !== 'backend-unavailable') setSaveError(res.error);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }

    // Also notify the live backend (when connected) so the running session picks
    // up the new keys/models immediately, with no restart.
    if (socket) { socket.emit('config:update', payload); persisted = true; }
    void fetchModels(); // re-discover endpoint models after saving (no restart)

    if (!persisted) {
      setSaveError('Could not save — the Cascade backend is unavailable. Try restarting the app.');
      return;
    }

    // Keys are now stored; clear the inputs so placeholders show "key set".
    setAnthropicKey(''); setOpenaiKey(''); setGeminiKey(''); setOcKey('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.6)',
      backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.2s var(--ease)',
    }} onClick={() => dispatch(setShowSettings(false))}>
      <div style={{
        width: 480, background: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-3)',
        overflow: 'hidden',
      }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '15px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 14, flex: 1, letterSpacing: '-0.2px' }}>Settings</span>
          <button onClick={() => dispatch(setShowSettings(false))} title="Close (Esc)" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4, borderRadius: 5, transition: 'color var(--dur), background var(--dur)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 18px' }}>
          {(['keys', 'models', 'budget', 'appearance', 'updates'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '10px 14px',
              fontSize: 12, fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1, transition: 'color 0.12s', whiteSpace: 'nowrap',
            }}>
              {t === 'keys' ? 'Providers' : t === 'models' ? 'Models' : t === 'budget' ? 'Budget & Bias' : t === 'appearance' ? 'Appearance' : 'Updates'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 220 }}>
          {tab === 'keys' && (
            <>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Keys are stored in your local Cascade config and never sent to any server other than the model provider.
              </p>
              {[
                { id: 'anthropic', label: 'Anthropic', val: anthropicKey, set: setAnthropicKey, placeholder: 'sk-ant-…' },
                { id: 'openai', label: 'OpenAI', val: openaiKey, set: setOpenaiKey, placeholder: 'sk-…' },
                { id: 'gemini', label: 'Google', val: geminiKey, set: setGeminiKey, placeholder: 'AIza…' },
              ].map(({ id, label, val, set, placeholder }) => (
                <div key={label}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    {label}
                    {providersWithKey.includes(id) && (
                      <span style={{ color: 'var(--success)', marginLeft: 6 }}>• key set</span>
                    )}
                  </label>
                  <input type="password" value={val} onChange={(e) => set(e.target.value)}
                    placeholder={providersWithKey.includes(id) ? '•••••••• (leave blank to keep)' : placeholder}
                    style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                </div>
              ))}
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  OpenAI-Compatible (vLLM / llama.cpp / LM Studio …)
                  {providersWithKey.includes('openai-compatible') && (<span style={{ color: 'var(--success)', marginLeft: 6 }}>• key set</span>)}
                </label>
                <input type="password" value={ocKey} onChange={(e) => setOcKey(e.target.value)}
                  placeholder={providersWithKey.includes('openai-compatible') ? '•••••••• (leave blank to keep)' : 'API key (optional for local servers)'}
                  style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                <input type="text" value={ocUrl} onChange={(e) => setOcUrl(e.target.value)}
                  placeholder="Base URL — e.g. http://localhost:8000/v1"
                  style={{ width: '100%', marginTop: 6, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Ollama endpoint</label>
                <input type="text" value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
              </div>
            </>
          )}

          {tab === 'models' && (
            <>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Choose a provider and model per tier. <code>Auto</code> lets Cascade pick the best model dynamically.
              </p>
              {([['T1 (Planner)', t1, setT1], ['T2 (Manager)', t2, setT2], ['T3 (Worker)', t3, setT3]] as const).map(([label, sel, setSel]) => {
                const def = TIER_PROVIDERS.find((p) => p.id === sel.provider) ?? TIER_PROVIDERS[0];
                return (
                  <div key={label}>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{label}</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select value={sel.provider}
                        onChange={(e) => {
                          const next = TIER_PROVIDERS.find((p) => p.id === e.target.value)!;
                          setSel({ provider: next.id, model: next.models[0] ?? '' });
                          if (next.freeText) fetchModels();
                        }}
                        style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none' }}>
                        {TIER_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                      {sel.provider !== 'auto' && (() => {
                        const fieldStyle = { flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const };
                        const btnStyle = { flexShrink: 0, width: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer' };
                        if (!def.freeText) {
                          return (
                            <select value={sel.model} onChange={(e) => setSel({ ...sel, model: e.target.value })} style={fieldStyle}>
                              {def.models.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          );
                        }
                        // OpenAI-compatible / Ollama: offer the endpoint's real model ids.
                        const opts = dynModels.filter((m) => m.provider === sel.provider).map((m) => m.id);
                        const showInput = (customTiers[label] ?? false) || opts.length === 0;
                        return (
                          <div style={{ flex: 1, display: 'flex', gap: 6 }}>
                            {showInput ? (
                              <input value={sel.model} onChange={(e) => setSel({ ...sel, model: e.target.value })}
                                placeholder={modelsLoading ? 'Loading from endpoint…' : 'model id (endpoint unreachable?)'}
                                style={fieldStyle} />
                            ) : (
                              <select value={opts.includes(sel.model) ? sel.model : '__custom__'}
                                onChange={(e) => { if (e.target.value === '__custom__') setCustomTiers((c) => ({ ...c, [label]: true })); else setSel({ ...sel, model: e.target.value }); }}
                                style={fieldStyle}>
                                {sel.model && !opts.includes(sel.model) && <option value={sel.model}>{sel.model}</option>}
                                {opts.map((m) => <option key={m} value={m}>{m}</option>)}
                                <option value="__custom__">Custom…</option>
                              </select>
                            )}
                            <button type="button" title="Refresh models from endpoint" onClick={fetchModels} style={btnStyle}>
                              <RefreshCw size={13} />
                            </button>
                            {showInput && opts.length > 0 && (
                              <button type="button" title="Pick from discovered list" onClick={() => setCustomTiers((c) => ({ ...c, [label]: false }))} style={btnStyle}>
                                <List size={13} />
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {tab === 'updates' && <UpdatesPanel />}

          {tab === 'appearance' && (
            <>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Choose how Cascade looks. <code>System</code> follows your OS light/dark setting automatically.
              </p>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block' }}>Theme</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {([
                  { id: 'system', label: 'System', Icon: Monitor },
                  { id: 'light', label: 'Light', Icon: Sun },
                  { id: 'dark', label: 'Dark', Icon: Moon },
                  { id: 'midnight', label: 'Midnight', Icon: Sparkles },
                ] as { id: ThemePref; label: string; Icon: typeof Monitor }[]).map(({ id, label, Icon }) => {
                  const active = themePref === id;
                  return (
                    <button key={id} onClick={() => setThemePreference(dispatch, id)} style={{
                      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                      padding: '14px 10px', cursor: 'pointer',
                      background: active ? 'var(--accent-soft)' : 'var(--bg-raised)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-md)',
                      color: active ? 'var(--accent)' : 'var(--text-muted)',
                      fontSize: 12, fontWeight: active ? 600 : 400,
                      transition: 'all var(--dur) var(--ease)',
                    }}>
                      <Icon size={18} />
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {tab === 'budget' && (
            <>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Max cost per run (USD)</label>
                <input type="number" min="0" step="0.01" value={maxCost} onChange={(e) => setMaxCost(e.target.value)}
                  placeholder="e.g. 0.50 (leave blank for no cap)"
                  style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>Routing bias</label>
                {(['balanced', 'quality', 'cost'] as Bias[]).map((b) => (
                  <label key={b} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8, fontSize: 12 }}>
                    <input type="radio" name="bias" checked={bias === b} onChange={() => setBias(b)} />
                    <span style={{ fontWeight: bias === b ? 600 : 400, color: bias === b ? 'var(--accent)' : 'var(--text)' }}>
                      {b.charAt(0).toUpperCase() + b.slice(1)}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                      {b === 'balanced' ? '— quality × cost (default)' : b === 'quality' ? '— best results, higher cost' : '— cheapest that can do it'}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          {saveError && (
            <span style={{ flex: 1, fontSize: 11, color: 'var(--danger)', lineHeight: 1.3 }}>{saveError}</span>
          )}
          <button onClick={() => dispatch(setShowSettings(false))} style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text-muted)', padding: '7px 16px', fontSize: 12, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={save} style={{
            background: saved ? 'var(--success)' : 'linear-gradient(135deg, var(--accent), var(--accent-2))',
            border: 'none', borderRadius: 6, color: '#fff', fontWeight: 600,
            padding: '7px 22px', fontSize: 12, cursor: 'pointer', transition: 'background 0.15s',
            boxShadow: 'var(--shadow-1)',
          }}>{saved ? '✓ Saved' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
