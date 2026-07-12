import clsx from 'clsx';
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

export default function ConversationSidebar({
  user, conversations, activeConversationId, lastTokens, usageRefreshSignal,
  onSelect, onNewChat, onOpenKeyVault, onOpenUpgrade, onOpenMemory, onLogout,
}: Props) {
  return (
    <div className="flex h-full w-64 flex-col bg-ink-900">
      <div className="p-3">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-100 hover:bg-ink-800"
        >
          <MessageSquarePlus size={16} /> New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {conversations.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={clsx(
              'mb-1 block w-full truncate border-l-2 px-3 py-2 text-left text-sm',
              c.id === activeConversationId
                ? 'border-accent-500 bg-ink-800 text-ink-50'
                : 'border-transparent text-ink-200 hover:bg-ink-800',
            )}
            title={c.title ?? 'Untitled conversation'}
          >
            {c.title ?? 'Untitled conversation'}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1 border-t border-ink-700 p-3">
        <UsageMeter lastTokens={lastTokens} refreshSignal={usageRefreshSignal} />
        <button
          type="button"
          onClick={onOpenMemory}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-200 hover:bg-ink-800"
        >
          <Brain size={16} /> Memory
        </button>
        <button
          type="button"
          onClick={onOpenKeyVault}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-200 hover:bg-ink-800"
        >
          <KeyRound size={16} /> API keys
        </button>
        <button
          type="button"
          onClick={onOpenUpgrade}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-200 hover:bg-ink-800"
        >
          <Crown size={16} /> Upgrade
        </button>
        <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-ink-200">
          <span className="truncate">{user.name ?? user.email ?? 'Signed in'}</span>
          <button type="button" aria-label="Log out" onClick={onLogout} className="text-ink-400 hover:text-danger-500">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
