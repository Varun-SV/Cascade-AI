import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ConversationSidebar from './ConversationSidebar.js';

vi.mock('../lib/api.js', () => ({
  fetchUsage: vi.fn().mockResolvedValue({ plan: 'free', dailyRuns: 20, dailyRunLimit: 20, maxConcurrentRuns: 1 }),
  fetchTierMix: vi.fn().mockResolvedValue({ mix: [] }),
  deleteConversation: vi.fn(),
  importConversation: vi.fn(),
  importMemories: vi.fn(),
}));

afterEach(cleanup);

const noop = () => {};
function renderSidebar() {
  render(
    <ConversationSidebar
      user={{ id: 'u1', name: 'Varun', email: null, avatar: null, provider: 'dev', plan: 'free' } as never}
      conversations={[
        { id: 'c1', title: 'Postgres vs SQLite' },
        { id: 'c2', title: 'Team offsite plan' },
      ] as never}
      activeConversationId="c1"
      runningConversationId="c2"
      contextTokens={0}
      contextWindow={0}
      lastTokens={0}
      usageRefreshSignal={0}
      onSelect={noop} onNewChat={noop} onClose={noop} onOpenSettings={noop} onOpenFiles={noop}
      onOpenSkills={noop} onOpenMemory={noop} onOpenConnectors={noop} onOpenKeys={noop}
      onOpenContinue={noop} onOpenUpgrade={noop} onLogout={noop} onDeleted={noop} onImported={noop}
    />,
  );
}

describe('ConversationSidebar', () => {
  it('filters Recents by title from Search', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByPlaceholderText('Search chats'), { target: { value: 'offsite' } });
    expect(screen.getByText('Team offsite plan')).toBeInTheDocument();
    expect(screen.queryByText('Postgres vs SQLite')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search chats'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
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
    for (const name of ['Settings', 'Memory', 'Connectors', 'API keys', 'Files', 'Import chats or memories',
      'Continue on another device', 'Upgrade', 'Documentation', 'Sign out']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });
});
