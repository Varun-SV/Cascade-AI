import { useState } from 'react';
import { KeyRound, Plus, Trash2, ShieldCheck } from 'lucide-react';
import type { ProviderConfig, ProviderType } from '../lib/types.js';

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

interface Props {
  keys: ProviderConfig[];
  onChange: (keys: ProviderConfig[]) => void;
}

export default function KeyVault({ keys, onChange }: Props) {
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
    <div className="flex flex-col gap-3 p-4 text-sm text-cascade-100">
      <div className="flex items-center gap-2 text-cascade-200">
        <ShieldCheck size={16} className="text-cascade-400" />
        <p className="text-xs leading-snug text-cascade-300">
          Your API keys stay in this browser's storage and are sent only with each run you start —
          Cascade Cloud never stores them on our servers.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {keys.length === 0 && (
          <p className="rounded-md border border-dashed border-cascade-800 px-3 py-4 text-center text-xs text-cascade-400">
            No providers configured yet. Add one to start chatting.
          </p>
        )}
        {keys.map((k, i) => (
          <div key={i} className="flex items-center justify-between rounded-md bg-cascade-950/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <KeyRound size={14} className="text-cascade-400" />
              <div>
                <div className="font-medium text-cascade-100">{labelFor(k)}</div>
                <div className="text-xs text-cascade-400">{summaryFor(k)}</div>
              </div>
            </div>
            <button
              type="button"
              aria-label={`Remove ${labelFor(k)}`}
              onClick={() => removeKey(i)}
              className="rounded p-1 text-cascade-400 hover:bg-cascade-900 hover:text-red-400"
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
          className="flex items-center justify-center gap-1 rounded-md border border-cascade-700 px-3 py-2 text-xs font-medium text-cascade-200 hover:bg-cascade-900"
        >
          <Plus size={14} /> Add provider
        </button>
      )}

      {adding && (
        <div className="flex flex-col gap-2 rounded-md border border-cascade-800 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-cascade-400">Provider</span>
            <select
              className="rounded bg-cascade-950 px-2 py-1.5 text-sm"
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
              <span className="text-xs text-cascade-400">API key</span>
              <input
                type="password"
                className="rounded bg-cascade-950 px-2 py-1.5 text-sm"
                value={draft.apiKey ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                placeholder="sk-..."
              />
            </label>
          )}

          {(draft.type === 'azure' || draft.type === 'openai-compatible') && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-cascade-400">
                {draft.type === 'azure' ? 'Azure endpoint URL' : 'Endpoint base URL'}
              </span>
              <input
                className="rounded bg-cascade-950 px-2 py-1.5 text-sm"
                value={draft.baseUrl ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                placeholder="https://..."
              />
            </label>
          )}

          {draft.type === 'openai-compatible' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-cascade-400">API key (optional)</span>
              <input
                type="password"
                className="rounded bg-cascade-950 px-2 py-1.5 text-sm"
                value={draft.apiKey ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              />
            </label>
          )}

          {draft.type === 'azure' && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-cascade-400">Deployment name</span>
                <input
                  className="rounded bg-cascade-950 px-2 py-1.5 text-sm"
                  value={draft.deploymentName ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, deploymentName: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-cascade-400">API version (optional)</span>
                <input
                  className="rounded bg-cascade-950 px-2 py-1.5 text-sm"
                  value={draft.apiVersion ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, apiVersion: e.target.value }))}
                  placeholder="2024-08-01-preview"
                />
              </label>
            </>
          )}

          {(draft.type === 'openai' || draft.type === 'anthropic' || draft.type === 'gemini' || draft.type === 'openai-compatible') && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-cascade-400">Model (optional — leave blank for auto)</span>
              <input
                className="rounded bg-cascade-950 px-2 py-1.5 text-sm"
                value={draft.model ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              />
            </label>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={addKey}
              className="flex-1 rounded-md bg-cascade-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cascade-500"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setDraft({ type: 'anthropic' }); }}
              className="rounded-md border border-cascade-700 px-3 py-1.5 text-xs text-cascade-300 hover:bg-cascade-900"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
