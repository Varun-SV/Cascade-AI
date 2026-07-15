import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import Fuse from 'fuse.js';
import {
  Network, MessageSquare, Code2, BarChart3, Settings, TerminalSquare, Radio,
  HelpCircle, GitCompareArrows, Plus, Search, CornerDownLeft, MonitorSmartphone,
} from 'lucide-react';
import {
  useAppDispatch, useAppSelector, setShowPalette, setView, setShowSettings,
  toggleTerminal, openBottomTab, setShowWhyPanel, setChangesSessionId,
  setActiveSessionId, loadTranscript, setSessionSidebarCollapsed, setShowContinue,
} from '../store/index.js';
import { fetchSessionTranscript } from '../utils/sessionLoad.js';

interface PaletteItem {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
  icon: typeof Network;
  run: () => void | Promise<void>;
}

/**
 * Ctrl/Cmd+K command palette: fuzzy jump to any view, action, or past session.
 * Mounted once in App so the shortcut works everywhere; sessions open in Chat
 * with their transcript loaded, exactly like clicking them in the sidebar.
 */
export function CommandPalette({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.app.showPalette);
  const { sessions, activeSessionId, sessionId, backendPort, authToken } = useAppSelector((s) => s.app);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const currentSessionId = activeSessionId ?? sessionId;

  // Global shortcut — Ctrl/Cmd+K toggles, independent of focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dispatch(setShowPalette(!open));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, open]);

  useEffect(() => {
    if (open) { setQuery(''); setCursor(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const close = () => dispatch(setShowPalette(false));

  const openSession = async (id: string) => {
    if (id !== currentSessionId) {
      if (currentSessionId && socket) socket.emit('leave:session', { sessionId: currentSessionId });
      if (socket) socket.emit('join:session', { sessionId: id });
      dispatch(setActiveSessionId(id));
      const messages = await fetchSessionTranscript(backendPort, authToken, id);
      if (messages) dispatch(loadTranscript({ sessionId: id, messages }));
    }
    dispatch(setSessionSidebarCollapsed(true));
    dispatch(setView('chat'));
  };

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: 'view-cockpit',  title: 'Go to Cockpit',  hint: 'Mission Control graph', keywords: 'mission control agents graph', icon: Network,       run: () => { dispatch(setView('cockpit')); } },
      { id: 'view-chat',     title: 'Go to Chat',     keywords: 'conversation messages', icon: MessageSquare, run: () => { dispatch(setView('chat')); } },
      { id: 'view-code',     title: 'Go to Code',     keywords: 'editor files monaco', icon: Code2,         run: () => { dispatch(setView('code')); } },
      { id: 'view-insights', title: 'Go to Insights', hint: 'costs · schedules · audit', keywords: 'analytics costs spend audit schedules cron', icon: BarChart3, run: () => { dispatch(setView('insights')); } },
      { id: 'new-chat',      title: 'New chat',       keywords: 'start fresh session', icon: Plus, run: () => { dispatch(loadTranscript({ sessionId: crypto.randomUUID(), messages: [] })); dispatch(setView('chat')); } },
      { id: 'settings',      title: 'Open Settings',  keywords: 'preferences providers models keys theme', icon: Settings, run: () => { dispatch(setShowSettings(true)); } },
      { id: 'terminal',      title: 'Toggle Terminal', hint: 'Ctrl+`', keywords: 'shell console pty', icon: TerminalSquare, run: () => { dispatch(toggleTerminal()); } },
      { id: 'comms',         title: 'Open Comms feed', hint: 'agent-to-agent chatter', keywords: 'peer messages broadcast radio', icon: Radio, run: () => { dispatch(openBottomTab('comms')); } },
      { id: 'why',           title: 'Why? — explain the last run', hint: 'routing · models · savings', keywords: 'decision trail complexity failover savings inspector', icon: HelpCircle, run: () => { dispatch(setShowWhyPanel(true)); } },
      { id: 'continue',      title: 'Continue elsewhere', hint: 'hand off to / from the web', keywords: 'handoff continue web desktop sync transfer code portable', icon: MonitorSmartphone, run: () => { dispatch(setShowContinue(true)); } },
    ];
    if (currentSessionId) {
      actions.push({
        id: 'changes',
        title: 'Review file changes',
        hint: 'diffs of this session',
        keywords: 'diff revert rollback files',
        icon: GitCompareArrows,
        run: () => { dispatch(setChangesSessionId(currentSessionId)); },
      });
    }
    const sessionItems: PaletteItem[] = [...sessions]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((s) => ({
        id: `session-${s.sessionId}`,
        title: s.title || 'Untitled session',
        hint: s.latestPrompt,
        keywords: 'session chat open resume switch',
        icon: MessageSquare,
        run: () => { void openSession(s.sessionId); },
      }));
    return [...actions, ...sessionItems];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, currentSessionId, dispatch, socket, backendPort, authToken]);

  const results = useMemo(() => {
    if (!query.trim()) return items.slice(0, 12);
    const fuse = new Fuse(items, { keys: ['title', 'hint', 'keywords'], threshold: 0.4, ignoreLocation: true });
    return fuse.search(query).map((r) => r.item).slice(0, 12);
  }, [items, query]);

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const runItem = (item: PaletteItem) => { close(); void item.run(); };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.45)', display: 'flex', justifyContent: 'center', paddingTop: '12vh' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div style={{
        width: 560, maxWidth: '92vw', height: 'fit-content', maxHeight: '64vh',
        background: 'var(--bg-surface)', border: '1px solid var(--border-strong)',
        borderRadius: 12, boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
          <Search size={15} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); close(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(results.length - 1, c + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              else if (e.key === 'Enter' && results[cursor]) { e.preventDefault(); runItem(results[cursor]); }
            }}
            placeholder="Type a command or search sessions…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13.5 }}
          />
          <kbd style={{ fontSize: 9.5, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>esc</kbd>
        </div>
        <div ref={listRef} style={{ overflowY: 'auto', padding: '6px 0' }}>
          {results.length === 0 ? (
            <div style={{ padding: '18px 14px', fontSize: 12.5, color: 'var(--text-dim)', textAlign: 'center' }}>No matches.</div>
          ) : (
            results.map((item, i) => {
              const Icon = item.icon;
              const active = i === cursor;
              return (
                <div
                  key={item.id}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => runItem(item)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: 'pointer',
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                  }}
                >
                  <Icon size={14} style={{ color: active ? 'var(--accent)' : 'var(--text-dim)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: active ? 600 : 400, flexShrink: 0 }}>{item.title}</span>
                  {item.hint && (
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.hint}</span>
                  )}
                  {active && <CornerDownLeft size={11} style={{ marginLeft: 'auto', color: 'var(--text-dim)', flexShrink: 0 }} />}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
