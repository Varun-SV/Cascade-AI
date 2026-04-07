import React, { memo } from 'react';
import { Network, Layers, FileText, Settings, LogOut } from 'lucide-react';

// Exported so App.tsx and any other consumer can import the shared type
// instead of redeclaring it independently.
export type NavTab = 'topology' | 'sessions' | 'logs' | 'settings';

interface NavRailProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  onLogout: () => void;
}

const NAV_ITEMS: { id: NavTab; icon: React.ElementType; label: string }[] = [
  { id: 'topology', icon: Network, label: 'Agent Topology' },
  { id: 'sessions', icon: Layers, label: 'Sessions' },
  { id: 'logs', icon: FileText, label: 'Telemetry' },
  { id: 'settings', icon: Settings, label: 'Settings' },
];

function Tooltip({ label }: { label: string }) {
  return (
    <div
      role="tooltip"
      className="
        absolute left-full ml-3 px-2.5 py-1.5
        text-[10px] font-medium font-mono text-[var(--text-primary)]
        bg-[var(--bg-overlay)] border border-[var(--border-strong)]
        rounded-[var(--radius-sm)] whitespace-nowrap pointer-events-none
        opacity-0 group-hover:opacity-100
        translate-x-[-4px] group-hover:translate-x-0
        transition-all duration-150 z-50
        shadow-[var(--shadow-panel)]
      "
    >
      {label}
    </div>
  );
}

export const NavRail = memo(function NavRail({ activeTab, onTabChange, onLogout }: NavRailProps) {
  return (
    <nav
      aria-label="Main navigation"
      className="
        flex flex-col items-center py-5 gap-1
        w-[56px] flex-shrink-0 h-full z-20
        bg-[var(--bg-surface)]
        border-r border-[var(--border-subtle)]
      "
    >
      {/* Logo mark */}
      <div className="
        mb-4 w-8 h-8 rounded-[var(--radius-sm)]
        bg-[var(--accent)] flex items-center justify-center
        shadow-[var(--shadow-glow-violet)] select-none
      ">
        <span className="text-white font-black text-[13px] font-mono tracking-tighter">C</span>
      </div>

      <div className="divider w-8 mb-2" />

      {/* Primary nav */}
      <div className="flex flex-col gap-0.5 flex-1 w-full px-1.5">
        {NAV_ITEMS.map(({ id, icon: Icon, label }) => {
          const isActive = activeTab === id;
          return (
            <div key={id} className="relative group">
              <button
                id={`nav-${id}`}
                aria-label={label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onTabChange(id)}
                className={`nav-rail-btn w-full ${isActive ? 'active' : ''}`}
              >
                <Icon size={17} strokeWidth={isActive ? 2 : 1.75} />
              </button>
              <Tooltip label={label} />
            </div>
          );
        })}
      </div>

      {/* Logout */}
      <div className="relative group px-1.5 w-full">
        <button
          aria-label="Log out"
          onClick={onLogout}
          className="nav-rail-btn w-full text-[var(--text-faint)] hover:text-[var(--error)]"
        >
          <LogOut size={15} strokeWidth={1.75} />
        </button>
        <Tooltip label="Log out" />
      </div>
    </nav>
  );
});