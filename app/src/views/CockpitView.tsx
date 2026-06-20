import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Send } from 'lucide-react';
import { AgentGraph } from '../components/AgentGraph.js';
import { HelpButton } from '../help/HelpButton.js';
import { useAppSelector } from '../store/index.js';

export function CockpitView({ socket }: { socket: Socket | null }) {
  const [prompt, setPrompt] = useState('');
  const agents = useAppSelector((s) => s.app.agents);

  const submit = () => {
    if (!prompt.trim() || !socket) return;
    socket.emit('cascade:run', { prompt });
    setPrompt('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Mission Control</span>
        <div style={{ flex: 1 }} />
        <HelpButton context="cockpit" />
      </div>

      {/* Agent graph */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {agents.length === 0 ? (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 8, color: 'var(--text-muted)',
          }}>
            <span style={{ fontSize: 40 }}>⚡</span>
            <span style={{ fontSize: 14 }}>Submit a task to watch agents spawn</span>
          </div>
        ) : (
          <AgentGraph agents={agents} />
        )}
      </div>

      {/* Task input */}
      <div style={{
        padding: 12, borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        display: 'flex', gap: 8,
      }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Describe the task for Cascade… (Enter to submit, Shift+Enter for newline)"
          rows={2}
          style={{
            flex: 1, resize: 'none', background: 'var(--bg-raised)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            color: 'var(--text)', padding: '8px 12px', fontSize: 13,
            fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button
          onClick={submit}
          disabled={!prompt.trim() || !socket}
          style={{
            width: 40, height: 40, alignSelf: 'flex-end',
            background: prompt.trim() && socket ? 'var(--accent)' : 'var(--bg-raised)',
            color: prompt.trim() && socket ? '#fff' : 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            cursor: prompt.trim() && socket ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s',
          }}
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
