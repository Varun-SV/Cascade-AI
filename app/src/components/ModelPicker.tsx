import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Plus } from 'lucide-react';

export interface ModelOption { provider: string; id: string; label: string }

// Built-in cloud quick-picks. Shown as a fallback when no live models are
// discovered (e.g. the backend can't be reached); the live list from the
// embedded router is preferred when available.
export const MODELS: ModelOption[] = [
  { provider: 'auto',      id: 'auto',                     label: 'Auto (best model)' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6' },
  { provider: 'anthropic', id: 'claude-opus-4-8',          label: 'Claude Opus 4.8' },
  { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { provider: 'openai',    id: 'gpt-4o',                   label: 'GPT-4o' },
  { provider: 'openai',    id: 'gpt-4o-mini',              label: 'GPT-4o Mini' },
  { provider: 'google',    id: 'gemini-2.0-flash',         label: 'Gemini 2.0 Flash' },
  { provider: 'ollama',    id: 'llama3.2',                 label: 'Llama 3.2 (Ollama)' },
  { provider: 'ollama',    id: 'qwen2.5',                  label: 'Qwen 2.5 (Ollama)' },
  { provider: 'ollama',    id: 'mistral',                  label: 'Mistral (Ollama)' },
];

const PROVIDER_COLORS: Record<string, string> = {
  auto:                '#7c6af7',
  anthropic:           '#e8784b',
  openai:              '#74aa9c',
  gemini:              '#4285f4',
  google:              '#4285f4',
  groq:                '#f55036',
  ollama:              '#56b6c2',
  'openai-compatible': '#e0a458',
  azure:               '#0078d4',
};

interface Props {
  /** Currently-selected model id ('auto' or a concrete id). */
  value: string;
  onChange: (id: string) => void;
}

// A label for a model id: prefer a known cloud label, else show the raw id
// (which for local models is the tag / .gguf the user configured).
function labelFor(id: string): string {
  if (id === 'auto' || !id) return 'Auto (best model)';
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

export function ModelPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [dynamic, setDynamic] = useState<ModelOption[] | null>(null);
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Fetch the user's real available models once, lazily on first open.
  useEffect(() => {
    if (!open || dynamic !== null) return;
    let cancelled = false;
    window.cascade?.listModels?.()
      .then((res) => {
        if (cancelled) return;
        const opts = (res?.models ?? []).map((m) => ({ provider: m.provider, id: m.id, label: m.id }));
        setDynamic(opts);
      })
      .catch(() => { if (!cancelled) setDynamic([]); });
    return () => { cancelled = true; };
  }, [open, dynamic]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Live models when discovered, otherwise the built-in cloud quick-picks.
  // 'auto' is always offered first.
  const discovered = dynamic && dynamic.length > 0 ? dynamic : MODELS.filter((m) => m.id !== 'auto');
  const grouped = discovered.reduce<Record<string, ModelOption[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  const applyCustom = () => {
    const id = custom.trim();
    if (!id) return;
    onChange(id);
    setCustom('');
    setOpen(false);
  };

  const selectedColor = PROVIDER_COLORS[MODELS.find((m) => m.id === value)?.provider
    ?? (value === 'auto' ? 'auto' : discovered.find((m) => m.id === value)?.provider ?? '')] ?? '#888';

  return (
    <div ref={ref} className="model-picker" style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
          fontSize: 12, color: 'var(--text)', maxWidth: 260,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: selectedColor }} />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelFor(value)}</span>
        <ChevronDown size={10} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 4, minWidth: 240, maxWidth: 'min(340px, 90vw)', zIndex: 200,
          boxShadow: 'var(--shadow-2)', maxHeight: 320, overflowY: 'auto',
        }}>
          {/* Auto */}
          <Item color={PROVIDER_COLORS.auto} label="Auto (best model)" active={value === 'auto' || !value} onClick={() => { onChange('auto'); setOpen(false); }} />

          {dynamic === null && (
            <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)' }}>Loading models…</div>
          )}

          {Object.entries(grouped).map(([provider, models]) => (
            <div key={provider}>
              <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>
                {provider}
              </div>
              {models.map((m) => (
                <Item key={m.id} color={PROVIDER_COLORS[m.provider] ?? '#888'} label={m.label} active={m.id === value} onClick={() => { onChange(m.id); setOpen(false); }} />
              ))}
            </div>
          ))}

          {/* Free-text custom model id — always available (works offline, and for
              any local model / .gguf path not in the discovered list). */}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 6 }}>
            <div style={{ padding: '0 8px 4px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>
              Custom
            </div>
            <div style={{ display: 'flex', gap: 6, padding: '0 6px 4px' }}>
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyCustom(); }}
                placeholder="model id or .gguf path"
                style={{ flex: 1, minWidth: 0, background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', padding: '5px 8px', fontSize: 12, outline: 'none' }}
              />
              <button onClick={applyCustom} title="Use this model" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', cursor: 'pointer' }}>
                <Plus size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Item({ color, label, active, onClick }: { color: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 8px',
        background: active ? 'var(--bg-hover)' : 'transparent',
        border: 'none', borderRadius: 5, cursor: 'pointer',
        fontSize: 12, color: 'var(--text)', textAlign: 'left',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = active ? 'var(--bg-hover)' : 'transparent'; }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: color }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}
