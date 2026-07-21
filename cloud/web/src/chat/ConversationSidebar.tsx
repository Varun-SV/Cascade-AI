import { useRef, useState } from 'react';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { MessageSquarePlus, Settings, Trash2, Upload } from 'lucide-react';
import UsageMeter from './UsageMeter.js';
import TierMix from './TierMix.js';
import { deleteConversation, importConversation, importMemories } from '../lib/api.js';
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
  /** Called after a chat is deleted so the parent can update its list/active id. */
  onDeleted: (id: string) => void;
  /** Called after chats/memories are imported so the parent can reload. */
  onImported: () => void;
}

export default function ConversationSidebar({
  user, conversations, activeConversationId, lastTokens, usageRefreshSignal,
  onSelect, onNewChat, onOpenSettings, onDeleted, onImported,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  async function remove(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try { await deleteConversation(id); onDeleted(id); } catch { /* stays in list */ }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setNote(null);
    try {
      const data = JSON.parse(await f.text()) as { sessions?: unknown[]; memories?: unknown[] };
      let chats = 0;
      let mems = 0;
      for (const s of Array.isArray(data.sessions) ? data.sessions.slice(0, 100) : []) {
        const sess = s as { title?: string; messages?: Array<{ role?: string; content?: string }> };
        const messages = (sess.messages ?? [])
          .map((m) => ({ role: String(m.role ?? 'user'), content: String(m.content ?? '') }))
          .filter((m) => m.content.trim());
        if (messages.length) { await importConversation({ title: sess.title ?? null, skillId: null, messages }); chats++; }
      }
      if (Array.isArray(data.memories)) mems = (await importMemories(data.memories as Array<string | { content: string }>)).imported;
      setNote(chats || mems ? `Imported ${chats} chat${chats === 1 ? '' : 's'}${mems ? `, ${mems} memor${mems === 1 ? 'y' : 'ies'}` : ''}.` : 'Nothing to import in that file.');
      if (chats) onImported();
    } catch {
      setNote('That file could not be imported.');
    }
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <div className="accent-grad flex h-6 w-6 items-center justify-center rounded-lg text-white shadow-lg">
          <span className="text-xs font-bold">C</span>
        </div>
        <span className="text-sm font-semibold tracking-tight text-ink-50">Cascade Cloud</span>
      </div>

      <div className="flex flex-col gap-2 p-3">
        <motion.button
          type="button"
          onClick={onNewChat}
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          className="flex w-full items-center gap-2 rounded-xl border border-elev/10 bg-elev/[0.04] px-3 py-2.5 text-sm font-medium text-ink-100 hover:bg-elev/[0.08]"
        >
          <MessageSquarePlus size={16} /> New chat
        </motion.button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-ink-400 hover:bg-elev/[0.05] hover:text-ink-200"
        >
          <Upload size={13} /> Import chats or memories
        </button>
        {note && <p className="px-1 text-[11px] text-ink-500">{note}</p>}
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {conversations.map((c) => {
          const active = c.id === activeConversationId;
          return (
            <div
              key={c.id}
              className={clsx(
                'group flex items-center rounded-lg transition-colors',
                active ? 'bg-elev/[0.08] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]' : 'hover:bg-elev/[0.05]',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                className={clsx('min-w-0 flex-1 truncate px-3 py-2 text-left text-sm', active ? 'text-ink-50' : 'text-ink-300')}
                title={c.title ?? 'Untitled conversation'}
              >
                <span className="flex items-center gap-2">
                  {active && <span className="accent-grad h-3.5 w-0.5 shrink-0 rounded-full" />}
                  <span className="truncate">{c.title ?? 'Untitled conversation'}</span>
                </span>
              </button>
              <button
                type="button"
                aria-label="Delete chat"
                onClick={(e) => remove(c.id, e)}
                className="mr-1 shrink-0 rounded p-1 text-ink-500 opacity-0 transition-opacity hover:bg-danger-500/10 hover:text-danger-300 focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
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
