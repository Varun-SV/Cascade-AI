import { useState } from 'react';
import { PanelLeft, ChevronDown, TrendingDown, Pencil, Folder, MonitorSmartphone, Trash2 } from 'lucide-react';
import Menu, { type MenuItem } from '../components/Menu.js';

interface Props {
  title: string | undefined;
  /** False until the chat exists on the server: a new chat has nothing to rename or delete. */
  hasConversation: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  /** What delegation saved across this chat's replies (from their stored /why reports). */
  savedUsd: number;
  /** What those replies cost, and how many of them saved anything. */
  spentUsd?: number;
  savedReplies?: number;
  /** Opens /why on the latest reply. */
  onShowWhy: () => void;
  onRename: (title: string) => Promise<void>;
  onContinueElsewhere: () => void;
  onOpenFiles: () => void;
  onDeleteChat: () => void;
}

function money(v: number): string {
  return v < 0.01 ? v.toFixed(4) : v.toFixed(2);
}

export default function ChatTopBar({
  title, hasConversation, sidebarOpen, onOpenSidebar, savedUsd, spentUsd = 0, savedReplies = 0, onShowWhy,
  onRename, onContinueElsewhere, onOpenFiles, onDeleteChat,
}: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [savedAnchor, setSavedAnchor] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  const items: MenuItem[] = [
    { kind: 'action', label: 'Rename', icon: <Pencil size={15} />, onSelect: () => { setDraft(title ?? ''); setRenaming(true); } },
    { kind: 'action', label: 'Files', icon: <Folder size={15} />, onSelect: onOpenFiles },
    { kind: 'action', label: 'Continue on another device', icon: <MonitorSmartphone size={15} />, onSelect: onContinueElsewhere },
    { kind: 'separator' },
    { kind: 'action', label: 'Delete chat', icon: <Trash2 size={15} />, onSelect: onDeleteChat },
  ];

  // The figure is the whole chat's, so it opens the whole chat's account —
  // the latest reply's /why explains only that reply.
  const allT1 = spentUsd + savedUsd;
  const savedItems: MenuItem[] = [
    {
      kind: 'custom',
      key: 'summary',
      render: (
        <div className="flex flex-col gap-2.5 px-[9px] py-2 text-[13px] text-ink-300">
          <p className="m-0 font-medium text-ink-50">
            Saved <span className="receipt text-success-300">${money(savedUsd)}</span>
            {allT1 > 0 && <> · {Math.round((savedUsd / allT1) * 100)}% less than all-T1</>}
          </p>
          <div className="receipt grid grid-cols-[4.5rem_1fr_auto] items-center gap-x-2.5 gap-y-1.5 text-ink-400">
            <span>This chat</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-sunk">
              <span className="block h-full rounded-full" style={{ width: `${allT1 > 0 ? Math.max(2, (spentUsd / allT1) * 100) : 0}%`, background: 'var(--cascade-ramp-x)' }} />
            </span>
            <span>${spentUsd.toFixed(4)}</span>
            <span>All on T1</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-sunk"><span className="block h-full w-full rounded-full bg-ink-500" /></span>
            <span>${allT1.toFixed(4)}</span>
          </div>
          <p className="m-0 text-[12px] text-ink-500">
            Across {savedReplies} {savedReplies === 1 ? 'reply' : 'replies'} that delegated below T1.
          </p>
        </div>
      ),
    },
    { kind: 'separator' },
    { kind: 'action', label: 'Explain the latest reply', onSelect: onShowWhy },
  ];

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== title) await onRename(next);
  }

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-1.5 px-3">
      {/* The sidebar's own close button lives in the sidebar; this reopens it. */}
      {!sidebarOpen && (
        <button type="button" aria-label="Open sidebar" onClick={onOpenSidebar} className="cz-ib">
          <PanelLeft size={17} />
        </button>
      )}
      <span className="min-w-0 flex-1" />
      {renaming ? (
        <form onSubmit={(e) => void submitRename(e)} className="flex items-center gap-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(false); }}
            aria-label="Chat title"
            maxLength={120}
            className="cz-field h-8 w-[min(340px,50vw)]"
          />
          <button type="submit" className="cz-btn cz-btn-sm">Save</button>
        </form>
      ) : hasConversation ? (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={!!anchor}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
          className="inline-flex min-w-0 max-w-[min(52vw,480px)] items-center gap-1 rounded-lg px-2.5 py-1.5 text-[13.5px] text-ink-300 hover:bg-elev/[0.05] hover:text-ink-50"
        >
          <span className="truncate">{title ?? 'New chat'}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      ) : null}
      <span className="min-w-0 flex-1" />
      {savedUsd > 0 && (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={!!savedAnchor}
          onClick={(e) => setSavedAnchor(savedAnchor ? null : e.currentTarget)}
          title="What delegation saved in this chat"
          className="receipt inline-flex shrink-0 items-center gap-1.5 rounded-lg px-[9px] py-[5px] text-success-300 hover:bg-elev/[0.05]"
        >
          <TrendingDown size={14} /> saved ${money(savedUsd)}
        </button>
      )}
      {anchor && <Menu label="Chat" anchor={anchor} items={items} onClose={() => setAnchor(null)} />}
      {savedAnchor && <Menu label="What this chat saved" anchor={savedAnchor} items={savedItems} onClose={() => setSavedAnchor(null)} />}
    </header>
  );
}
