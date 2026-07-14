import { useState } from 'react';
import { KeyRound, Plus, Trash2, ShieldCheck, Globe } from 'lucide-react';
import type { ProviderConfig, ProviderType, WebSearchSettings } from '../lib/types.js';
import DriveSyncPanel from './DriveSyncPanel.js';

// Local LLMs (Ollama) are out of v1 scope — a hosted page cannot reach a
// user's local network. Only cloud providers are offered here.
const SELECTABLE_TYPES: { value: Exclude<ProviderType, 'ollama'>; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'openai-compatible', label: 'OpenAI-compatible endpoint' },
];

function labelFor(p: ProviderConfig): string {
  if (p.label) return p.label;
  const found = SELECTABLE_TYPES.find((t) => t.value === p.type);
  return found?.label ?? p.type;
}

function summaryFor(p: ProviderConfig): string {
  if (p.type === 'azure') return p.deploymentName ? `deployment: ${p.deploymentName}` : 'no deployment set';
  if (p.type === 'openai-compatible') return p.baseUrl ?? 'no endpoint set';
  return p.model ? `model: ${p.model}` : 'default model';
}

const WEB_SEARCH_BACKENDS: { value: WebSearchSettings['backend']; label: string }[] = [
  { value: 'brave', label: 'Brave Search' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'searxng', label: 'SearXNG (self-hosted)' },
];

function WebSearchSection({
  settings,
  onChange,
}: {
  settings: WebSearchSettings | null;
  onChange: (s: WebSearchSettings | null) => void;
}) {
  const backend = settings?.backend ?? 'brave';
  const value =
    backend === 'brave' ? settings?.braveApiKey ?? ''
    : backend === 'tavily' ? settings?.tavilyApiKey ?? ''
    : settings?.searxngUrl ?? '';

  function update(patch: Partial<WebSearchSettings>) {
    onChange({ backend, braveApiKey: settings?.braveApiKey, tavilyApiKey: settings?.tavilyApiKey, searxngUrl: settings?.searxngUrl, ...patch });
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-white/10 p-3">
      <div className="flex items-center gap-2 text-ink-200">
        <Globe size={15} className="text-ink-400" />
        <span className="font-medium">Web search</span>
      </div>
      <p className="text-xs leading-snug text-ink-400">
        Optional. Configure a backend so the composer's <span className="text-ink-300">Web</span> toggle returns real
        results instead of the basic keyless fallback.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-400">Backend</span>
        <select
          aria-label="Web search backend"
          className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
          value={backend}
          onChange={(e) => update({ backend: e.target.value as WebSearchSettings['backend'] })}
        >
          {WEB_SEARCH_BACKENDS.map((b) => (
            <option key={b.value} value={b.value}>{b.label}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-400">{backend === 'searxng' ? 'SearXNG URL' : 'API key'}</span>
        <input
          type={backend === 'searxng' ? 'text' : 'password'}
          className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
          placeholder={backend === 'searxng' ? 'https://searx.example.com' : 'key…'}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (backend === 'brave') update({ braveApiKey: v });
            else if (backend === 'tavily') update({ tavilyApiKey: v });
            else update({ searxngUrl: v });
          }}
        />
      </label>
      {settings && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="self-start rounded-md border border-white/10 px-2.5 py-1 text-xs text-ink-300 hover:bg-white/[0.05] hover:text-danger-400"
        >
          Clear web search
        </button>
      )}
    </div>
  );
}

interface Props {
  keys: ProviderConfig[];
  onChange: (keys: ProviderConfig[]) => void;
  webSearch: WebSearchSettings | null;
  onWebSearchChange: (s: WebSearchSettings | null) => void;
  /** Only offered for Google-authenticated users with a Google OAuth client configured server-side. */
  driveSyncEnabled?: boolean;
  googleClientId?: string | null;
}

export default function KeyVault({ keys, onChange, webSearch, onWebSearchChange, driveSyncEnabled, googleClientId }: Props) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ProviderConfig>({ type: 'anthropic' });

  function addKey() {
    // A blank field submits as '' — normalize to "absent" so downstream
    // provider clients don't see a defined-but-empty apiKey/baseUrl/model
    // (some SDKs treat '' differently from undefined and error out).
    const cleaned: ProviderConfig = { type: draft.type };
    if (draft.label?.trim()) cleaned.label = draft.label.trim();
    if (draft.apiKey?.trim()) cleaned.apiKey = draft.apiKey.trim();
    if (draft.baseUrl?.trim()) cleaned.baseUrl = draft.baseUrl.trim();
    if (draft.deploymentName?.trim()) cleaned.deploymentName = draft.deploymentName.trim();
    if (draft.apiVersion?.trim()) cleaned.apiVersion = draft.apiVersion.trim();
    if (draft.model?.trim()) cleaned.model = draft.model.trim();

    onChange([...keys, cleaned]);
    setDraft({ type: 'anthropic' });
    setAdding(false);
  }

  function removeKey(index: number) {
    onChange(keys.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-col gap-3 p-4 text-sm text-ink-100">
      <div className="flex items-center gap-2 text-ink-200">
        <ShieldCheck size={16} className="text-ink-400" />
        <p className="text-xs leading-snug text-ink-300">
          Your API keys stay in this browser's storage and are sent only with each run you start —
          Cascade Cloud never stores them on our servers.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {keys.length === 0 && (
          <p className="rounded-md border border-dashed border-white/10 px-3 py-4 text-center text-xs text-ink-400">
            No providers configured yet. Add one to start chatting.
          </p>
        )}
        {keys.map((k, i) => (
          <div key={i} className="flex items-center justify-between rounded-md bg-white/[0.05] px-3 py-2">
            <div className="flex items-center gap-2">
              <KeyRound size={14} className="text-ink-400" />
              <div>
                <div className="font-medium text-ink-100">{labelFor(k)}</div>
                <div className="text-xs text-ink-400">{summaryFor(k)}</div>
              </div>
            </div>
            <button
              type="button"
              aria-label={`Remove ${labelFor(k)}`}
              onClick={() => removeKey(i)}
              className="rounded p-1 text-ink-400 hover:bg-white/10 hover:text-danger-500"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {!adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center justify-center gap-1 rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-ink-200 hover:bg-white/[0.05]"
        >
          <Plus size={14} /> Add provider
        </button>
      )}

      {adding && (
        <div className="flex flex-col gap-2 rounded-md border border-white/10 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-400">Provider</span>
            <select
              aria-label="Provider"
              className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
              value={draft.type}
              onChange={(e) => setDraft({ type: e.target.value as ProviderConfig['type'] })}
            >
              {SELECTABLE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>

          {draft.type !== 'openai-compatible' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-400">API key</span>
              <input
                type="password"
                className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
                value={draft.apiKey ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                placeholder="sk-..."
              />
            </label>
          )}

          {(draft.type === 'azure' || draft.type === 'openai-compatible') && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-400">
                {draft.type === 'azure' ? 'Azure endpoint URL' : 'Endpoint base URL'}
              </span>
              <input
                className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
                value={draft.baseUrl ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                placeholder="https://..."
              />
            </label>
          )}

          {draft.type === 'openai-compatible' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-400">API key (optional)</span>
              <input
                type="password"
                className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
                value={draft.apiKey ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              />
            </label>
          )}

          {draft.type === 'azure' && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-400">Deployment name</span>
                <input
                  className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
                  value={draft.deploymentName ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, deploymentName: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-400">API version (optional)</span>
                <input
                  className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
                  value={draft.apiVersion ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, apiVersion: e.target.value }))}
                  placeholder="2024-08-01-preview"
                />
              </label>
            </>
          )}

          {(draft.type === 'openai' || draft.type === 'anthropic' || draft.type === 'gemini' || draft.type === 'openai-compatible') && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-400">Model (optional — leave blank for auto)</span>
              <input
                className="rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink-100"
                value={draft.model ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              />
            </label>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={addKey}
              className="flex-1 rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-accent-400"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setDraft({ type: 'anthropic' }); }}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-ink-200 hover:bg-white/[0.05]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <WebSearchSection settings={webSearch} onChange={onWebSearchChange} />

      {driveSyncEnabled && googleClientId && (
        <DriveSyncPanel googleClientId={googleClientId} keys={keys} onRestore={onChange} />
      )}
    </div>
  );
}
