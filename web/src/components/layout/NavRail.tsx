import React, { memo } from 'react';
import { Network, Layers, FileText, Settings, LogOut } from 'lucide-react';

type NavTab = 'topology' | 'sessions' | 'logs' | 'settings';

interface NavRailProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  onLogout: () => void;
}

const NAV_ITEMS: { id: NavTab; icon: React.ElementType; label: string }[] = [
  { id: 'topology',  icon: Network,   label: 'Agent Topology' },
  { id: 'sessions',  icon: Layers,    label: 'Sessions' },
  { id: 'logs',      icon: FileText,  label: 'Logs' },
  { id: 'settings',  icon: Settings,  label: 'Settings' },
];

function NavTooltip({ label }: { label: string }) {
  return (
    <div
      role="tooltip"
      className="absolute left-full ml-2 px-2 py-1 text-xs font-medium text-white
                 bg-[var(--bg-overlay)] border border-[var(--border-strong)]
                 rounded-[var(--radius-sm)] whitespace-nowrap pointer-events-none
                 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50
                 shadow-[var(--shadow-panel)]"
    >
      {label}
    </div>
  );
}

export const NavRail = memo(function NavRail({ activeTab, onTabChange, onLogout }: NavRailProps) {
  return (
    <nav
      aria-label="Main navigation"
      className="flex flex-col items-center py-4 gap-1 w-[60px] bg-[var(--bg-surface)]
                 border-r border-[var(--border-subtle)] h-full flex-shrink-0 z-20"
    >
      {/* Logo */}
      <div className="mb-4 w-9 h-9 rounded-[var(--radius-md)] bg-[var(--accent)]
                      flex items-center justify-center shadow-[var(--shadow-glow-violet)]">
        <span className="text-white font-black text-sm">C</span>
      </div>

      <div className="divider w-8 my-1" />

      {/* Nav items */}
      <div className="flex flex-col gap-1 flex-1">
        {NAV_ITEMS.map(({ id, icon: Icon, label }) => (
          <div key={id} className="relative group">
            <button
              id={`nav-${id}`}
              aria-label={label}
              aria-current={activeTab === id ? 'page' : undefined}
              className={`nav-rail-btn ${activeTab === id ? 'active' : ''}`}
              onClick={() => onTabChange(id)}
            >
              <Icon size={18} strokeWidth={1.75} />
            </button>
            <NavTooltip label={label} />
          </div>
        ))}
      </div>

      {/* Logout */}
      <div className="relative group mt-auto">
        <button
          aria-label="Log out"
          className="nav-rail-btn text-[var(--text-faint)] hover:text-[var(--error)]"
          onClick={onLogout}
        >
          <LogOut size={16} strokeWidth={1.75} />
        </button>
        <NavTooltip label="Log out" />
      </div>
    </nav>
  );
});
