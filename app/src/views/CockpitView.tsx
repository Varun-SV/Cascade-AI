import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Send, Network, Eraser } from 'lucide-react';
import { AgentGraph } from '../components/AgentGraph.js';
import { NodeDetailPanel } from '../components/NodeDetailPanel.js';
import { HelpButton } from '../help/HelpButton.js';
import { useAppDispatch, useAppSelector, appendMessage, setForceTier, setSessionId, runStarted, dismissCompletedNodes } from '../store/index.js';

const TIERS: { id: string; label: string; color: string }[] = [
  { id: 'T1', label: 'Planner', color: 'var(--t1)' },
  { id: 'T2', label: 'Manager', color: 'var(--t2)' },
  { id: 'T3', label: 'Worker',  color: 'var(--t3)' },
];

export function CockpitView({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  const [prompt, setPrompt] = useState('');
  const [focused, setFocused] = useState(false);
  const [steerText, setSteerText] = useState('');
  const [steerAck, setSteerAck] = useState(false);
  const allAgents = useAppSelector((s) => s.app.agents);
  const dismissedNodeIds = useAppSelector((s) => s.app.dismissedNodeIds);
  const messages = useAppSelector((s) => s.app.messages);
  const { activeSessionId, sessionId, forceTier } = useAppSelector((s) => s.app);
  const currentSessionId = activeSessionId ?? sessionId;
  // Scope the graph to the session actually open — a brand-new chat has no
  // session id anything is tagged with yet (clean graph for free), and
  // switching back to an existing chat shows only its own nodes instead of
  // every node from every past run in this app instance.
  const agents = allAgents.filter((a) => a.sessionId === currentSessionId && !dismissedNodeIds.includes(a.id));
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const runActive = agents.some((a) => a.status === 'ACTIVE');
  const hasCleanableNodes = agents.some((a) => a.status === 'COMPLETED' || a.status === 'FAILED' || a.status === 'ESCALATED');

  const steer = () => {
    if (!steerText.trim() || !socket) return;
    // Server routes this into the running Cascade's guidance queue; workers
    // apply it at their next agent-loop step ("hijack a stuck worker").
    socket.emit('session:steer', { message: steerText.trim(), sessionId: activeSessionId ?? sessionId ?? undefined });
    setSteerText('');
    setSteerAck(true);
    setTimeout(() => setSteerAck(false), 3000);
  };

  const submit = () => {
    if (!prompt.trim() || !socket) return;
    const text = prompt.trim();
    // Mirror the prompt into the shared transcript so it's visible here (inline
    // below) AND in the Chat view, instead of vanishing after send.
    dispatch(appendMessage({ id: crypto.randomUUID(), role: 'user', content: text, timestamp: Date.now() }));
    dispatch(appendMessage({ id: crypto.randomUUID(), role: 'assistant', content: '', timestamp: Date.now(), streaming: true }));
    // Own a sessionId like ChatPanel.send() does — without one the run can't be
    // halted (session:halt needs it) and it never persists into the session list.
    let sid = sessionId;
    if (!sid) { sid = crypto.randomUUID(); dispatch(setSessionId(sid)); }
    socket.emit('cascade:run', { prompt: text, model: 'auto', sessionId: sid, ...(forceTier !== 'auto' ? { forceTier } : {}) });
    dispatch(runStarted({ sessionId: sid }));
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
        {hasCleanableNodes && (
          <button
            onClick={() => currentSessionId && dispatch(dismissCompletedNodes(currentSessionId))}
            title="Hide finished nodes from this session's graph"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              color: 'var(--text-muted)', padding: '4px 8px', fontSize: 10.5, cursor: 'pointer',
            }}
          >
            <Eraser size={11} /> Clean up session
          </button>
        )}
        <HelpButton context="cockpit" />
      </div>

      {/* Inline echo of the latest prompt so cockpit sends are never invisible. */}
      {lastUser && (
        <div style={{ padding: '6px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 11 }}>You</span>
          <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastUser.content}</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>· full reply in Chat</span>
        </div>
      )}

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
            flexDirection: 'column', padding: 24,
            animation: 'fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: 16, padding: '32px 40px',
              background: 'linear-gradient(145deg, rgba(var(--accent-rgb), 0.02), rgba(var(--accent-rgb), 0.08))',
              border: '1px solid rgba(var(--accent-rgb), 0.2)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.05), inset 0 1px 1px rgba(255,255,255,0.05)',
              backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            }}>
              <div style={{
                position: 'relative', width: 72, height: 72, borderRadius: '24px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: '#fff',
                boxShadow: '0 12px 24px rgba(var(--accent-rgb), 0.3), inset 0 2px 4px rgba(255,255,255,0.2)',
              }}>
                <div style={{
                  position: 'absolute', inset: -10, borderRadius: 'inherit',
                  background: 'var(--accent)', opacity: 0.2, filter: 'blur(16px)',
                  animation: 'pulse 3s ease-in-out infinite'
                }} />
                <Network size={34} style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))' }} />
              </div>
              <div style={{ textAlign: 'center', marginTop: 4 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 8, letterSpacing: '-0.3px' }}>Awaiting Assignment</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 280, lineHeight: 1.5 }}>Describe a task below to orchestrate the AI agent hierarchy and watch them work.</div>
              </div>
            </div>
          </div>
        ) : (
          <AgentGraph agents={agents} />
        )}
        <NodeDetailPanel />
      </div>

      {/* Live steering: visible while a run is active — inject a correction
          into the running workers without stopping the task. */}
      {runActive && (
        <div style={{
          padding: '6px 12px', borderTop: '1px solid var(--border)',
          background: 'var(--bg-base)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--warn)', flexShrink: 0 }}>Steer</span>
          <input
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); steer(); } }}
            placeholder="Correct the running workers…  (Enter to inject)"
            style={{
              flex: 1, background: 'var(--bg-overlay)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text)', padding: '4px 9px',
              fontSize: 11.5, outline: 'none',
            }}
          />
          {steerAck && <span style={{ fontSize: 10.5, color: 'var(--success)', flexShrink: 0 }}>✔ queued</span>}
        </div>
      )}

      {/* Task input bar */}
      <div className="task-input-bar" style={{
        height: 50, padding: '0 12px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
      }}>
        <select
          value={forceTier}
          onChange={(e) => dispatch(setForceTier(e.target.value as 'auto' | 'T1' | 'T2' | 'T3'))}
          title="Routing: Auto lets Cascade pick the tier; force T1 (full hierarchy), T2 (manager+workers), or T3 (single worker)."
          style={{
            flexShrink: 0, background: 'var(--bg-overlay)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', color: 'var(--text)', padding: '5px 6px', fontSize: 11.5, outline: 'none',
          }}
        >
          <option value="auto">Auto</option>
          <option value="T1">T1 · full</option>
          <option value="T2">T2 · manager</option>
          <option value="T3">T3 · single</option>
        </select>
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
