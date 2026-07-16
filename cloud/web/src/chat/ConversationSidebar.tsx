import clsx from 'clsx';
import { motion } from 'framer-motion';
import { MessageSquarePlus, Settings } from 'lucide-react';
import UsageMeter from './UsageMeter.js';
import TierMix from './TierMix.js';
import type { CloudConversation, CloudUser } from '../lib/types.js';

interface Props {
  user: CloudUser;
  conversations: CloudConversation[];
  activeConversationId: string | undefined;
  lastTokens: number;
  usageRefreshSignal: unknown;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}

export default function ConversationSidebar({
  user, conversations, activeConversationId, lastTokens, usageRefreshSignal,
  onSelect, onNewChat, onOpenSettings,
}: Props) {
  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <div className="accent-grad flex h-6 w-6 items-center justify-center rounded-lg text-white shadow-lg">
          <span className="text-xs font-bold">C</span>
        </div>
        <span className="text-sm font-semibold tracking-tight text-ink-50">Cascade Cloud</span>
      </div>

      <div className="p-3">
        <motion.button
          type="button"
          onClick={onNewChat}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          className="flex w-full items-center gap-2 rounded-xl border border-elev/10 bg-elev/[0.04] px-3 py-2.5 text-sm font-medium text-ink-100 hover:bg-elev/[0.08]"
        >
          <MessageSquarePlus size={16} /> New chat
        </motion.button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {conversations.map((c) => {
          const active = c.id === activeConversationId;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className={clsx(
                'block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors',
                active ? 'bg-elev/[0.08] text-ink-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]' : 'text-ink-300 hover:bg-elev/[0.05]',
              )}
              title={c.title ?? 'Untitled conversation'}
            >
              <span className="flex items-center gap-2">
                {active && <span className="accent-grad h-3.5 w-0.5 shrink-0 rounded-full" />}
                <span className="truncate">{c.title ?? 'Untitled conversation'}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-1 border-t border-elev/10 p-3">
        <UsageMeter lastTokens={lastTokens} refreshSignal={usageRefreshSignal} />
        <TierMix refreshSignal={usageRefreshSignal} />
        <motion.button
          type="button"
          aria-label="Settings"
          onClick={onOpenSettings}
          whileTap={{ scale: 0.98 }}
          className="mt-1 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-ink-200 hover:bg-elev/[0.06]"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="accent-grad flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white">
              {(user.name ?? user.email ?? 'U').charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{user.name ?? user.email ?? 'Signed in'}</span>
          </span>
          <Settings size={16} className="shrink-0 text-ink-400" />
        </motion.button>
      </div>
    </div>
  );
}
