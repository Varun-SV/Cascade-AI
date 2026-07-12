import { MessageSquarePlus, KeyRound, LogOut, Crown } from 'lucide-react';
import type { CloudConversation, CloudUser } from '../lib/types.js';

interface Props {
  user: CloudUser;
  conversations: CloudConversation[];
  activeConversationId: string | undefined;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenKeyVault: () => void;
  onOpenUpgrade: () => void;
  onLogout: () => void;
}

export default function ConversationSidebar({
  user, conversations, activeConversationId, onSelect, onNewChat, onOpenKeyVault, onOpenUpgrade, onLogout,
}: Props) {
  return (
    <div className="flex h-full w-64 flex-col border-r border-cascade-900 bg-cascade-950/40">
      <div className="p-3">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-md border border-cascade-700 px-3 py-2 text-sm text-cascade-100 hover:bg-cascade-900"
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
            className={
              'mb-1 block w-full truncate rounded-md px-3 py-2 text-left text-sm ' +
              (c.id === activeConversationId ? 'bg-cascade-800 text-white' : 'text-cascade-300 hover:bg-cascade-900')
            }
            title={c.title ?? 'Untitled conversation'}
          >
            {c.title ?? 'Untitled conversation'}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1 border-t border-cascade-900 p-3">
        <button
          type="button"
          onClick={onOpenKeyVault}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-cascade-300 hover:bg-cascade-900"
        >
          <KeyRound size={16} /> API keys
        </button>
        <button
          type="button"
          onClick={onOpenUpgrade}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-cascade-300 hover:bg-cascade-900"
        >
          <Crown size={16} /> Upgrade
        </button>
        <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-cascade-300">
          <span className="truncate">{user.name ?? user.email ?? 'Signed in'}</span>
          <button type="button" aria-label="Log out" onClick={onLogout} className="text-cascade-400 hover:text-red-400">
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
