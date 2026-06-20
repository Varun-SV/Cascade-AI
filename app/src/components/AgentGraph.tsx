import { useMemo } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  type Node, type Edge, type NodeTypes,
  Handle, Position,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { AgentNode } from '../store/index.js';

const TIER_COLORS: Record<string, string> = {
  T1: '#f5a623',
  T2: '#b87fff',
  T3: '#00d4e8',
};

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: '#b87fff',
  COMPLETED: '#22d47a',
  FAILED: '#f0506e',
  ESCALATED: '#f5a623',
  IDLE: '#3a3a46',
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'running',
  COMPLETED: 'done',
  FAILED: 'failed',
  ESCALATED: 'escalated',
  IDLE: 'idle',
};

function AgentNodeCard({ data }: { data: AgentNode }) {
  const tierColor = TIER_COLORS[data.tier] ?? '#b87fff';
  const statusColor = STATUS_COLORS[data.status] ?? STATUS_COLORS.IDLE;
  const isActive = data.status === 'ACTIVE';
  return (
    <div style={{
      background: '#131520',
      border: `1.5px solid ${tierColor}`,
      borderRadius: 8, padding: '8px 11px',
      minWidth: 155, maxWidth: 210,
      boxShadow: isActive ? `0 0 16px ${tierColor}44` : '0 2px 8px rgba(0,0,0,0.4)',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: tierColor, width: 7, height: 7, border: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{
          fontSize: 9, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase',
          padding: '2px 5px', borderRadius: 3, background: tierColor + '22', color: tierColor,
        }}>{data.tier}</span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: '#cdd6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {data.label}
        </span>
        <span title={data.status} style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: statusColor,
          boxShadow: isActive ? `0 0 6px ${statusColor}` : 'none',
          animation: isActive ? 'pulse 1.4s var(--ease) infinite' : 'none',
        }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#6e738d' }}>
        <span style={{ color: statusColor, fontWeight: 600 }}>{STATUS_LABEL[data.status] ?? 'idle'}</span>
        {data.currentAction && (
          <>
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.currentAction}</span>
          </>
        )}
      </div>
      {data.progressPct !== undefined && (
        <div style={{ marginTop: 6, height: 2, background: '#1a1d2e', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${data.progressPct}%`, background: tierColor, borderRadius: 2, transition: 'width 0.3s var(--ease)' }} />
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: tierColor, width: 7, height: 7, border: 'none' }} />
    </div>
  );
}

const NODE_TYPES: NodeTypes = { agent: AgentNodeCard };

const TIER_Y: Record<string, number> = { T1: 40, T2: 200, T3: 360 };
const H_GAP = 240;
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
        style: { stroke: TIER_COLORS[a.tier] ?? '#b87fff', strokeWidth: 1.5, opacity: 0.6 },
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
      style={{ background: 'transparent' }}
    >
      <Controls style={{ background: '#131520', border: '1px solid #1a1d2e', borderRadius: 8 }} />
      <MiniMap
        style={{ background: '#0f1117', border: '1px solid #1a1d2e', borderRadius: 8 }}
        maskColor="rgba(6,8,15,0.7)"
        nodeColor={(n) => TIER_COLORS[(n.data as AgentNode).tier] ?? '#3a3a46'}
      />
    </ReactFlow>
  );
}
