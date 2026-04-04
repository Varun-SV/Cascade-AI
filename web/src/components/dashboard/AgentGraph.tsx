import React, { useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';

// Custom Node Component for a more premium look
const AgentNode = ({ data }: NodeProps) => {
  const statusColors: Record<string, string> = {
    ACTIVE: 'border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]',
    COMPLETED: 'border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.3)]',
    FAILED: 'border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.3)]',
    IDLE: 'border-white/10',
  };

  const roleGradients: Record<string, string> = {
    T1: 'from-blue-600/20 to-indigo-600/10',
    T2: 'from-purple-600/20 to-pink-600/10',
    T3: 'from-emerald-600/20 to-teal-600/10',
  };

  return (
    <div className={`px-4 py-3 rounded-2xl border bg-black/40 backdrop-blur-xl min-w-[180px] transition-all duration-500 ${statusColors[data.status] || statusColors.IDLE}`}>
      <Handle type="target" position={Position.Top} className="!bg-blue-500 !border-none !w-2 !h-2" />
      
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className={`text-[9px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded-lg bg-gradient-to-r ${roleGradients[data.role]} text-white border border-white/5`}>
            {data.role}
          </span>
          {data.status === 'ACTIVE' && (
            <div className="flex gap-1">
              <span className="w-1 h-1 rounded-full bg-blue-500 animate-ping" />
              <span className="w-1 h-1 rounded-full bg-blue-500" />
            </div>
          )}
        </div>
        
        <div className="mt-2 text-xs font-bold text-slate-100 truncate">
          {data.label}
        </div>
        
        <div className="text-[10px] text-slate-500 font-medium truncate mt-0.5">
          {data.action || (data.status === 'ACTIVE' ? 'Executing...' : 'Standing by')}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-blue-500 !border-none !w-2 !h-2" />
    </div>
  );
};

const nodeTypes = {
  agent: AgentNode,
};

interface AgentGraphProps {
  nodes: {
    id: string;
    role: 'T1' | 'T2' | 'T3';
    label: string;
    status: string;
    action?: string;
  }[];
  edges: { from: string; to: string }[];
  selectedNodeId?: string;
  onSelectNode: (id: string) => void;
}

export function AgentGraph({ nodes: agentNodes, edges: agentEdges, selectedNodeId, onSelectNode }: AgentGraphProps) {
  const flowNodes: Node[] = useMemo(() => {
    return agentNodes.map((n) => {
      // Automatic tier-based positioning
      let x = 0;
      let y = 0;
      const tierNodes = agentNodes.filter(node => node.role === n.role);
      const index = tierNodes.findIndex(node => node.id === n.id);
      const width = 250;
      
      if (n.role === 'T1') {
        y = 50;
        x = 400; // Center T1
      } else if (n.role === 'T2') {
        y = 200;
        x = 400 + (index - (tierNodes.length - 1) / 2) * width;
      } else {
        y = 350;
        x = 400 + (index - (tierNodes.length - 1) / 2) * width;
      }

      return {
        id: n.id,
        type: 'agent',
        position: { x, y },
        data: { ...n },
        selected: selectedNodeId === n.id,
      };
    });
  }, [agentNodes, selectedNodeId]);

  const flowEdges: Edge[] = useMemo(() => {
    return agentEdges.map((e, i) => ({
      id: `e-${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      style: { stroke: 'rgba(59, 130, 246, 0.4)', strokeWidth: 2 },
    }));
  }, [agentEdges]);

  return (
    <div className="w-full h-full relative group">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        className="transition-opacity duration-1000"
      >
        <Background 
          color="rgba(255, 255, 255, 0.03)" 
          gap={20} 
          size={1} 
        />
        <Controls showInteractive={false} className="!bg-black/20 !border-white/5 !shadow-none !fill-white" />
      </ReactFlow>
      
      {/* Decorative Overlays */}
      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/20 to-transparent pointer-events-none" />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/20 to-transparent pointer-events-none" />
    </div>
  );
}
