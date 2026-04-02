import React, { useCallback, useEffect, useState } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  type Connection,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';

interface AgentNode {
  id: string;
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
  action?: string;
}

interface AgentGraphProps {
  nodes: AgentNode[];
  edges: Array<{ from: string; to: string }>;
}

const STATUS_COLOR: Record<string, string> = {
  ACTIVE:    '#7c6af7',
  COMPLETED: '#10b981',
  FAILED:    '#ef4444',
  ESCALATED: '#f59e0b',
  IDLE:      '#374151',
};

const ROLE_BG: Record<string, string> = {
  T1: '#1e1b4b',
  T2: '#0c1a2e',
  T3: '#0f1f18',
};

function buildFlowNodes(agentNodes: AgentNode[]): Node[] {
  const t1 = agentNodes.filter((n) => n.role === 'T1');
  const t2 = agentNodes.filter((n) => n.role === 'T2');
  const t3 = agentNodes.filter((n) => n.role === 'T3');

  const result: Node[] = [];

  t1.forEach((n, i) => result.push({
    id: n.id, type: 'default', position: { x: 300, y: 50 },
    data: { label: <NodeLabel node={n} /> },
    style: { background: ROLE_BG['T1'], border: `1px solid ${STATUS_COLOR[n.status]}`, borderRadius: 8, color: '#e2e8f0', padding: 8, minWidth: 160 },
  }));

  t2.forEach((n, i) => result.push({
    id: n.id, type: 'default', position: { x: 100 + i * 220, y: 200 },
    data: { label: <NodeLabel node={n} /> },
    style: { background: ROLE_BG['T2'], border: `1px solid ${STATUS_COLOR[n.status]}`, borderRadius: 8, color: '#e2e8f0', padding: 8, minWidth: 160 },
  }));

  t3.forEach((n, i) => result.push({
    id: n.id, type: 'default', position: { x: 50 + i * 180, y: 380 },
    data: { label: <NodeLabel node={n} /> },
    style: { background: ROLE_BG['T3'], border: `1px solid ${STATUS_COLOR[n.status]}`, borderRadius: 8, color: '#e2e8f0', padding: 8, minWidth: 140 },
  }));

  return result;
}

function NodeLabel({ node }: { node: AgentNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: STATUS_COLOR[node.status], fontWeight: 700 }}>{node.role}</div>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{node.label}</div>
      {node.action && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{node.action.slice(0, 40)}</div>}
      <div style={{ fontSize: 10, color: STATUS_COLOR[node.status], marginTop: 2 }}>{node.status}</div>
    </div>
  );
}

export function AgentGraph({ nodes: agentNodes, edges: agentEdges }: AgentGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(buildFlowNodes(agentNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    agentEdges.map((e, i) => ({
      id: `e-${i}`, source: e.from, target: e.to,
      style: { stroke: '#2d2b55' }, animated: true,
    })),
  );

  useEffect(() => {
    setNodes(buildFlowNodes(agentNodes));
  }, [agentNodes]);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(c, eds)), []);

  return (
    <div style={{ height: 480, background: '#0f0f1a', borderRadius: 8, border: '1px solid #2d2b55' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
      >
        <Background color="#2d2b55" gap={24} />
        <Controls style={{ background: '#1a1a2e', border: '1px solid #2d2b55' }} />
      </ReactFlow>
    </div>
  );
}
