import { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { X } from 'lucide-react';
import { useAppDispatch } from '../store/index.js';
import { setShowSettings } from '../store/index.js';

type Tab = 'keys' | 'models' | 'budget';
type Bias = 'balanced' | 'quality' | 'cost';

const MODEL_OPTIONS = [
  'auto',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001',
  'gpt-4o',
  'gpt-4o-mini',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
];

interface Props { socket: Socket | null }

export function SettingsView({ socket }: Props) {
  const dispatch = useAppDispatch();
  const [tab, setTab] = useState<Tab>('keys');

  // API keys
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [googleKey, setGoogleKey] = useState('');

  // Model defaults
  const [t1Model, setT1Model] = useState('auto');
  const [t2Model, setT2Model] = useState('auto');
  const [t3Model, setT3Model] = useState('auto');

  // Budget
  const [maxCost, setMaxCost] = useState('');
  const [bias, setBias] = useState<Bias>('balanced');

  const [saved, setSaved] = useState(false);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch(setShowSettings(false)); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  const save = () => {
    if (!socket) return;
    socket.emit('config:update', {
      keys: { anthropic: anthropicKey || undefined, openai: openaiKey || undefined, google: googleKey || undefined },
      models: { t1: t1Model, t2: t2Model, t3: t3Model },
      budget: { maxCostPerRun: maxCost ? parseFloat(maxCost) : undefined, autoBias: bias },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={() => dispatch(setShowSettings(false))}>
      <div style={{
        width: 480, background: 'var(--bg-surface)',
        border: '1px solid var(--border)', borderRadius: 10,
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        overflow: 'hidden',
      }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, flex: 1 }}>Settings</span>
          <button onClick={() => dispatch(setShowSettings(false))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 18px' }}>
          {(['keys', 'models', 'budget'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '10px 14px',
              fontSize: 12, fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1, transition: 'color 0.12s',
            }}>
              {t === 'keys' ? 'API Keys' : t === 'models' ? 'Models' : 'Budget & Bias'}
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
                { label: 'Anthropic', val: anthropicKey, set: setAnthropicKey, placeholder: 'sk-ant-…' },
                { label: 'OpenAI', val: openaiKey, set: setOpenaiKey, placeholder: 'sk-…' },
                { label: 'Google', val: googleKey, set: setGoogleKey, placeholder: 'AIza…' },
              ].map(({ label, val, set, placeholder }) => (
                <div key={label}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{label}</label>
                  <input type="password" value={val} onChange={(e) => set(e.target.value)} placeholder={placeholder}
                    style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />
                </div>
              ))}
            </>
          )}

          {tab === 'models' && (
            <>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Set a default model per tier. <code>auto</code> lets Cascade Auto pick the best model dynamically.
              </p>
              {([['T1 (Planner)', t1Model, setT1Model], ['T2 (Manager)', t2Model, setT2Model], ['T3 (Worker)', t3Model, setT3Model]] as const).map(([label, val, set]) => (
                <div key={label}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{label}</label>
                  <select value={val} onChange={(e) => set(e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '7px 10px', fontSize: 12, outline: 'none' }}>
                    {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              ))}
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
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={() => dispatch(setShowSettings(false))} style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text-muted)', padding: '7px 16px', fontSize: 12, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={save} style={{
            background: saved ? 'var(--accent-dim)' : 'var(--accent)',
            border: 'none', borderRadius: 6, color: '#fff',
            padding: '7px 20px', fontSize: 12, cursor: 'pointer', transition: 'background 0.15s',
          }}>{saved ? '✔ Saved' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
