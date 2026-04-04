import React from 'react';

interface DashboardLayoutProps {
  children: React.ReactNode;
  sidebar: React.ReactNode;
}

export function DashboardLayout({ children, sidebar }: DashboardLayoutProps) {
  return (
    <div className="flex h-screen w-screen bg-slate-950 overflow-hidden text-slate-200 font-sans selection:bg-blue-500/30">
      {/* Sidebar Container */}
      <aside className="w-72 h-full flex-shrink-0 border-r border-white/5 bg-black/20 backdrop-blur-3xl z-20">
        {sidebar}
      </aside>

      {/* Main Content Area */}
      <main className="flex-grow h-full relative overflow-hidden flex flex-col">
        {/* Top Header Glass Overlay */}
        <header className="h-16 border-b border-white/5 flex items-center justify-between px-8 bg-black/10 backdrop-blur-md z-10">
          <div className="flex items-center gap-4">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
            <h2 className="text-xs font-bold uppercase tracking-[0.3em] text-slate-400">
              Live Telemetry <span className="text-slate-600 ml-2">// Node-01_Cascade</span>
            </h2>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-slate-500">Latency</span>
              <span className="text-xs font-mono text-blue-400">14ms</span>
            </div>
            <div className="w-px h-4 bg-white/10" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-slate-500">Uptime</span>
              <span className="text-xs font-mono text-slate-300">04:12:45</span>
            </div>
          </div>
        </header>

        {/* Dynamic Scene Content */}
        <div className="flex-grow relative overflow-hidden bg-[radial-gradient(circle_at_50%_50%,rgba(15,23,42,1)_0%,rgba(0,0,0,1)_100%)]">
          {/* Subtle Grid Pattern */}
          <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none" />
          <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:50px_50px] pointer-events-none" />
          
          {children}
        </div>
      </main>
    </div>
  );
}
