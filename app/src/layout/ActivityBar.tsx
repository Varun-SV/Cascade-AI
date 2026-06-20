import { Network, MessageSquare, Code2, Settings } from 'lucide-react';
import { useAppDispatch, useAppSelector, setView, type ViewMode } from '../store/index.js';

const NAV_ITEMS: { icon: typeof Network; label: string; view: ViewMode }[] = [
  { icon: Network,        label: 'Cockpit', view: 'cockpit' },
  { icon: MessageSquare,  label: 'Chat',    view: 'chat'    },
  { icon: Code2,          label: 'Code',    view: 'code'    },
];

export function ActivityBar() {
  const dispatch = useAppDispatch();
  const currentView = useAppSelector((s) => s.app.view);

  return (
    <aside style={{
      width: 48,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 12,
      gap: 4,
      flexShrink: 0,
    }}>
      {/* Logo mark */}
      <div style={{
        width: 28, height: 28, borderRadius: 6,
        background: 'var(--accent)', marginBottom: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px',
      }}>C</div>

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
        onClick={() => {/* TODO: open settings modal */}}
      />
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
        width: 36, height: 36, borderRadius: 'var(--radius)',
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-muted)',
        border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {icon}
    </button>
  );
}
