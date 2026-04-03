import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  progressPct?: number;
}

interface AgentGraphProps {
  nodes: AgentNode[];
  edges: Array<{ from: string; to: string }>;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  showControls?: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: '#7c6af7',
  COMPLETED: '#10b981',
  FAILED: '#ef4444',
  ESCALATED: '#f59e0b',
  IDLE: '#374151',
};

const ROLE_BG: Record<string, string> = {
  T1: '#1e1b4b',
  T2: '#0c1a2e',
  T3: '#0f1f18',
};

function buildFlowNodes(agentNodes: AgentNode[], selectedNodeId?: string): Node[] {
  const t1 = agentNodes.filter((n) => n.role === 'T1');
  const t2 = agentNodes.filter((n) => n.role === 'T2');
  const t3 = agentNodes.filter((n) => n.role === 'T3');

  const result: Node[] = [];

  t1.forEach((n) => result.push({
    id: n.id,
    type: 'default',
    position: { x: 300, y: 50 },
    data: { label: <NodeLabel node={n} /> },
    style: nodeStyle(n, selectedNodeId),
  }));

  t2.forEach((n, i) => result.push({
    id: n.id,
    type: 'default',
    position: { x: 100 + i * 220, y: 200 },
    data: { label: <NodeLabel node={n} /> },
    style: nodeStyle(n, selectedNodeId),
  }));

  t3.forEach((n, i) => result.push({
    id: n.id,
    type: 'default',
    position: { x: 50 + i * 180, y: 380 },
    data: { label: <NodeLabel node={n} /> },
    style: nodeStyle(n, selectedNodeId),
  }));

  return result;
}

function nodeStyle(node: AgentNode, selectedNodeId?: string) {
  return {
    background: ROLE_BG[node.role],
    border: `2px solid ${selectedNodeId === node.id ? '#f8fafc' : STATUS_COLOR[node.status]}`,
    borderRadius: 8,
    color: '#e2e8f0',
    padding: 8,
    minWidth: 160,
    boxShadow: selectedNodeId === node.id ? '0 0 0 2px rgba(124,106,247,0.45)' : 'none',
  };
}

function NodeLabel({ node }: { node: AgentNode }) {
  const progressText = typeof node.progressPct === 'number' ? `${Math.max(0, Math.min(100, node.progressPct))}%` : null;
  const actionText = node.action ?? (node.status === 'ACTIVE' ? 'Executing...' : 'Idle');

  return (
    <div>
      <div style={{ fontSize: 10, color: STATUS_COLOR[node.status], fontWeight: 700 }}>{node.role}</div>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{node.label}</div>
      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, whiteSpace: 'pre-wrap' }}>{actionText.slice(0, 80)}</div>
      {progressText && <div style={{ fontSize: 10, color: '#cbd5e1', marginTop: 2 }}>{progressText}</div>}
      <div style={{ fontSize: 10, color: STATUS_COLOR[node.status], marginTop: 2 }}>{node.status}</div>
    </div>
  );
}

function NodeDetail({ node }: { node: AgentNode }) {
  return (
    <div style={{ position: 'absolute', right: 12, top: 12, zIndex: 20, background: 'rgba(15, 15, 26, 0.96)', color: '#e2e8f0', border: '1px solid #2d2b55', borderRadius: 10, padding: 12, width: 220, boxShadow: '0 12px 32px rgba(0,0,0,0.35)' }}>
      <div style={{ fontSize: 10, color: STATUS_COLOR[node.status], fontWeight: 700 }}>{node.role}</div>
      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{node.label}</div>
      <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 6, whiteSpace: 'pre-wrap' }}>{node.action ?? (node.status === 'ACTIVE' ? 'Executing node...' : 'No current action')}</div>
      {typeof node.progressPct === 'number' && <div style={{ fontSize: 11, color: '#a5b4fc', marginTop: 8 }}>Progress: {Math.max(0, Math.min(100, node.progressPct))}%</div>}
      <div style={{ fontSize: 11, color: STATUS_COLOR[node.status], marginTop: 8 }}>{node.status}</div>
    </div>
  );
}

export function AgentGraph({ nodes: agentNodes, edges: agentEdges, selectedNodeId, onSelectNode, showControls = true }: AgentGraphProps) {
  const [hoveredNode, setHoveredNode] = useState<AgentNode | null>(null);
  const activeNode = useMemo(() => hoveredNode ?? agentNodes.find((n) => n.id === selectedNodeId) ?? null, [hoveredNode, agentNodes, selectedNodeId]);
  const [nodes, setNodes, onNodesChange] = useNodesState(buildFlowNodes(agentNodes, selectedNodeId));
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    agentEdges.map((e, i) => ({
      id: `e-${i}`,
      source: e.from,
      target: e.to,
      style: { stroke: '#2d2b55' },
      animated: true,
    })),
  );

  useEffect(() => {
    setNodes(buildFlowNodes(agentNodes, selectedNodeId));
  }, [agentNodes, selectedNodeId, setNodes]);

  useEffect(() => {
    setEdges(agentEdges.map((e, i) => ({
      id: `e-${i}`,
      source: e.from,
      target: e.to,
      style: { stroke: '#2d2b55' },
      animated: true,
    })));
  }, [agentEdges, setEdges]);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(c, eds)), [setEdges]);

  return (
    <div style={{ height: 480, background: '#0f0f1a', borderRadius: 8, border: '1px solid #2d2b55' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_event, node) => onSelectNode?.(node.id)}
        onNodeMouseEnter={(_event, node) => setHoveredNode(agentNodes.find((n) => n.id === node.id) ?? null)}
        onNodeMouseLeave={() => setHoveredNode(null)}
        fitView
      >
        <Background color="#2d2b55" gap={24} />
        {activeNode && <NodeDetail node={activeNode} />}
        {showControls && <Controls style={{ background: '#1a1a2e', border: '1px solid #2d2b55' }} />}
      </ReactFlow>
    </div>
  );
}
