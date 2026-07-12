import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface Props {
  title: string | undefined;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export default function ChatTopBar({ title, sidebarOpen, onToggleSidebar }: Props) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-700 px-4">
      <button
        type="button"
        aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        onClick={onToggleSidebar}
        className="flex h-8 w-8 items-center justify-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100"
      >
        {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button>
      <span className="truncate text-sm font-medium text-ink-200">{title ?? 'New chat'}</span>
    </div>
  );
}
