import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  SquarePen, Search, Folder, Sparkles, Trash2, PanelLeftClose, ChevronsUpDown,
  Settings, Brain, Plug, KeyRound, Upload, MonitorSmartphone, Gem, BookOpen, LogOut, ChartColumn,
} from 'lucide-react';
import UsageMeter from './UsageMeter.js';
import CascadeMark from '../components/CascadeMark.js';
import Menu, { type MenuItem } from '../components/Menu.js';
import TierMix from './TierMix.js';
import { deleteConversation, fetchUsage, importConversation, importMemories, searchConversations, type UsageInfo } from '../lib/api.js';
import { toast } from '../lib/toast.js';
import type { CloudConversation, CloudUser } from '../lib/types.js';

interface Props {
  user: CloudUser;
  conversations: CloudConversation[];
  activeConversationId: string | undefined;
  /** The chats a run is working in right now, each marked with a pulsing dot. */
  runningConversationIds?: string[];
  contextTokens: number;
  contextWindow: number;
  lastTokens: number;
  usageRefreshSignal: unknown;
  /** Opens the chat search (⌘K / Ctrl+K reaches it from anywhere). */
  searchRequest?: number;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenFiles: () => void;
  onOpenSkills: () => void;
  onOpenMemory: () => void;
  onOpenConnectors: () => void;
  onOpenKeys: () => void;
  onOpenContinue: () => void;
  onOpenUpgrade: () => void;
  /** Opens the spend & savings report. */
  onOpenSpend: () => void;
  onLogout: () => void;
  /** Called after a chat is deleted so the parent can update its list/active id. */
  onDeleted: (id: string) => void;
  /** Called after chats/memories are imported so the parent can reload. */
  onImported: () => void;
}

export default function ConversationSidebar({
  user, conversations, activeConversationId, runningConversationIds = [],
  contextTokens, contextWindow, lastTokens, usageRefreshSignal, searchRequest,
  onSelect, onNewChat, onClose, onOpenSettings, onOpenFiles, onOpenSkills, onOpenMemory,
  onOpenConnectors, onOpenKeys, onOpenContinue, onOpenUpgrade, onOpenSpend, onLogout, onDeleted, onImported,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  // The server's answer for the current query: it searches every chat, where
  // `conversations` is only the most recent page. It holds for the list it was
  // asked against — a rename or delete anywhere (the top bar's too) makes a new
  // list, and the search is asked again.
  const [found, setFound] = useState<{
    query: string; basis: CloudConversation[]; conversations: CloudConversation[]; hasMore: boolean;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    fetchUsage().then(setUsage).catch(() => setUsage(null));
  }, [usageRefreshSignal]);

  useEffect(() => {
    if (!searchRequest) return;
    setSearching(true);
    // Focus after the input mounts.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchRequest]);

  async function remove(id: string) {
    try {
      await deleteConversation(id);
      onDeleted(id);
      // At once, without waiting for the search to be asked again.
      setFound((f) => (f ? { ...f, conversations: f.conversations.filter((c) => c.id !== id) } : f));
    } catch { toast('Could not delete that chat.'); }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
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
      toast(chats || mems ? `Imported ${chats} chat${chats === 1 ? '' : 's'}${mems ? `, ${mems} memor${mems === 1 ? 'y' : 'ies'}` : ''}.` : 'Nothing to import in that file.');
      if (chats) onImported();
    } catch {
      toast('That file could not be imported.');
    }
  }

  const q = query.trim().toLowerCase();
  useEffect(() => {
    if (!q) { setFound(null); return; }
    let current = true;
    // A pause in typing, not every keystroke, reaches the server.
    const timer = setTimeout(() => {
      searchConversations(q)
        .then((r) => { if (current) setFound({ query: q, basis: conversations, conversations: r.conversations, hasMore: r.hasMore }); })
        .catch(() => { /* the recent page's matches stay on screen */ });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [q, conversations]);
  const answered = found && found.query === q && found.basis === conversations ? found : null;

  async function loadMore() {
    if (!answered || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await searchConversations(q, answered.conversations.at(-1));
      setFound((f) => {
        if (f !== answered) return f; // the query or the list moved on meanwhile
        const have = new Set(f.conversations.map((c) => c.id));
        return { ...f, conversations: [...f.conversations, ...r.conversations.filter((c) => !have.has(c.id))], hasMore: r.hasMore };
      });
    } catch {
      toast('Could not load more results.');
    } finally {
      setLoadingMore(false);
    }
  }

  // The recent page's matches show at once; the full search replaces them when it answers.
  const shown = !q
    ? conversations
    : answered
      ? answered.conversations
      : conversations.filter((c) => (c.title ?? '').toLowerCase().includes(q));
  const name = user.name ?? user.email ?? 'Signed in';
  const atLimit = usage ? usage.dailyRuns >= usage.dailyRunLimit : false;
  const plan = usage?.plan ? usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1) : null;

  const accountItems: MenuItem[] = [
    {
      kind: 'custom',
      key: 'usage',
      render: (
        <div className="px-2 pb-1">
          <UsageMeter contextTokens={contextTokens} contextWindow={contextWindow} lastRunTokens={lastTokens} refreshSignal={usageRefreshSignal} />
          <TierMix refreshSignal={usageRefreshSignal} />
        </div>
      ),
    },
    { kind: 'action', label: 'Spend & savings', icon: <ChartColumn size={15} />, onSelect: onOpenSpend },
    { kind: 'separator' },
    { kind: 'action', label: 'Settings', icon: <Settings size={15} />, onSelect: onOpenSettings },
    { kind: 'action', label: 'Memory', icon: <Brain size={15} />, onSelect: onOpenMemory },
    { kind: 'action', label: 'Connectors', icon: <Plug size={15} />, onSelect: onOpenConnectors },
    { kind: 'action', label: 'API keys', icon: <KeyRound size={15} />, onSelect: onOpenKeys },
    { kind: 'action', label: 'Files', icon: <Folder size={15} />, onSelect: onOpenFiles },
    { kind: 'action', label: 'Import chats or memories', icon: <Upload size={15} />, onSelect: () => fileRef.current?.click() },
    { kind: 'action', label: 'Continue on another device', icon: <MonitorSmartphone size={15} />, onSelect: onOpenContinue },
    { kind: 'action', label: 'Upgrade', icon: <Gem size={15} />, onSelect: onOpenUpgrade },
    { kind: 'action', label: 'Documentation', icon: <BookOpen size={15} />, onSelect: () => window.open('/docs', '_blank', 'noopener') },
    { kind: 'separator' },
    { kind: 'action', label: 'Sign out', icon: <LogOut size={15} />, onSelect: onLogout },
  ];

  const nav = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[14px] text-ink-50 hover:bg-elev/[0.05]';

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-0.5 px-2.5 py-3">
      <div className="flex items-center gap-[9px] px-2 pb-3 pt-1">
        <CascadeMark size={22} animate={false} />
        <span className="flex-1 font-serif text-[20px] font-medium tracking-[-0.01em] text-ink-50">Cascade</span>
        <button type="button" aria-label="Close sidebar" onClick={onClose} className="cz-ib cz-ib-sm">
          <PanelLeftClose size={14} />
        </button>
      </div>

      <button type="button" onClick={onNewChat} className={nav}>
        <SquarePen size={17} className="text-ink-300" /> New chat
      </button>
      {searching ? (
        <label className="my-0.5 flex h-[34px] items-center gap-2 rounded-lg bg-card px-2.5" style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--c-elev) / 0.17)' }}>
          <Search size={14} className="text-ink-300" />
          <span className="sr-only">Search chats</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearching(false); setQuery(''); } }}
            placeholder="Search chats"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink-50 outline-none placeholder:text-ink-500"
          />
        </label>
      ) : (
        <button type="button" onClick={() => { setSearching(true); requestAnimationFrame(() => searchRef.current?.focus()); }} className={nav}>
          <Search size={17} className="text-ink-300" /> Search
        </button>
      )}
      <button type="button" onClick={onOpenFiles} className={nav}>
        <Folder size={17} className="text-ink-300" /> Files
      </button>
      <button type="button" onClick={onOpenSkills} className={nav}>
        <Sparkles size={17} className="text-ink-300" /> Skills
      </button>

      <div className="px-2.5 pb-1.5 pt-[18px] text-[11.5px] font-medium tracking-[0.02em] text-ink-500">Recents</div>
      <div className="flex min-h-10 flex-1 flex-col gap-px overflow-y-auto">
        {shown.map((c) => {
          const active = c.id === activeConversationId;
          return (
            <div
              key={c.id}
              className={clsx(
                'group flex items-center rounded-lg',
                active ? 'bg-sunk text-ink-50' : 'text-ink-300 hover:bg-elev/[0.05] hover:text-ink-50',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={active ? 'page' : undefined}
                className="min-w-0 flex-1 truncate px-2.5 py-[7px] text-left text-[13.5px]"
                title={c.title ?? 'Untitled conversation'}
              >
                {c.title ?? 'Untitled conversation'}
              </button>
              {runningConversationIds.includes(c.id) && (
                <span title="Working" className="mr-1.5 h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-accent-500" />
              )}
              <button
                type="button"
                aria-label="Delete chat"
                onClick={() => void remove(c.id)}
                className="cz-ib cz-ib-sm opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
        {shown.length === 0 && (
          <p className="m-0 px-2.5 py-1.5 text-[13px] text-ink-500">{q ? 'No matches' : 'No chats yet'}</p>
        )}
        {answered?.hasMore && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg px-2.5 py-[7px] text-left text-[13px] text-ink-400 hover:bg-elev/[0.05] hover:text-ink-50 disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'More results'}
          </button>
        )}
      </div>

      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
      <button
        type="button"
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={!!accountAnchor}
        onClick={(e) => setAccountAnchor(accountAnchor ? null : e.currentTarget)}
        className="mt-1.5 flex w-full items-center gap-2.5 rounded-[10px] p-2 text-left hover:bg-elev/[0.05]"
      >
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-ink-50 text-[12.5px] font-semibold text-paper">
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] text-ink-50">{name}</span>
          {usage && (
            <small className={clsx('block truncate text-[12px]', atLimit ? 'text-danger-500' : 'text-ink-500')}>
              {plan ? `${plan} · ` : ''}{usage.dailyRuns}/{usage.dailyRunLimit} runs today
            </small>
          )}
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-ink-400" />
      </button>
      {accountAnchor && (
        <Menu label="Account" anchor={accountAnchor} items={accountItems} onClose={() => setAccountAnchor(null)} />
      )}
    </div>
  );
}
