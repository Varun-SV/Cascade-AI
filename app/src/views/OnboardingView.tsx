import { useState } from 'react';
import { Check, Eye, EyeOff, ChevronRight, FolderOpen } from 'lucide-react';
import { useAppDispatch, setOnboardingDone, setWorkspacePath } from '../store/index.js';

type Step = 'welcome' | 'provider' | 'apikey' | 'workspace' | 'done';

interface Provider {
  id: string;
  name: string;
  description: string;
  keyPlaceholder: string;
}

const PROVIDERS: Provider[] = [
  { id: 'openai',    name: 'OpenAI',     description: 'GPT-4o, o1, o3 models',          keyPlaceholder: 'sk-...' },
  { id: 'anthropic', name: 'Anthropic',  description: 'Claude 3.5/4 models',             keyPlaceholder: 'sk-ant-...' },
  { id: 'google',    name: 'Google',     description: 'Gemini 2.0 Flash, Pro models',    keyPlaceholder: 'AIza...' },
  { id: 'groq',      name: 'Groq',       description: 'Ultra-fast inference',             keyPlaceholder: 'gsk_...' },
  { id: 'ollama',    name: 'Ollama',     description: 'Local models, no key needed',     keyPlaceholder: '(local)' },
];

export function OnboardingView() {
  const dispatch = useAppDispatch();
  const [step, setStep] = useState<Step>('welcome');
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [saving, setSaving] = useState(false);

  const handleVerify = async () => {
    if (!selectedProvider || (!apiKey && selectedProvider.id !== 'ollama')) return;
    setVerifying(true);
    setVerifyError('');
    try {
      if (window.cascade?.setConfig) {
        await window.cascade.setConfig({ provider: selectedProvider.id, apiKey, workspace: workspace || '' });
      }
      setStep('workspace');
    } catch (err) {
      setVerifyError(String(err));
    } finally {
      setVerifying(false);
    }
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      if (window.cascade?.setConfig) {
        await window.cascade.setConfig({ provider: selectedProvider?.id ?? '', apiKey, workspace });
      }
    } catch { /* ignore */ }
    dispatch(setWorkspacePath(workspace));
    setStep('done');
    setTimeout(() => dispatch(setOnboardingDone(true)), 1200);
    setSaving(false);
  };

  const browseWorkspace = async () => {
    // Use Electron dialog via preload if available; otherwise use a typed input
    if ((window as unknown as { cascade?: { selectDirectory?: () => Promise<string> } }).cascade?.selectDirectory) {
      const dir = await (window as unknown as { cascade: { selectDirectory: () => Promise<string> } }).cascade.selectDirectory();
      if (dir) setWorkspace(dir);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--bg-base)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 0,
      animation: 'fadeIn 0.4s var(--ease)',
      zIndex: 1000,
    }}>
      {/* Logo */}
      <div style={{ marginBottom: 32, textAlign: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, margin: '0 auto 16px',
          background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28, color: '#fff',
          boxShadow: 'var(--glow-accent)',
        }}>◈</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.4px' }}>
          {step === 'welcome'   && 'Welcome to Cascade AI'}
          {step === 'provider'  && 'Choose your AI provider'}
          {step === 'apikey'    && `Set up ${selectedProvider?.name ?? 'provider'}`}
          {step === 'workspace' && 'Choose your workspace'}
          {step === 'done'      && 'You\'re all set!'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
          {step === 'welcome'   && 'Multi-tier AI orchestration for complex tasks'}
          {step === 'provider'  && 'Cascade uses T1/T2/T3 agents from any provider'}
          {step === 'apikey'    && 'Your key is stored securely in the system keychain'}
          {step === 'workspace' && 'The default directory for new tasks'}
          {step === 'done'      && 'Cascade is ready — launching your workspace…'}
        </div>
      </div>

      {/* Card */}
      <div style={{
        width: 480, background: 'var(--bg-surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        padding: 28, boxShadow: 'var(--shadow-2)',
      }}>
        {/* Step: welcome */}
        {step === 'welcome' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              ['T1 Planner', 'var(--t1)', 'Decomposes your goal into a high-level plan'],
              ['T2 Manager', 'var(--t2)', 'Assigns tasks to specialist agents'],
              ['T3 Workers', 'var(--t3)', 'Execute tasks in parallel — code, search, write'],
            ].map(([name, color, desc]) => (
              <div key={name} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <span style={{
                  fontSize: 9, fontWeight: 800, color, padding: '2px 6px', borderRadius: 4,
                  background: `color-mix(in srgb, ${color} 14%, transparent)`,
                  marginTop: 1, flexShrink: 0,
                }}>{name}</span>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{desc}</span>
              </div>
            ))}
            <button
              onClick={() => setStep('provider')}
              style={{
                marginTop: 8, padding: '10px 0', width: '100%',
                background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
                border: 'none', borderRadius: 'var(--radius-md)',
                color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              Get started <ChevronRight size={14} />
            </button>
          </div>
        )}

        {/* Step: provider select */}
        {step === 'provider' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {PROVIDERS.map((p) => (
              <div
                key={p.id}
                onClick={() => setSelectedProvider(p)}
                style={{
                  padding: '10px 14px', borderRadius: 'var(--radius-md)',
                  border: `1px solid ${selectedProvider?.id === p.id ? 'var(--accent)' : 'var(--border)'}`,
                  background: selectedProvider?.id === p.id ? 'var(--accent-soft)' : 'var(--bg-raised)',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 12,
                  transition: 'border-color var(--dur), background var(--dur)',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{p.description}</div>
                </div>
                {selectedProvider?.id === p.id && <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
              </div>
            ))}
            <button
              onClick={() => selectedProvider && setStep('apikey')}
              disabled={!selectedProvider}
              style={{
                marginTop: 8, padding: '10px 0', width: '100%',
                background: selectedProvider ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
                border: selectedProvider ? 'none' : '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                color: selectedProvider ? '#fff' : 'var(--text-dim)',
                fontSize: 13, fontWeight: 600, cursor: selectedProvider ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              Continue <ChevronRight size={14} />
            </button>
          </div>
        )}

        {/* Step: API key */}
        {step === 'apikey' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {selectedProvider?.id !== 'ollama' && (
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>
                  API Key for {selectedProvider?.name}
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={selectedProvider?.keyPlaceholder}
                    autoFocus
                    style={{
                      width: '100%', padding: '9px 36px 9px 12px',
                      background: 'var(--bg-raised)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)', color: 'var(--text)',
                      fontSize: 13, fontFamily: 'var(--font-mono)', outline: 'none',
                    }}
                    onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = 'var(--accent)'; }}
                    onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = 'var(--border)'; }}
                  />
                  <button
                    onClick={() => setShowKey((v) => !v)}
                    style={{
                      position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-dim)', display: 'flex',
                    }}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            )}
            {selectedProvider?.id === 'ollama' && (
              <div style={{ padding: '12px 14px', background: 'var(--success-soft)', borderRadius: 'var(--radius-md)', border: '1px solid var(--success)', fontSize: 12.5, color: 'var(--text-muted)' }}>
                Ollama runs locally — no API key needed. Make sure Ollama is running on port 11434.
              </div>
            )}
            {verifyError && (
              <div style={{ fontSize: 12, color: 'var(--danger)', background: 'var(--danger-soft)', padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--danger)' }}>
                {verifyError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setStep('provider')}
                style={{
                  padding: '9px 16px', background: 'transparent',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                  color: 'var(--text-muted)', fontSize: 12.5, cursor: 'pointer',
                }}
              >
                Back
              </button>
              <button
                onClick={handleVerify}
                disabled={verifying || (!apiKey && selectedProvider?.id !== 'ollama')}
                style={{
                  flex: 1, padding: '9px 0',
                  background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  color: '#fff', fontSize: 13, fontWeight: 600,
                  cursor: verifying ? 'default' : 'pointer',
                  opacity: verifying ? 0.7 : 1,
                }}
              >
                {verifying ? 'Saving…' : 'Save & continue'}
              </button>
            </div>
          </div>
        )}

        {/* Step: workspace */}
        {step === 'workspace' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>
                Default workspace directory
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="/Users/you/projects"
                  style={{
                    flex: 1, padding: '9px 12px',
                    background: 'var(--bg-raised)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)', color: 'var(--text)',
                    fontSize: 13, fontFamily: 'var(--font-mono)', outline: 'none',
                  }}
                  onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = 'var(--border)'; }}
                />
                <button
                  onClick={browseWorkspace}
                  title="Browse…"
                  style={{
                    padding: '9px 12px', background: 'var(--bg-raised)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                    color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center',
                  }}
                >
                  <FolderOpen size={14} />
                </button>
              </div>
              <button
                onClick={() => setWorkspace(window.navigator.userAgent.includes('Win') ? 'C:\\Users' : (process?.env?.HOME ?? '/home'))}
                style={{
                  marginTop: 6, background: 'none', border: 'none',
                  color: 'var(--accent)', fontSize: 11.5, cursor: 'pointer', padding: 0,
                }}
              >
                Use home directory
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setStep('apikey')}
                style={{
                  padding: '9px 16px', background: 'transparent',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                  color: 'var(--text-muted)', fontSize: 12.5, cursor: 'pointer',
                }}
              >
                Back
              </button>
              <button
                onClick={handleFinish}
                disabled={saving}
                style={{
                  flex: 1, padding: '9px 0',
                  background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                {saving ? 'Saving…' : <>Open Cascade <ChevronRight size={14} /></>}
              </button>
            </div>
            <div style={{ textAlign: 'center' }}>
              <button
                onClick={handleFinish}
                style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 11.5, cursor: 'pointer' }}
              >
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* Step: done */}
        {step === 'done' && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%', margin: '0 auto 14px',
              background: 'var(--success-soft)', border: '2px solid var(--success)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Check size={22} style={{ color: 'var(--success)' }} />
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Launching Cascade…</div>
          </div>
        )}
      </div>

      {/* Step indicator */}
      {step !== 'done' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
          {(['welcome', 'provider', 'apikey', 'workspace'] as Step[]).map((s) => (
            <span key={s} style={{
              width: 6, height: 6, borderRadius: '50%',
              background: s === step ? 'var(--accent)' : 'var(--text-dim)',
              transition: 'background var(--dur)',
            }} />
          ))}
        </div>
      )}
    </div>
  );
}
