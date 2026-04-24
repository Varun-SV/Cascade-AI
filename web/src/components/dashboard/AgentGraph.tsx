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

// ── Custom Agent Node ───────────────────────────

interface AgentNodeData {
  role: 'T1' | 'T2' | 'T3';
  label: string;
  status: string;
  action?: string;
  progressPct?: number;
}

const ROLE_COLOR: Record<string, string> = {
  T1: 'var(--t1-color)',
  T2: 'var(--t2-color)',
  T3: 'var(--t3-color)',
};

const STATUS_RING: Record<string, string> = {
  ACTIVE: 'border-[var(--t3-color)] agent-node-ACTIVE',
  COMPLETED: 'border-[var(--success)] agent-node-COMPLETED',
  FAILED: 'border-[var(--error)] agent-node-FAILED',
  ESCALATED: 'border-[var(--warning)] agent-node-ESCALATED',
  IDLE: 'border-[var(--border-subtle)]',
};

/**
 * AgentNode must be defined at module scope.
 * If defined inside a component, React creates a new reference every render,
 * ReactFlow treats it as a new node type, and remounts every node — which
 * is the primary source of graph lag.
 */
const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<AgentNodeData>) {
  const ringClass = STATUS_RING[data.status] ?? STATUS_RING.IDLE;

  return (
    <div
      aria-label={`${data.role} agent: ${data.label}, status: ${data.status}`}
      className={`
        relative px-3.5 py-3 glass min-w-[170px] max-w-[210px]
        rounded-[var(--radius-md)] border transition-all duration-300
        ${ringClass}
        ${selected ? 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-base)]' : ''}
      `}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-1.5 !h-1.5 !bg-[var(--border-strong)] !border-none !top-[-4px]"
      />

      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <span
          className="badge"
          style={{
            color: ROLE_COLOR[data.role],
            background: `color-mix(in srgb, ${ROLE_COLOR[data.role]} 10%, transparent)`,
            borderColor: `color-mix(in srgb, ${ROLE_COLOR[data.role]} 22%, transparent)`,
          }}
        >
          {data.role}
        </span>

        <div className="flex items-center gap-1">
          {data.status === 'ACTIVE' && (
            <div className="flex gap-[2px] items-center" aria-label="Active">
              {[0, 100, 200].map((d) => (
                <span
                  key={d}
                  className="w-1 h-1 rounded-full bg-[var(--t3-color)]"
                  style={{ animation: `pulse-glow 1.4s ease-in-out ${d}ms infinite` }}
                />
              ))}
            </div>
          )}
          {data.status === 'COMPLETED' && (
            <span className="text-[var(--success)] text-[10px] font-mono">✓</span>
          )}
          {data.status === 'FAILED' && (
            <span className="text-[var(--error)] text-[10px] font-mono">✗</span>
          )}
          {data.status === 'ESCALATED' && (
            <span className="text-[var(--warning)] text-[10px]">⚠</span>
          )}
        </div>
      </div>

      {/* Label */}
      <p className="text-[11px] font-semibold text-[var(--text-primary)] truncate leading-snug mb-0.5">
        {data.label}
      </p>

      {/* Current action */}
      {data.action && (
        <p className="text-[9px] text-[var(--text-muted)] truncate leading-snug font-mono">
          {data.action}
        </p>
      )}

      {/* Progress bar */}
      {data.progressPct !== undefined && data.status === 'ACTIVE' && (
        <div className="progress-track mt-2.5">
          <div className="progress-fill" style={{ width: `${data.progressPct}%` }} />
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-1.5 !h-1.5 !bg-[var(--border-strong)] !border-none !bottom-[-4px]"
      />
    </div>
  );
});

/**
 * NODE_TYPES must live at module scope (not inside a component) so the object
 * reference is stable across renders. A new reference causes ReactFlow to
 * unmount and remount every node on every render.
 */
const NODE_TYPES = { agent: AgentNode };

// ── Empty State ────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 animate-fade-in select-none">
      <div className="relative w-16 h-16">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="absolute inset-0 rounded-full border border-[var(--accent)]"
            style={{
              opacity: 0.12 + i * 0.08,
              animation: `orbit ${3.5 + i * 0.8}s linear infinite`,
              animationDelay: `${i * -1.2}s`,
            }}
          />
        ))}
        <div className="absolute inset-0 flex items-center justify-center text-2xl">
          ⬡
        </div>
      </div>
      <div className="text-center">
        <p className="text-[13px] font-medium text-[var(--text-primary)]">No active agents</p>
        <p className="text-[11px] text-[var(--text-muted)] mt-1">
          Start a task to see the agent topology
        </p>
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
  peerEdges?: Array<{ from: string; to: string; syncType: string; id: string }>;
  selectedNodeId?: string;
  onSelectNode: (id: string | null) => void;
}

export const AgentGraph = memo(function AgentGraph({
  nodes: agentNodes,
  edges: agentEdges,
  peerEdges = [],
  selectedNodeId,
  onSelectNode,
}: AgentGraphProps) {
  // All visual data is stored as primitives in node.data.
  // Never put JSX in node.data — ReactFlow compares by reference
  // and new JSX objects every render force a full remount.
  const flowNodes: Node[] = useMemo(() => {
    if (!agentNodes.length) return [];

    const byRole: Record<string, AgentGraphNode[]> = { T1: [], T2: [], T3: [] };
    agentNodes.forEach((n) => byRole[n.role]?.push(n));

    const TIER_Y = { T1: 40, T2: 210, T3: 380 };
    const H_GAP = 250;
    const CENTER_X = 500;

    return agentNodes.map((n) => {
      const tier = byRole[n.role]!;
      const idx = tier.findIndex((t) => t.id === n.id);
      const count = tier.length;
      const x = CENTER_X - ((count - 1) * H_GAP) / 2 + idx * H_GAP;
      const y = TIER_Y[n.role] ?? 40;

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
        } satisfies AgentNodeData,
      };
    });
  }, [agentNodes, selectedNodeId]);

  const flowEdges: Edge[] = useMemo(() => {
    const hierarchy = agentEdges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      style: { stroke: 'rgba(124,106,247,0.28)', strokeWidth: 1.5 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'rgba(124,106,247,0.45)',
        width: 10,
        height: 10,
      },
    }));

    const peer = peerEdges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      animated: true,
      label: e.syncType,
      labelStyle: { fontSize: 9, fill: 'rgba(255,165,0,0.85)' },
      labelBgStyle: { fill: 'var(--bg-base)', fillOpacity: 0.7 },
      style: { stroke: 'rgba(255,140,0,0.7)', strokeWidth: 1.5, strokeDasharray: '5,3' },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'rgba(255,140,0,0.7)',
        width: 8,
        height: 8,
      },
    }));

    return [...hierarchy, ...peer];
  }, [agentEdges, peerEdges]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    onSelectNode(node.id === selectedNodeId ? null : node.id);
  }, [onSelectNode, selectedNodeId]);

  if (!agentNodes.length) return <EmptyState />;

  return (
    <div className="w-full h-full relative" aria-label="Agent topology graph" role="img">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelectNode(null)}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.2 }}
        minZoom={0.25}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="rgba(255,255,255,0.03)"
          gap={24}
          size={1}
        />
        <Controls showInteractive={false} aria-label="Graph controls" />
      </ReactFlow>

      {/* Vignette */}
      <div className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-[var(--bg-base)] to-transparent pointer-events-none" />
      <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--bg-base)] to-transparent pointer-events-none" />
    </div>
  );
});