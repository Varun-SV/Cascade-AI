import { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { X, Monitor, Sun, Moon, Sparkles, RefreshCw, List } from 'lucide-react';
import { useAppDispatch, useAppSelector, type ThemePref } from '../store/index.js';
import { setShowSettings } from '../store/index.js';
import { setThemePreference } from '../theme/useTheme.js';
import { UpdatesPanel } from './UpdatesPanel.js';

type Tab = 'keys' | 'models' | 'budget' | 'advanced' | 'data' | 'appearance' | 'updates';
type Bias = 'balanced' | 'quality' | 'cost';

/** Advanced config knobs surfaced 1:1 from the core schema. */
interface AdvancedSettings {
  autonomy: 'manual' | 'auto';
  planApproval: 'never' | 'complex' | 'all' | 'always';
  approvalTimeoutMs: number;
  t3Execution: 'auto' | 'parallel' | 'sequential';
  localConcurrency: number;
  localInferenceTimeoutMs: number;
  cloudInferenceTimeoutMs: number;
  reflectionEnabled: boolean;
  cascadeAuto: boolean;
  forceTier: 'auto' | 'T1' | 'T2' | 'T3';
  benchmarksLive: boolean;
  dynamicToolSandbox: 'isolate' | 'worker' | 'auto';
  factsExtraction: boolean;
  enableToolCreation: boolean;
  persistDynamicTools: boolean;
  telemetryEnabled: boolean;
}

const ADVANCED_DEFAULTS: AdvancedSettings = {
  autonomy: 'manual',
  planApproval: 'complex',
  approvalTimeoutMs: 600_000,
  t3Execution: 'auto',
  localConcurrency: 1,
  localInferenceTimeoutMs: 300_000,
  cloudInferenceTimeoutMs: 120_000,
  reflectionEnabled: false,
  cascadeAuto: true,
  forceTier: 'auto',
  benchmarksLive: true,
  dynamicToolSandbox: 'auto',
  factsExtraction: true,
  enableToolCreation: true,
  persistDynamicTools: true,
  telemetryEnabled: false,
};

// Provider → ProviderType key used by the Cascade core + the curated models
// each one exposes in the tier pickers. 'auto' means "let routing decide".
interface ProviderDef { id: string; label: string; models: string[]; freeText?: boolean }
const TIER_PROVIDERS: ProviderDef[] = [
  { id: 'auto', label: 'Auto (best model)', models: [] },
  { id: 'anthropic', label: 'Anthropic', models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] },
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'] },
  { id: 'azure', label: 'Azure OpenAI', models: [], freeText: true },
  { id: 'gemini', label: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-2.0-pro'] },
  { id: 'openai-compatible', label: 'OpenAI-Compatible', models: [], freeText: true },
  { id: 'ollama', label: 'Ollama (local)', models: [], freeText: true },
];

interface TierSel { provider: string; model: string }

/** One Azure OpenAI deployment row — Azure is the only provider type that can
 * have more than one entry (each its own resource/endpoint), so unlike every
 * other provider it gets its own repeating editor instead of a single field. */
interface AzureDeploymentDraft {
  id: string; // client-side only, for React keys / row identity — never sent
  label: string;
  baseUrl: string;
  apiKey: string; // blank + hasKey=true means "leave blank to keep"
  deploymentName: string;
  apiVersion: string;
  hasKey: boolean;
}
const emptyAzureRow = (): AzureDeploymentDraft => ({
  id: crypto.randomUUID(), label: '', baseUrl: '', apiKey: '', deploymentName: '', apiVersion: '', hasKey: false,
});

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
  // Web-search backends (tools.webSearch) — without one configured, the
  // web_search tool depends entirely on scraping DuckDuckGo.
  const [searxngUrl, setSearxngUrl] = useState('');
  const [braveKey, setBraveKey] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [searchKeysSet, setSearchKeysSet] = useState<{ brave: boolean; tavily: boolean }>({ brave: false, tavily: false });
  // Azure configuration — multiple deployments, each its own resource/endpoint.
  const [azureDeployments, setAzureDeployments] = useState<AzureDeploymentDraft[]>([]);
  const updateAzureRow = (id: string, patch: Partial<AzureDeploymentDraft>) =>
    setAzureDeployments((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addAzureRow = () => setAzureDeployments((prev) => [...prev, emptyAzureRow()]);
  const removeAzureRow = (id: string) => setAzureDeployments((prev) => prev.filter((r) => r.id !== id));

  // Per-tier provider + model
  const [t1, setT1] = useState<TierSel>({ provider: 'auto', model: '' });
  const [t2, setT2] = useState<TierSel>({ provider: 'auto', model: '' });
  const [t3, setT3] = useState<TierSel>({ provider: 'auto', model: '' });

  // Budget
  const [maxCost, setMaxCost] = useState('');
  const [bias, setBias] = useState<Bias>('balanced');
  const [dailyBudget, setDailyBudget] = useState('');
  const [sessionBudget, setSessionBudget] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [warnAt, setWarnAt] = useState('');

  // Advanced (1:1 with core config fields; see ADVANCED_DEFAULTS)
  const [adv, setAdv] = useState<AdvancedSettings>(ADVANCED_DEFAULTS);
  const setAdvField = <K extends keyof AdvancedSettings>(key: K, value: AdvancedSettings[K]) =>
    setAdv((prev) => ({ ...prev, [key]: value }));

  // Data (export/import)
  const { backendPort, authToken } = useAppSelector((s) => s.app);
  const [includeMemories, setIncludeMemories] = useState(true);
  const [dataStatus, setDataStatus] = useState('');

  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Real models discovered from the user's endpoints (Ollama tags +
  // OpenAI-compatible / llama.cpp /v1/models), used to populate the per-tier
  // pickers so a local model id never has to be typed by hand (and matches
  // exactly what the server reports, which is what routing needs).
  const [dynModels, setDynModels] = useState<Array<{ id: string; provider: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [ocProbe, setOcProbe] = useState<{ status?: number; count?: number; error?: string } | undefined>();
  const [customTiers, setCustomTiers] = useState<Record<string, boolean>>({});

  // Apply a redacted config snapshot to the panel (the keys themselves are never
  // sent back — only which providers already have one).
  const applyConfig = (cfg: {
    models?: Record<string, string>;
    budget?: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number };
    providersWithKey?: string[];
    endpoints?: Record<string, string>;
    azureDeployments?: Array<{ label?: string; baseUrl?: string; deploymentName?: string; apiVersion?: string; hasKey: boolean }>;
    webSearch?: { searxngUrl?: string; hasBraveKey: boolean; hasTavilyKey: boolean };
    advanced?: Record<string, unknown>;
  }) => {
    setT1(parseOverride(cfg.models?.t1));
    setT2(parseOverride(cfg.models?.t2));
    setT3(parseOverride(cfg.models?.t3));
    if (typeof cfg.budget?.maxCostPerRun === 'number') setMaxCost(String(cfg.budget.maxCostPerRun));
    if (cfg.budget?.autoBias === 'balanced' || cfg.budget?.autoBias === 'quality' || cfg.budget?.autoBias === 'cost') {
      setBias(cfg.budget.autoBias);
    }
    if (typeof cfg.budget?.dailyBudgetUsd === 'number') setDailyBudget(String(cfg.budget.dailyBudgetUsd));
    if (typeof cfg.budget?.sessionBudgetUsd === 'number') setSessionBudget(String(cfg.budget.sessionBudgetUsd));
    if (typeof cfg.budget?.maxTokensPerRun === 'number') setMaxTokens(String(cfg.budget.maxTokensPerRun));
    if (typeof cfg.budget?.warnAtPct === 'number') setWarnAt(String(cfg.budget.warnAtPct));
    if (cfg.providersWithKey) setProvidersWithKey(cfg.providersWithKey);
    if (cfg.endpoints?.['openai-compatible']) setOcUrl(cfg.endpoints['openai-compatible']);
    if (cfg.endpoints?.['ollama']) setOllamaUrl(cfg.endpoints['ollama']);
    if (cfg.webSearch) {
      if (cfg.webSearch.searxngUrl) setSearxngUrl(cfg.webSearch.searxngUrl);
      setSearchKeysSet({ brave: cfg.webSearch.hasBraveKey, tavily: cfg.webSearch.hasTavilyKey });
    }
    if (cfg.azureDeployments) {
      setAzureDeployments(cfg.azureDeployments.map((d) => ({
        id: crypto.randomUUID(),
        label: d.label ?? '',
        baseUrl: d.baseUrl ?? '',
        apiKey: '', // never sent back — blank + hasKey means "leave blank to keep"
        deploymentName: d.deploymentName ?? '',
        apiVersion: d.apiVersion ?? '',
        hasKey: d.hasKey,
      })));
    }
    if (cfg.advanced && typeof cfg.advanced === 'object') {
      setAdv((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(ADVANCED_DEFAULTS) as Array<keyof AdvancedSettings>) {
          const v = cfg.advanced![key];
          if (v !== undefined && v !== null) (next as Record<string, unknown>)[key] = v;
        }
        return next;
      });
    }
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
    try { const res = await window.cascade.listModels(); setDynModels(res?.models ?? []); setOcProbe(res?.ocProbe); }
    catch { setDynModels([]); setOcProbe(undefined); }
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
      budget: {
        maxCostPerRun: maxCost ? parseFloat(maxCost) : undefined,
        autoBias: bias,
        dailyBudgetUsd: dailyBudget ? parseFloat(dailyBudget) : undefined,
        sessionBudgetUsd: sessionBudget ? parseFloat(sessionBudget) : undefined,
        maxTokensPerRun: maxTokens ? parseInt(maxTokens, 10) : undefined,
        warnAtPct: warnAt ? parseFloat(warnAt) : undefined,
      },
      endpoints: { 'openai-compatible': ocUrl.trim() || undefined, ollama: ollamaUrl.trim() || undefined },
      webSearch: { searxngUrl: searxngUrl.trim(), braveApiKey: braveKey || undefined, tavilyApiKey: tavilyKey || undefined },
      azureDeployments: azureDeployments
        .filter((d) => d.label.trim() || d.baseUrl.trim() || d.apiKey.trim() || d.deploymentName.trim())
        .map((d) => ({
          label: d.label.trim() || undefined,
          apiKey: d.apiKey.trim() || undefined,
          baseUrl: d.baseUrl.trim() || undefined,
          deploymentName: d.deploymentName.trim() || undefined,
          apiVersion: d.apiVersion.trim() || undefined,
        })),
      advanced: { ...adv },
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
        // The panel must never outgrow the window (multiple Azure deployment
        // rows used to push the footer/Save off-screen with no way to scroll):
        // header/tabs/footer stay pinned, the content area scrolls.
        maxHeight: '86vh', display: 'flex', flexDirection: 'column',
      }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '15px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14, flex: 1, letterSpacing: '-0.2px' }}>Settings</span>
          <button onClick={() => dispatch(setShowSettings(false))} title="Close (Esc)" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4, borderRadius: 5, transition: 'color var(--dur), background var(--dur)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text)'; (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: '1px solid var(--border)', padding: '0 18px', flexShrink: 0 }}>
          {(['keys', 'models', 'budget', 'advanced', 'data', 'appearance', 'updates'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '10px 10px',
              fontSize: 12, fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1, transition: 'color 0.12s', whiteSpace: 'nowrap',
            }}>
              {t === 'keys' ? 'Providers' : t === 'models' ? 'Models' : t === 'budget' ? 'Budget' : t === 'advanced' ? 'Advanced' : t === 'data' ? 'Data' : t === 'appearance' ? 'Appearance' : 'Updates'}
            </button>
          ))}
        </div>

        {/* Content — scrolls within the height-capped panel */}
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 220, flex: 1, overflowY: 'auto' }}>
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
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
                    Azure OpenAI — each deployment is its own resource/endpoint
                  </label>
                  <button onClick={addAzureRow} type="button" style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer',
                    color: 'var(--text-muted)', fontSize: 11, padding: '3px 8px',
                  }}>+ Add deployment</button>
                </div>
                {azureDeployments.length === 0 && (
                  <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>No Azure deployments configured yet.</p>
                )}
                {azureDeployments.map((row, i) => (
                  <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, background: 'var(--bg-raised)', borderRadius: 6 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="text" value={row.label} onChange={(e) => updateAzureRow(row.id, { label: e.target.value })}
                        placeholder={`Label (e.g. prod-${i + 1})`}
                        style={{ flex: 1, background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '6px 8px', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
                      <button onClick={() => removeAzureRow(row.id)} title="Remove this deployment" type="button" style={{
                        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 15, lineHeight: 1, padding: '0 4px',
                      }}>×</button>
                    </div>
                    <input type="text" value={row.baseUrl} onChange={(e) => updateAzureRow(row.id, { baseUrl: e.target.value })}
                      placeholder="https://your-resource.openai.azure.com"
                      style={{ width: '100%', background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '6px 8px', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input type="password" value={row.apiKey} onChange={(e) => updateAzureRow(row.id, { apiKey: e.target.value })}
                        placeholder={row.hasKey ? '•••••••• (leave blank to keep)' : 'API Key'}
                        style={{ flex: 1, background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '6px 8px', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
                      <input type="text" value={row.deploymentName} onChange={(e) => updateAzureRow(row.id, { deploymentName: e.target.value })}
                        placeholder="Deployment name"
                        style={{ flex: 1, background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '6px 8px', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <input type="text" value={row.apiVersion} onChange={(e) => updateAzureRow(row.id, { apiVersion: e.target.value })}
                      placeholder="API version (default 2024-08-01-preview)"
                      style={{ width: '100%', background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '6px 8px', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
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
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Web search — without a backend, the <code>web_search</code> tool relies on scraping DuckDuckGo (works, but rate-limited and less reliable)
                </label>
                <input type="text" value={searxngUrl} onChange={(e) => setSearxngUrl(e.target.value)}
                  placeholder="SearXNG URL (self-hosted) — e.g. https://searx.example.com"
                  style={{ width: '100%', background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '6px 8px', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="password" value={braveKey} onChange={(e) => setBraveKey(e.target.value)}
                    placeholder={searchKeysSet.brave ? 'Brave key •••• (blank to keep)' : 'Brave Search API key'}
                    style={{ flex: 1, background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '6px 8px', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
                  <input type="password" value={tavilyKey} onChange={(e) => setTavilyKey(e.target.value)}
                    placeholder={searchKeysSet.tavily ? 'Tavily key •••• (blank to keep)' : 'Tavily API key'}
                    style={{ flex: 1, background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '6px 8px', fontSize: 11.5, outline: 'none', boxSizing: 'border-box' }} />
                </div>
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
                    <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
                      <select value={sel.provider}
                        onChange={(e) => {
                          const next = TIER_PROVIDERS.find((p) => p.id === e.target.value)!;
                          setSel({ provider: next.id, model: next.models[0] ?? '' });
                          fetchModels();
                        }}
                        style={{ flex: 1, minWidth: 0, maxWidth: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none' }}>
                        {TIER_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                      {sel.provider !== 'auto' && (() => {
                        const fieldStyle = { flex: 1, minWidth: 0, maxWidth: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const };
                        const btnStyle = { flexShrink: 0, width: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer' };
                        // EVERY provider offers its live-discovered models (cloud
                        // catalogs, Azure deployments, local endpoint tags), with
                        // the curated list as fallback — previously only the
                        // free-text providers used discovery, so Google/Anthropic/
                        // OpenAI were stuck on a hardcoded set and Azure showed
                        // nothing at all.
                        const discovered = dynModels.filter((m) => m.provider === sel.provider).map((m) => m.id);
                        const opts = Array.from(new Set([...discovered, ...def.models]));
                        const showInput = (customTiers[label] ?? false) || opts.length === 0;
                        return (
                          <div style={{ flex: 1, display: 'flex', gap: 6 }}>
                            {showInput ? (
                              <input value={sel.model} onChange={(e) => setSel({ ...sel, model: e.target.value })}
                                placeholder={modelsLoading ? 'Loading from endpoint…'
                                  : sel.provider === 'azure' ? 'deployment name (add deployments in Providers)'
                                  : 'model id (endpoint unreachable?)'}
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
                    {def.freeText && sel.provider === 'openai-compatible' && !modelsLoading
                      && dynModels.filter((m) => m.provider === 'openai-compatible').length === 0
                      && ocProbe && (() => {
                        // A probe that got a 2xx with a real model count still falls through to
                        // here when the router's own discovery didn't pick up any models (e.g. a
                        // transient hiccup on an earlier check) — surface that instead of nothing,
                        // so a reachable-but-not-yet-listed endpoint is never silently unexplained.
                        const reason = ocProbe.error
                          ? `couldn't reach endpoint — ${ocProbe.error}`
                          : (ocProbe.status != null && (ocProbe.status < 200 || ocProbe.status >= 300))
                            ? `endpoint returned HTTP ${ocProbe.status}`
                            : ocProbe.count === 0
                              ? 'endpoint reachable, but it returned 0 models'
                              : `endpoint reachable${ocProbe.count && ocProbe.count > 0 ? ` (found ${ocProbe.count} model${ocProbe.count === 1 ? '' : 's'})` : ''} — click Refresh to reload`;
                        return reason ? (
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
                            {reason}. Check the OpenAI-Compatible Base URL in the Providers tab.
                          </span>
                        ) : null;
                      })()}
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'Daily budget (USD)', val: dailyBudget, set: setDailyBudget, ph: 'no cap', step: '0.5' },
                  { label: 'Per-session budget (USD)', val: sessionBudget, set: setSessionBudget, ph: 'no cap', step: '0.5' },
                  { label: 'Max tokens per run', val: maxTokens, set: setMaxTokens, ph: '200000', step: '1000' },
                  { label: 'Warn at % of budget', val: warnAt, set: setWarnAt, ph: '80', step: '5' },
                ].map(({ label, val, set, ph, step }) => (
                  <div key={label}>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{label}</label>
                    <input type="number" min="0" step={step} value={val} onChange={(e) => set(e.target.value)} placeholder={ph}
                      style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'advanced' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 340, overflowY: 'auto', paddingRight: 4 }}>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Power knobs, written to the same .cascade/config.json the CLI uses. Hover a label for what it does.
              </p>
              <AdvGroup title="Autonomy & approvals">
                <AdvSelect label="Autonomy" hint="auto = hands-off: plan gate and non-dangerous tools auto-approve; dangerous tools still ask" value={adv.autonomy} options={['manual', 'auto']} onChange={(v) => setAdvField('autonomy', v as AdvancedSettings['autonomy'])} />
                <AdvSelect label="Plan approval" hint="When to pause for the boardroom plan review before workers spawn" value={adv.planApproval} options={['never', 'complex', 'all', 'always']} onChange={(v) => setAdvField('planApproval', v as AdvancedSettings['planApproval'])} />
                <AdvNumber label="Approval timeout (s)" hint="Seconds to wait on a tool-approval decision before DENYING for safety" value={adv.approvalTimeoutMs / 1000} onChange={(n) => setAdvField('approvalTimeoutMs', Math.round(n * 1000))} />
              </AdvGroup>
              <AdvGroup title="Execution">
                <AdvSelect label="T3 execution" hint="Run workers within a wave in parallel or sequentially (auto = sequential on local models)" value={adv.t3Execution} options={['auto', 'parallel', 'sequential']} onChange={(v) => setAdvField('t3Execution', v as AdvancedSettings['t3Execution'])} />
                <AdvNumber label="Local concurrency" hint="Max concurrent local-model inferences (1 for a single GPU)" value={adv.localConcurrency} onChange={(n) => setAdvField('localConcurrency', Math.max(1, Math.round(n)))} />
                <AdvNumber label="Local timeout (s)" hint="Timeout for one local-model call" value={adv.localInferenceTimeoutMs / 1000} onChange={(n) => setAdvField('localInferenceTimeoutMs', Math.round(n * 1000))} />
                <AdvNumber label="Cloud timeout (s)" hint="Timeout for one cloud-model call" value={adv.cloudInferenceTimeoutMs / 1000} onChange={(n) => setAdvField('cloudInferenceTimeoutMs', Math.round(n * 1000))} />
                <AdvToggle label="Reflection" hint="Self-critique pass revising a worker's output against the goal (extra calls)" value={adv.reflectionEnabled} onChange={(v) => setAdvField('reflectionEnabled', v)} />
              </AdvGroup>
              <AdvGroup title="Routing">
                <AdvToggle label="Cascade Auto" hint="Pick the best-value model per task from live benchmarks + pricing" value={adv.cascadeAuto} onChange={(v) => setAdvField('cascadeAuto', v)} />
                <AdvSelect label="Force tier" hint="Pin every run's root tier, bypassing the complexity classifier" value={adv.forceTier} options={['auto', 'T1', 'T2', 'T3']} onChange={(v) => setAdvField('forceTier', v as AdvancedSettings['forceTier'])} />
                <AdvToggle label="Live benchmarks" hint="Refresh public benchmark scores + prices from the network" value={adv.benchmarksLive} onChange={(v) => setAdvField('benchmarksLive', v)} />
              </AdvGroup>
              <AdvGroup title="Sandbox & knowledge">
                <AdvSelect label="Dynamic-tool sandbox" hint="isolate = hard V8 isolate (no Node globals); worker = thread sandbox; auto = isolate when available" value={adv.dynamicToolSandbox} options={['auto', 'isolate', 'worker']} onChange={(v) => setAdvField('dynamicToolSandbox', v as AdvancedSettings['dynamicToolSandbox'])} />
                <AdvToggle label="Facts extraction" hint="Distill worker outputs into the queryable project knowledge graph" value={adv.factsExtraction} onChange={(v) => setAdvField('factsExtraction', v)} />
                <AdvToggle label="Tool creation" hint="Let workers generate new tools at runtime when none fits" value={adv.enableToolCreation} onChange={(v) => setAdvField('enableToolCreation', v)} />
                <AdvToggle label="Persist dynamic tools" hint="Reload created tools next run (always as untrusted)" value={adv.persistDynamicTools} onChange={(v) => setAdvField('persistDynamicTools', v)} />
              </AdvGroup>
              <AdvGroup title="Telemetry">
                <AdvToggle label="Telemetry" hint="Anonymous usage analytics (off by default)" value={adv.telemetryEnabled} onChange={(v) => setAdvField('telemetryEnabled', v)} />
              </AdvGroup>
            </div>
          )}

          {tab === 'data' && (
            <>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                Export your chats — optionally with memories (the project knowledge the AI has learned, plus your identities) — as a portable JSON bundle.
                Bundles are <b>plaintext</b> (knowledge is decrypted for portability); treat the file like private data. API keys are never included.
                Importing never overwrites: chats come in as new sessions, newer facts win, existing identities are kept.
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={includeMemories} onChange={(e) => setIncludeMemories(e.target.checked)} />
                Include memories (knowledge graph + identities)
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={async () => {
                  setDataStatus('Exporting…');
                  try {
                    const res = await fetch(`http://localhost:${backendPort}/api/export?sessions=all${includeMemories ? '&memories=1' : ''}`, {
                      headers: { Authorization: `Bearer ${authToken}` },
                    });
                    if (!res.ok) throw new Error(`export failed (HTTP ${res.status})`);
                    const bundle = await res.text();
                    const name = `cascade-export-${new Date().toISOString().slice(0, 10)}.json`;
                    const saveRes = await window.cascade?.saveJson?.(name, bundle);
                    setDataStatus(saveRes?.ok ? `Exported to ${saveRes.path}` : saveRes?.canceled ? '' : `Save failed: ${saveRes?.error ?? 'unknown'}`);
                  } catch (err) {
                    setDataStatus(err instanceof Error ? err.message : String(err));
                  }
                }} style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '9px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                  Export all chats…
                </button>
                <button onClick={async () => {
                  setDataStatus('');
                  try {
                    const open = await window.cascade?.openJson?.();
                    if (!open?.ok || !open.content) { if (!open?.canceled) setDataStatus(open?.error ?? 'Could not read the file.'); return; }
                    setDataStatus('Importing…');
                    const res = await fetch(`http://localhost:${backendPort}/api/import`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                      body: open.content,
                    });
                    const out = await res.json() as { ok?: boolean; error?: string; imported?: { sessions: number; facts: number; logEntries: number; identities: number } };
                    if (!res.ok || !out.ok) throw new Error(out.error ?? `import failed (HTTP ${res.status})`);
                    const i = out.imported!;
                    setDataStatus(`Imported ${i.sessions} chat${i.sessions === 1 ? '' : 's'}${i.facts || i.logEntries ? `, ${i.facts} facts, ${i.logEntries} log entries` : ''}${i.identities ? `, ${i.identities} identities` : ''}.`);
                  } catch (err) {
                    setDataStatus(err instanceof Error ? err.message : String(err));
                  }
                }} style={{ flex: 1, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '9px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                  Import…
                </button>
              </div>
              {dataStatus && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, wordBreak: 'break-all' }}>{dataStatus}</p>}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
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

// ── Advanced-tab building blocks ────────────────────────────────────────────

function AdvGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function AdvRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div title={hint} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 12, flex: 1, cursor: 'help' }}>{label}</span>
      {children}
    </div>
  );
}

function AdvSelect({ label, hint, value, options, onChange }: { label: string; hint: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <AdvRow label={label} hint={hint}>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '4px 8px', fontSize: 12, outline: 'none', minWidth: 110 }}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </AdvRow>
  );
}

function AdvNumber({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (n: number) => void }) {
  return (
    <AdvRow label={label} hint={hint}>
      <input type="number" value={Number.isFinite(value) ? value : ''} min={0}
        onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) onChange(n); }}
        style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '4px 8px', fontSize: 12, outline: 'none', width: 110, boxSizing: 'border-box' }} />
    </AdvRow>
  );
}

function AdvToggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <AdvRow label={label} hint={hint}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} style={{ cursor: 'pointer' }} />
    </AdvRow>
  );
}
