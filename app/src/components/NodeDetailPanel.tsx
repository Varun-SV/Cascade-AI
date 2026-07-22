import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useAppDispatch, useAppSelector, selectNode } from '../store/index.js';

const TIER_COLORS: Record<string, string> = { T1: '#4c8dff', T2: '#38b0de', T3: '#2dd4bf' };
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'running', COMPLETED: 'done', FAILED: 'failed', ESCALATED: 'escalated', IDLE: 'idle',
};

/**
 * Live detail for the agent node selected in the Cockpit graph — its role,
 * status, current action, accumulated output stream, and recent peer messages.
 * Fixes "click a node, see nothing": every tier's stream is captured
 * (appendAgentStream) even though only the presenter reaches the chat.
 */
export function NodeDetailPanel() {
  const dispatch = useAppDispatch();
  const selectedId = useAppSelector((s) => s.app.selectedNodeId);
  const node = useAppSelector((s) => s.app.agents.find((a) => a.id === s.app.selectedNodeId));
  const peerEdges = useAppSelector((s) => s.app.peerEdges);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [node?.stream]);

  if (!selectedId || !node) return null;

  const color = TIER_COLORS[node.tier] ?? '#4c8dff';
  const nodePeers = peerEdges.filter((e) => e.fromId === node.id || e.toId === node.id).slice(-8).reverse();

  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, bottom: 12, width: 340, maxWidth: '46%',
      background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 10,
      boxShadow: 'var(--shadow-2)', display: 'flex', flexDirection: 'column', zIndex: 20, overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 3, background: color + '22', color }}>{node.tier}</span>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label}</span>
        <button onClick={() => dispatch(selectNode(null))} title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}>
          <X size={15} />
        </button>
      </div>

      <div style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
        <span>Status: <b style={{ color: 'var(--text)' }}>{STATUS_LABEL[node.status] ?? 'idle'}</b></span>
        {node.progressPct !== undefined && <span>Progress: <b style={{ color: 'var(--text)' }}>{node.progressPct}%</b></span>}
        {node.model && (
          <span title="The model serving this agent">
            Model: <b style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{node.model}</b>
          </span>
        )}
      </div>
      {node.currentAction && (
        <div style={{ padding: '6px 12px', fontSize: 11.5, color: 'var(--text)', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text-dim)' }}>Now: </span>{node.currentAction}
        </div>
      )}

      <div style={{ padding: '6px 12px 2px', fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)' }}>Live output</div>
      <div ref={streamRef} style={{ flex: 1, overflow: 'auto', padding: '2px 12px 10px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-mono)' }}>
        {node.stream || <span style={{ color: 'var(--text-dim)' }}>No output captured yet.</span>}
      </div>

      {nodePeers.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '6px 12px 10px', maxHeight: 120, overflow: 'auto' }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 4 }}>Peer messages</div>
          {nodePeers.map((e) => (
            <div key={e.id} style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {e.fromId === node.id ? '→ ' : '← '}{e.fromId === node.id ? e.toId : e.fromId}{e.syncType ? ` · ${e.syncType}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
