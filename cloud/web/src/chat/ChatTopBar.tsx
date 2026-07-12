import { motion } from 'framer-motion';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface Props {
  title: string | undefined;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export default function ChatTopBar({ title, sidebarOpen, onToggleSidebar }: Props) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/10 px-3">
      <motion.button
        type="button"
        aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        onClick={onToggleSidebar}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92 }}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-400 hover:bg-white/10 hover:text-ink-100"
      >
        {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </motion.button>
      <span className="truncate text-sm font-medium text-ink-200">{title ?? 'New chat'}</span>
    </div>
  );
}
