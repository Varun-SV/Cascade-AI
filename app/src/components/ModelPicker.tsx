import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

export interface ModelOption { provider: string; id: string; label: string }

export const MODELS: ModelOption[] = [
  { provider: 'auto',      id: 'auto',                    label: 'Auto (best model)' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6' },
  { provider: 'anthropic', id: 'claude-opus-4-8',          label: 'Claude Opus 4.8' },
  { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { provider: 'openai',    id: 'gpt-4o',                  label: 'GPT-4o' },
  { provider: 'openai',    id: 'gpt-4o-mini',             label: 'GPT-4o Mini' },
  { provider: 'openai',    id: 'o1',                      label: 'o1' },
  { provider: 'openai',    id: 'o3-mini',                 label: 'o3-mini' },
  { provider: 'google',    id: 'gemini-2.0-flash',        label: 'Gemini 2.0 Flash' },
  { provider: 'google',    id: 'gemini-2.0-pro',          label: 'Gemini 2.0 Pro' },
  { provider: 'groq',      id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)' },
  { provider: 'groq',      id: 'mixtral-8x7b-32768',      label: 'Mixtral 8×7B (Groq)' },
];

const PROVIDER_COLORS: Record<string, string> = {
  auto:      '#7c6af7',
  anthropic: '#e8784b',
  openai:    '#74aa9c',
  google:    '#4285f4',
  groq:      '#f55036',
};

interface Props {
  value?: ModelOption;
  onChange: (model: ModelOption) => void;
}

export function ModelPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = value ?? MODELS[0];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
          fontSize: 12, color: 'var(--text)',
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: PROVIDER_COLORS[selected.provider] ?? '#888',
        }} />
        <span>{selected.label}</span>
        <ChevronDown size={10} style={{ color: 'var(--text-muted)' }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 4, minWidth: 220, zIndex: 200,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          maxHeight: 280, overflowY: 'auto',
        }}>
          {Object.entries(
            MODELS.reduce<Record<string, ModelOption[]>>((acc, m) => {
              (acc[m.provider] ??= []).push(m);
              return acc;
            }, {})
          ).map(([provider, models]) => (
            <div key={provider}>
              <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>
                {provider}
              </div>
              {models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { onChange(m); setOpen(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', padding: '5px 8px',
                    background: m.id === selected.id ? 'var(--bg-hover)' : 'transparent',
                    border: 'none', borderRadius: 5, cursor: 'pointer',
                    fontSize: 12, color: 'var(--text)', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = m.id === selected.id ? 'var(--bg-hover)' : 'transparent'; }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: PROVIDER_COLORS[m.provider] ?? '#888' }} />
                  {m.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
