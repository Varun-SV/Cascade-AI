import clsx from 'clsx';
import { motion } from 'framer-motion';
import { MessageSquarePlus, KeyRound, LogOut, Crown, Brain } from 'lucide-react';
import UsageMeter from './UsageMeter.js';
import type { CloudConversation, CloudUser } from '../lib/types.js';

interface Props {
  user: CloudUser;
  conversations: CloudConversation[];
  activeConversationId: string | undefined;
  lastTokens: number;
  usageRefreshSignal: unknown;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenKeyVault: () => void;
  onOpenUpgrade: () => void;
  onOpenMemory: () => void;
  onLogout: () => void;
}

function FooterButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ x: 2 }}
      whileTap={{ scale: 0.98 }}
      className="reveal flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-200"
    >
      {icon} {label}
    </motion.button>
  );
}

export default function ConversationSidebar({
  user, conversations, activeConversationId, lastTokens, usageRefreshSignal,
  onSelect, onNewChat, onOpenKeyVault, onOpenUpgrade, onOpenMemory, onLogout,
}: Props) {
  return (
    <div className="flex h-full w-72 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <div className="accent-grad flex h-6 w-6 items-center justify-center rounded-lg text-ink-950 shadow-lg">
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
          className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm font-medium text-ink-100 hover:bg-white/[0.08]"
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
                active ? 'bg-white/[0.08] text-ink-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]' : 'text-ink-300 hover:bg-white/[0.05]',
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

      <div className="flex flex-col gap-0.5 border-t border-white/10 p-3">
        <UsageMeter lastTokens={lastTokens} refreshSignal={usageRefreshSignal} />
        <FooterButton icon={<Brain size={16} />} label="Memory" onClick={onOpenMemory} />
        <FooterButton icon={<KeyRound size={16} />} label="API keys" onClick={onOpenKeyVault} />
        <FooterButton icon={<Crown size={16} />} label="Upgrade" onClick={onOpenUpgrade} />
        <div className="mt-1 flex items-center justify-between rounded-lg px-3 py-2 text-sm text-ink-200">
          <span className="truncate">{user.name ?? user.email ?? 'Signed in'}</span>
          <motion.button
            type="button"
            aria-label="Log out"
            onClick={onLogout}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            className="text-ink-400 hover:text-danger-500"
          >
            <LogOut size={16} />
          </motion.button>
        </div>
      </div>
    </div>
  );
}
