import React from 'react';
import { 
  X, 
  Terminal, 
  Clock, 
  AlertCircle, 
  CheckCircle2, 
  Code2,
  Box,
  Cpu
} from 'lucide-react';

interface InspectorProps {
  selectedNode: any;
  onClose: () => void;
}

export function Inspector({ selectedNode, onClose }: InspectorProps) {
  if (!selectedNode) return null;

  const data = selectedNode.data;
  const status = data.status || 'idle';
  
  const statusColors: Record<string, string> = {
    running: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
    completed: 'text-green-400 bg-green-400/10 border-green-400/20',
    failed: 'text-red-400 bg-red-400/10 border-red-400/20',
    idle: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
  };

  return (
    <div className="absolute right-0 top-0 bottom-0 w-96 bg-black/40 backdrop-blur-3xl border-l border-white/5 z-30 shadow-2xl animate-in slide-in-from-right duration-300">
      <div className="flex items-center justify-between p-6 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600/10 rounded-lg">
            <Box className="w-4 h-4 text-blue-400" />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-white">Node Inspector</h3>
            <p className="text-[10px] text-slate-500 font-mono italic">UUID: {selectedNode.id.split('-')[0]}...</p>
          </div>
        </div>
        <button 
          onClick={onClose}
          className="p-2 hover:bg-white/5 rounded-full transition-colors text-slate-500 hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-6 space-y-8 overflow-y-auto h-[calc(100%-80px)] custom-scrollbar">
        {/* Identity & Status */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold">Current State</span>
            <div className={`px-3 py-1 rounded-full border text-[9px] font-black uppercase tracking-widest ${statusColors[status]}`}>
              {status}
            </div>
          </div>
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/5">
            <h4 className="text-xl font-bold text-white mb-1">{data.label}</h4>
            <p className="text-xs text-slate-400 leading-relaxed">{data.description || 'No description provided for this node.'}</p>
          </div>
        </section>

        {/* Telemetry Metrics */}
        <section className="space-y-4">
          <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold">Active Metrics</h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/5">
              <Cpu className="w-4 h-4 text-indigo-400 mb-2" />
              <div className="text-lg font-mono text-white">12%</div>
              <div className="text-[9px] uppercase tracking-widest text-slate-500">Utilization</div>
            </div>
            <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/5">
              <Clock className="w-4 h-4 text-amber-400 mb-2" />
              <div className="text-lg font-mono text-white">1.2s</div>
              <div className="text-[9px] uppercase tracking-widest text-slate-500">Duration</div>
            </div>
          </div>
        </section>

        {/* Code / Logs Area */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold flex items-center gap-2">
              <Terminal className="w-3 h-3" /> Execution Log
            </h4>
            <button className="text-[10px] text-blue-400 hover:underline uppercase tracking-widest">
              Full View
            </button>
          </div>
          <div className="bg-black/60 rounded-2xl p-4 border border-white/5 font-mono text-[11px] leading-relaxed text-slate-300 h-64 overflow-y-auto custom-scrollbar">
            {data.logs && data.logs.length > 0 ? (
              data.logs.map((log: string, i: number) => (
                <div key={i} className="mb-1">
                  <span className="text-slate-600 mr-2">[{new Date().toLocaleTimeString()}]</span>
                  {log}
                </div>
              ))
            ) : (
              <div className="h-full flex items-center justify-center text-slate-600 italic">
                Awaiting telemetry streams...
              </div>
            )}
          </div>
        </section>

        {/* Tools Segment */}
        <section className="space-y-4">
          <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold">Attached Tools</h4>
          <div className="flex flex-wrap gap-2">
            {['FileSystem', 'Shell', 'Browser', 'Router'].map(tool => (
              <div key={tool} className="px-3 py-1.5 rounded-lg bg-blue-600/5 border border-blue-500/10 text-[10px] text-blue-400 font-bold flex items-center gap-2">
                <Code2 className="w-3 h-3" />
                {tool}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
