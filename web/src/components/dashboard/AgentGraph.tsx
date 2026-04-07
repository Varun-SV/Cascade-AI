import React, { useMemo, memo, useCallback } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';

// ──  Custom Agent Node ─────────────────────────

interface AgentNodeData {
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: string;
  action?: string;
  progressPct?: number;
}

const ROLE_BADGE: Record<string, string> = {
  T1: 'badge-T1',
  T2: 'badge-T2',
  T3: 'badge-T3',
};

const STATUS_BORDER: Record<string, string> = {
  ACTIVE:    'border-[var(--t3-color)] agent-node-ACTIVE',
  COMPLETED: 'border-[var(--success)] agent-node-COMPLETED',
  FAILED:    'border-[var(--error)] agent-node-FAILED',
  ESCALATED: 'border-[var(--warning)] agent-node-ESCALATED',
  IDLE:      'border-[var(--border-subtle)]',
};

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<AgentNodeData>) {
  const borderClass = STATUS_BORDER[data.status] ?? STATUS_BORDER.IDLE;

  return (
    <div
      aria-label={`${data.role} agent: ${data.label}, status: ${data.status}`}
      className={`
        relative px-4 py-3 rounded-[var(--radius-lg)] border glass
        min-w-[180px] max-w-[220px] transition-all duration-300
        ${borderClass}
        ${selected ? 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--bg-base)]' : ''}
      `}
    >
      <Handle type="target" position={Position.Top}
        className="!w-2 !h-2 !bg-[var(--border-strong)] !border-none" />

      <div className="flex items-center justify-between mb-2">
        <span className={`badge ${ROLE_BADGE[data.role]}`}>{data.role}</span>
        {data.status === 'ACTIVE' && (
          <div className="flex gap-[3px] items-center">
            {[0, 120, 240].map((delay) => (
              <span
                key={delay}
                className="w-1 h-1 rounded-full bg-[var(--t3-color)]"
                style={{ animation: `pulse-glow 1.2s ease-in-out ${delay}ms infinite` }}
              />
            ))}
          </div>
        )}
        {data.status === 'COMPLETED' && (
          <span className="text-[var(--success)] text-xs">✓</span>
        )}
        {data.status === 'FAILED' && (
          <span className="text-[var(--error)] text-xs">✗</span>
        )}
      </div>

      <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate leading-tight">
        {data.label}
      </div>

      {data.action && (
        <div className="text-[10px] text-[var(--text-muted)] truncate mt-1 leading-snug">
          {data.action}
        </div>
      )}

      {data.progressPct !== undefined && data.status === 'ACTIVE' && (
        <div className="progress-track mt-2">
          <div className="progress-fill" style={{ width: `${data.progressPct}%` }} />
        </div>
      )}

      <Handle type="source" position={Position.Bottom}
        className="!w-2 !h-2 !bg-[var(--border-strong)] !border-none" />
    </div>
  );
});

const NODE_TYPES = { agent: AgentNode };

// ── Empty State ────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 animate-fade-in">
      <div className="relative w-20 h-20">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="absolute inset-0 rounded-full border border-[var(--accent)]"
            style={{
              opacity: 0.15 + i * 0.1,
              animation: `orbit ${3 + i}s linear infinite`,
              animationDelay: `${i * -1}s`,
            }}
          />
        ))}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-3xl">🌊</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-[var(--text-primary)] font-medium">No active agents</p>
        <p className="text-[11px] text-[var(--text-muted)] mt-1">Start a task to see the agent topology</p>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────

export interface AgentGraphNode {
  id: string;
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: string;
  action?: string;
  progressPct?: number;
}

interface AgentGraphProps {
  nodes: AgentGraphNode[];
  edges: { from: string; to: string }[];
  selectedNodeId?: string;
  onSelectNode: (id: string | null) => void;
}

export const AgentGraph = memo(function AgentGraph({
  nodes: agentNodes,
  edges: agentEdges,
  selectedNodeId,
  onSelectNode,
}: AgentGraphProps) {
  const flowNodes: Node[] = useMemo(() => {
    if (!agentNodes.length) return [];

    const byRole: Record<string, AgentGraphNode[]> = { T1: [], T2: [], T3: [] };
    agentNodes.forEach((n) => byRole[n.role]?.push(n));

    const TIER_Y = { T1: 60, T2: 230, T3: 400 };
    const H_GAP = 240;

    return agentNodes.map((n) => {
      const tier = byRole[n.role]!;
      const idx = tier.findIndex((t) => t.id === n.id);
      const count = tier.length;
      const totalWidth = (count - 1) * H_GAP;
      const x = 520 - totalWidth / 2 + idx * H_GAP;
      const y = TIER_Y[n.role] ?? 60;

      return {
        id: n.id,
        type: 'agent',
        position: { x, y },
        selected: selectedNodeId === n.id,
        data: {
          role: n.role,
          label: n.label,
          status: n.status,
          action: n.action,
          progressPct: n.progressPct,
        },
      };
    });
  }, [agentNodes, selectedNodeId]);

  const flowEdges: Edge[] = useMemo(() =>
    agentEdges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      style: { stroke: 'rgba(124, 106, 247, 0.35)', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(124,106,247,0.5)', width: 12, height: 12 },
    })),
  [agentEdges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    onSelectNode(node.id === selectedNodeId ? null : node.id);
  }, [onSelectNode, selectedNodeId]);

  if (!agentNodes.length) return <EmptyState />;

  return (
    <div
      className="w-full h-full relative"
      aria-label="Agent topology graph"
      role="img"
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelectNode(null)}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="rgba(255,255,255,0.035)"
          gap={28}
          size={1}
        />
        <Controls showInteractive={false} aria-label="Graph controls" />
      </ReactFlow>

      {/* Vignette fade edges */}
      <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-[var(--bg-base)] to-transparent pointer-events-none" />
      <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--bg-base)] to-transparent pointer-events-none" />
    </div>
  );
});
