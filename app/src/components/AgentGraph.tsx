import { useMemo, useCallback } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  type Node, type Edge, type NodeTypes,
  Handle, Position,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { AgentNode } from '../store/index.js';

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: '#7c6af7',
  COMPLETED: '#3ecf8e',
  FAILED: '#e74c3c',
  ESCALATED: '#f5a623',
  IDLE: '#3a3a42',
};

function AgentNodeCard({ data }: { data: AgentNode }) {
  const color = STATUS_COLORS[data.status] ?? STATUS_COLORS.IDLE;
  return (
    <div style={{
      background: 'var(--bg-raised)',
      border: `1.5px solid ${color}`,
      borderRadius: 8, padding: '8px 12px',
      minWidth: 160, maxWidth: 220,
      boxShadow: data.status === 'ACTIVE' ? `0 0 12px ${color}55` : 'none',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
          padding: '1px 5px', borderRadius: 3, background: color + '33', color,
        }}>{data.tier}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {data.label}
        </span>
      </div>
      {data.currentAction && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.currentAction}
        </div>
      )}
      {data.progressPct !== undefined && (
        <div style={{ marginTop: 6, height: 2, background: 'var(--border)', borderRadius: 1 }}>
          <div style={{ height: '100%', width: `${data.progressPct}%`, background: color, borderRadius: 1, transition: 'width 0.3s' }} />
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { agent: AgentNodeCard };

const TIER_Y: Record<string, number> = { T1: 40, T2: 200, T3: 360 };
const H_GAP = 250;
const CENTER_X = 600;

export function AgentGraph({ agents }: { agents: AgentNode[] }) {
  const nodes: Node[] = useMemo(() => {
    const byTier = { T1: [] as AgentNode[], T2: [] as AgentNode[], T3: [] as AgentNode[] };
    for (const a of agents) byTier[a.tier]?.push(a);
    return agents.map((a) => {
      const group = byTier[a.tier];
      const idx = group.indexOf(a);
      const count = group.length;
      const x = CENTER_X - ((count - 1) * H_GAP) / 2 + idx * H_GAP;
      return { id: a.id, type: 'agent', position: { x, y: TIER_Y[a.tier] ?? 40 }, data: a };
    });
  }, [agents]);

  const edges: Edge[] = useMemo(() =>
    agents
      .filter((a) => a.parentId)
      .map((a) => ({
        id: `${a.parentId}-${a.id}`,
        source: a.parentId!,
        target: a.id,
        style: { stroke: '#7c6af7', strokeWidth: 1.5 },
        animated: a.status === 'ACTIVE',
      })),
    [agents],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView
      minZoom={0.25}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#2a2a2f" gap={20} />
      <Controls style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }} />
      <MiniMap style={{ background: 'var(--bg-surface)' }} nodeColor={(n) => STATUS_COLORS[(n.data as AgentNode).status] ?? '#3a3a42'} />
    </ReactFlow>
  );
}
