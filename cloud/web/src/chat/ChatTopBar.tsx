import { motion } from 'framer-motion';
import { PanelLeftClose, PanelLeftOpen, TrendingDown, MonitorSmartphone } from 'lucide-react';

interface Props {
  title: string | undefined;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  saved?: { usd: number; pct: number } | null;
  onContinueElsewhere: () => void;
}

export default function ChatTopBar({ title, sidebarOpen, onToggleSidebar, saved, onContinueElsewhere }: Props) {
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
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-200">{title ?? 'New chat'}</span>
      <motion.button
        type="button"
        aria-label="Continue this chat on another device"
        title="Continue elsewhere"
        onClick={onContinueElsewhere}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.92 }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-400 hover:bg-white/10 hover:text-ink-100"
      >
        <MonitorSmartphone size={16} />
      </motion.button>
      {saved && saved.usd > 0 && (
        <span
          title="Saved by delegating below the top tier"
          className="flex shrink-0 items-center gap-1 rounded-md border border-success-500/25 bg-success-500/10 px-2 py-1 font-mono text-[11px] text-success-300"
        >
          <TrendingDown size={12} />
          saved ${saved.usd.toFixed(2)}
        </span>
      )}
    </div>
  );
}
