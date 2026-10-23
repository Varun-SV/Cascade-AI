import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ConversationSidebar from './ConversationSidebar.js';
import { searchConversations } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  fetchUsage: vi.fn().mockResolvedValue({ plan: 'free', dailyRuns: 20, dailyRunLimit: 20, maxConcurrentRuns: 1 }),
  fetchTierMix: vi.fn().mockResolvedValue({ mix: [] }),
  deleteConversation: vi.fn(),
  importConversation: vi.fn(),
  importMemories: vi.fn(),
  // The server searches every chat; this one is older than the recent page.
  searchConversations: vi.fn(async (q: string) => ({
    conversations: [
      { id: 'c2', title: 'Team offsite plan' },
      { id: 'c9', title: 'Offsite budget from last year' },
    ].filter((c) => c.title.toLowerCase().includes(q)),
  })),
}));

afterEach(cleanup);

const noop = () => {};
const recent = [
  { id: 'c1', title: 'Postgres vs SQLite' },
  { id: 'c2', title: 'Team offsite plan' },
];
function renderSidebar(over: Partial<React.ComponentProps<typeof ConversationSidebar>> = {}) {
  const props = {
    user: { id: 'u1', name: 'Varun', email: null, avatar: null, provider: 'dev', plan: 'free' } as never,
    conversations: recent as never,
    activeConversationId: 'c1',
    runningConversationIds: ['c2'],
    contextTokens: 0,
    contextWindow: 0,
    lastTokens: 0,
    usageRefreshSignal: 0,
    onSelect: noop, onNewChat: noop, onClose: noop, onOpenSettings: noop, onOpenFiles: noop,
    onOpenSkills: noop, onOpenMemory: noop, onOpenConnectors: noop, onOpenKeys: noop,
    onOpenContinue: noop, onOpenUpgrade: noop, onOpenSpend: noop, onLogout: noop, onDeleted: noop, onImported: noop,
    ...over,
  };
  const { rerender } = render(<ConversationSidebar {...props} />);
  return (more: Partial<typeof props>) => rerender(<ConversationSidebar {...props} {...more} />);
}

function search(text: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.change(screen.getByPlaceholderText('Search chats'), { target: { value: text } });
}

describe('ConversationSidebar', () => {
  it('filters Recents by title from Search', () => {
    renderSidebar();
    search('offsite');
    expect(screen.getByText('Team offsite plan')).toBeInTheDocument();
    expect(screen.queryByText('Postgres vs SQLite')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search chats'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('finds older chats the recent page does not hold, once the server answers', async () => {
    renderSidebar();
    search('offsite');
    // The recent page's match shows at once…
    expect(screen.getByText('Team offsite plan')).toBeInTheDocument();
    // …and the full search adds the one beyond it.
    expect(await screen.findByText('Offsite budget from last year')).toBeInTheDocument();
    expect(vi.mocked(searchConversations)).toHaveBeenCalledWith('offsite');
  });

  it('drops a deleted chat from the search results too', async () => {
    renderSidebar();
    search('offsite');
    const row = (await screen.findByText('Offsite budget from last year')).parentElement!;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(screen.queryByText('Offsite budget from last year')).not.toBeInTheDocument());
  });

  it('asks the search again when a chat is renamed or deleted elsewhere, and shows no stale row meanwhile', async () => {
    const rerender = renderSidebar();
    search('offsite');
    expect(await screen.findByText('Offsite budget from last year')).toBeInTheDocument();
    const asked = vi.mocked(searchConversations).mock.calls.length;
    // The top bar deletes the older chat: the parent's list is a new one, and
    // the server no longer has it.
    vi.mocked(searchConversations).mockResolvedValueOnce({ conversations: [{ id: 'c2', title: 'Team offsite plan' }] as never, hasMore: false });
    rerender({ conversations: [...recent] as never });
    expect(screen.queryByText('Offsite budget from last year')).not.toBeInTheDocument();
    expect(screen.getByText('Team offsite plan')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(searchConversations).mock.calls.length).toBe(asked + 1));
    expect(screen.queryByText('Offsite budget from last year')).not.toBeInTheDocument();
  });

  it('pages through a search with more matches than one answer holds', async () => {
    const first = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, title: `Offsite ${i}`, updatedAt: 300 - i }));
    vi.mocked(searchConversations)
      .mockResolvedValueOnce({ conversations: first as never, hasMore: true })
      .mockResolvedValueOnce({ conversations: [{ id: 's9', title: 'Offsite 2019', updatedAt: 9 }] as never, hasMore: false });
    renderSidebar();
    search('offsite');
    fireEvent.click(await screen.findByRole('button', { name: 'More results' }));
    expect(await screen.findByText('Offsite 2019')).toBeInTheDocument();
    expect(vi.mocked(searchConversations)).toHaveBeenLastCalledWith('offsite', first[2]);
    expect(screen.getByText('Offsite 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More results' })).not.toBeInTheDocument();
  });

  it('marks the open chat and the one a run is working in', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Postgres vs SQLite' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTitle('Working')).toBeInTheDocument();
  });

  it('shows the plan and today’s runs on the account button, in red at the limit', async () => {
    renderSidebar();
    const line = await screen.findByText('Free · 20/20 runs today');
    expect(line.className).toContain('text-danger-500');
  });

  it('keeps every account action in the account menu', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    for (const name of ['Spend & savings', 'Settings', 'Memory', 'Connectors', 'API keys', 'Files', 'Import chats or memories',
      'Continue on another device', 'Upgrade', 'Documentation', 'Sign out']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('opens the spend & savings report from the account menu', () => {
    const onOpenSpend = vi.fn();
    renderSidebar({ onOpenSpend });
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spend & savings' }));
    expect(onOpenSpend).toHaveBeenCalledTimes(1);
  });
});
