import { Network, MessageSquare, Code2, Settings } from 'lucide-react';
import { useAppDispatch, useAppSelector, setView, setShowSettings, type ViewMode } from '../store/index.js';

const NAV_ITEMS: { icon: typeof Network; label: string; view: ViewMode }[] = [
  { icon: Network,        label: 'Cockpit', view: 'cockpit' },
  { icon: MessageSquare,  label: 'Chat',    view: 'chat'    },
  { icon: Code2,          label: 'Code',    view: 'code'    },
];

export function ActivityBar() {
  const dispatch = useAppDispatch();
  const currentView = useAppSelector((s) => s.app.view);

  return (
    <aside className="activity-bar" style={{
      width: 48,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 10,
      gap: 4,
      flexShrink: 0,
    }}>
      {NAV_ITEMS.map(({ icon: Icon, label, view }) => (
        <NavButton
          key={view}
          icon={<Icon size={18} />}
          label={label}
          active={currentView === view}
          onClick={() => dispatch(setView(view))}
        />
      ))}

      <div style={{ flex: 1 }} />

      <NavButton
        icon={<Settings size={18} />}
        label="Settings"
        active={false}
        onClick={() => dispatch(setShowSettings(true))}
      />
      <div style={{ height: 8 }} />
    </aside>
  );
}

function NavButton({
  icon, label, active, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        position: 'relative',
        width: 32, height: 28, borderRadius: 5,
        background: active ? 'rgba(124,106,247,.1)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background var(--dur) var(--ease), color var(--dur) var(--ease)',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
          (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
          (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)';
        }
      }}
    >
      {/* 2px active indicator rail */}
      <span style={{
        position: 'absolute', left: -8, top: '50%', transform: 'translateY(-50%)',
        width: 2, height: active ? 16 : 0, borderRadius: 2,
        background: 'var(--accent)',
        transition: 'height var(--dur) var(--ease)',
      }} />
      {icon}
    </button>
  );
}
