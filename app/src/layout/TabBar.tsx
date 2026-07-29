import { FileCode, Cpu, Globe, X } from 'lucide-react';
import {
  useAppDispatch, useAppSelector,
  closeTab, setActiveTab, setView,
  type AppTab,
} from '../store/index.js';

function Tab({ tab, active }: { tab: AppTab; active: boolean }) {
  const dispatch = useAppDispatch();
  const openTabs = useAppSelector((s) => s.app.openTabs);

  const handleClick = () => {
    dispatch(setActiveTab(tab.id));
    if (tab.type === 'session') dispatch(setView('cockpit'));
    else if (tab.type === 'file') dispatch(setView('code'));
    else if (tab.type === 'browser') dispatch(setView('browser'));
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    // `view` is a separate piece of state from `activeTabId` — closing a tab
    // alone never touches it. Harmless for file/session tabs (their views
    // just sit there unselected), but `browser` is gated on `view` ALONE
    // (see MainContent.tsx) and is a native WebContentsView layered above
    // the whole React tree, so closing an active browser tab left it
    // covering everything with no visible tab to explain why. Mirror the
    // closeTab reducer's own "select the tab now to the left" logic so
    // `view` ends up pointing at whatever tab actually becomes active.
    if (active) {
      const idx = openTabs.findIndex((t) => t.id === tab.id);
      const remaining = openTabs.filter((t) => t.id !== tab.id);
      const next = remaining[Math.max(0, idx - 1)];
      if (next?.type === 'session') dispatch(setView('cockpit'));
      else if (next?.type === 'file') dispatch(setView('code'));
      else if (next?.type === 'browser') dispatch(setView('browser'));
      else dispatch(setView('chat'));
    }
    dispatch(closeTab(tab.id));
  };

  return (
    <div
      onClick={handleClick}
      title={tab.path ?? tab.title}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '0 10px 0 10px',
        height: '100%',
        minWidth: 80, maxWidth: 180,
        background: active ? 'var(--bg-base)' : 'transparent',
        borderRight: '1px solid var(--border)',
        borderBottom: active ? '1px solid var(--bg-base)' : 'none',
        cursor: 'pointer',
        color: active ? 'var(--text-muted)' : 'var(--text-dim)',
        fontSize: 11,
        userSelect: 'none',
        WebkitAppRegion: 'no-drag',
        transition: 'color var(--dur) var(--ease)',
        position: 'relative',
        flexShrink: 0,
      } as React.CSSProperties}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)';
      }}
    >
      {tab.type === 'file'
        ? <FileCode size={10} style={{ flexShrink: 0 }} />
        : tab.type === 'browser'
          ? <Globe size={10} style={{ flexShrink: 0 }} />
          : <Cpu size={10} style={{ flexShrink: 0 }} />
      }
      <span style={{
        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {tab.title}
        {tab.isDirty && <span style={{ color: 'var(--accent)', marginLeft: 2 }}>•</span>}
      </span>
      <button
        onClick={handleClose}
        title="Close tab"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 1,
          color: 'inherit', display: 'flex', alignItems: 'center', borderRadius: 2,
          flexShrink: 0, opacity: 0.6,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.6'; }}
      >
        <X size={9} />
      </button>
    </div>
  );
}

export function TabBar() {
  const { openTabs, activeTabId } = useAppSelector((s) => s.app);

  if (openTabs.length === 0) return null;

  return (
    <div style={{
      height: 35,
      background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'stretch',
      overflowX: 'auto',
      flexShrink: 0,
    }}>
      {openTabs.map((tab) => (
        <Tab key={tab.id} tab={tab} active={tab.id === activeTabId} />
      ))}
    </div>
  );
}
