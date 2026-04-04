import React from 'react';
import { 
  LayoutDashboard, 
  Share2, 
  MessageSquare, 
  Activity, 
  Settings, 
  LogOut,
  ChevronRight,
  Database
} from 'lucide-react';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onLogout: () => void;
}

export function Sidebar({ activeTab, setActiveTab, onLogout }: SidebarProps) {
  const navItems = [
    { id: 'topology', label: 'Topology', icon: Share2 },
    { id: 'chat', label: 'Console', icon: MessageSquare },
    { id: 'logs', label: 'Telemetry', icon: Activity },
    { id: 'database', label: 'Knowledge', icon: Database },
  ];

  return (
    <div className="flex flex-col h-full p-6">
      {/* Brand */}
      <div className="flex items-center gap-3 mb-12 px-2">
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(37,99,235,0.4)]">
          <LayoutDashboard className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-sm font-black uppercase tracking-widest text-white">Cascade</h1>
          <p className="text-[10px] text-slate-500 font-bold tracking-tighter uppercase">Orchestrator v1.0</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-grow space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-300 group ${
                isActive 
                  ? 'bg-blue-600/10 text-blue-400 border border-blue-500/20 shadow-[0_0_20px_rgba(37,99,235,0.05)]' 
                  : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`w-4 h-4 transition-transform duration-300 ${isActive ? 'scale-110' : 'group-hover:scale-110'}`} />
                <span className="text-xs font-bold uppercase tracking-widest">{item.label}</span>
              </div>
              {isActive && <ChevronRight className="w-3 h-3" />}
            </button>
          );
        })}
      </nav>

      {/* System Status Card */}
      <div className="mb-6 p-4 rounded-2xl bg-white/[0.02] border border-white/5 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-3 text-[10px] uppercase tracking-widest text-slate-500 font-bold">
          <span>Core CPU</span>
          <span className="text-blue-400 italic">Optimal</span>
        </div>
        <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden">
          <div className="h-full w-[42%] bg-blue-500 rounded-full shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
        </div>
        <div className="mt-4 flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-500 font-bold">
          <span>Memory</span>
          <span className="text-indigo-400 italic">2.4GB</span>
        </div>
      </div>

      {/* Footer Actions */}
      <div className="pt-6 border-t border-white/5 space-y-2">
        <button className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-slate-500 hover:text-white hover:bg-white/5 transition-all text-xs font-bold uppercase tracking-widest">
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </button>
        <button 
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-red-400/60 hover:text-red-400 hover:bg-red-500/5 transition-all text-xs font-bold uppercase tracking-widest"
        >
          <LogOut className="w-4 h-4" />
          <span>Shutdown</span>
        </button>
      </div>
    </div>
  );
}
