import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Send, Network } from 'lucide-react';
import { AgentGraph } from '../components/AgentGraph.js';
import { HelpButton } from '../help/HelpButton.js';
import { useAppSelector } from '../store/index.js';

const TIERS: { id: string; label: string; color: string }[] = [
  { id: 'T1', label: 'Planner', color: 'var(--t1)' },
  { id: 'T2', label: 'Manager', color: 'var(--t2)' },
  { id: 'T3', label: 'Worker',  color: 'var(--t3)' },
];

export function CockpitView({ socket }: { socket: Socket | null }) {
  const [prompt, setPrompt] = useState('');
  const [focused, setFocused] = useState(false);
  const agents = useAppSelector((s) => s.app.agents);

  const submit = () => {
    if (!prompt.trim() || !socket) return;
    socket.emit('cascade:run', { prompt });
    setPrompt('');
  };

  const canSend = !!prompt.trim() && !!socket;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        height: 35, padding: '0 16px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <Network size={14} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '-0.1px' }}>Mission Control</span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 12, marginRight: 4 }}>
          {TIERS.map((t) => (
            <span key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-muted)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.color }} />
              <b style={{ color: t.color, fontWeight: 700 }}>{t.id}</b> {t.label}
            </span>
          ))}
        </div>
        <HelpButton context="cockpit" />
      </div>

      {/* Agent graph area with dot-grid background */}
      <div className="agent-graph" style={{
        flex: 1, overflow: 'hidden', position: 'relative',
        backgroundImage: 'radial-gradient(circle, var(--border-strong) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
        backgroundColor: 'var(--bg-base)',
      }}>
        {agents.length === 0 ? (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 14, color: 'var(--text-muted)',
            animation: 'fadeIn 0.3s var(--ease)',
          }}>
            <div style={{
              width: 64, height: 64, borderRadius: 'var(--radius-lg)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent-soft)', color: 'var(--accent)',
              boxShadow: 'var(--glow-accent)',
            }}>
              <Network size={28} />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>No agents running</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Describe a task below to watch the tier hierarchy spawn.</div>
            </div>
          </div>
        ) : (
          <AgentGraph agents={agents} />
        )}
      </div>

      {/* Task input bar */}
      <div className="task-input-bar" style={{
        height: 50, padding: '0 12px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Describe the task for Cascade…  (Enter · Shift+Enter for newline)"
          rows={1}
          style={{
            flex: 1, resize: 'none', background: 'var(--bg-overlay)',
            border: `1px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text)', padding: '6px 10px', fontSize: 12.5,
            fontFamily: 'inherit', outline: 'none', lineHeight: 1.5,
            boxShadow: focused ? 'var(--glow-accent)' : 'none',
            transition: 'border-color var(--dur), box-shadow var(--dur)',
          }}
        />
        <button
          onClick={submit}
          disabled={!canSend}
          title="Submit task"
          style={{
            width: 30, height: 30,
            background: canSend ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
            color: canSend ? '#fff' : 'var(--text-dim)',
            border: canSend ? 'none' : '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            cursor: canSend ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            transition: 'background var(--dur), transform var(--dur)',
          }}
          onMouseEnter={(e) => { if (canSend) (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'none'; }}
        >
          <Send size={13} />
        </button>
      </div>
    </div>
  );
}
