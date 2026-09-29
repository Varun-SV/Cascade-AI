import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ChatTopBar from './ChatTopBar.js';

afterEach(cleanup);

function renderBar(over: Partial<React.ComponentProps<typeof ChatTopBar>> = {}) {
  const props = {
    title: 'Postgres vs SQLite',
    conversationId: 'c1' as string | undefined,
    sidebarOpen: true,
    onOpenSidebar: vi.fn(),
    savedUsd: 0,
    onShowWhy: vi.fn(),
    onRename: vi.fn().mockResolvedValue(undefined),
    onContinueElsewhere: vi.fn(),
    onOpenFiles: vi.fn(),
    onDeleteChat: vi.fn(),
    ...over,
  };
  const { rerender } = render(<ChatTopBar {...props} />);
  return { ...props, rerender };
}

describe('ChatTopBar', () => {
  it('accounts for the whole chat, and opens the latest reply from there', () => {
    const { onShowWhy } = renderBar({ savedUsd: 0.3, spentUsd: 0.1, savedReplies: 3 });
    fireEvent.click(screen.getByRole('button', { name: /saved \$0\.30/ }));
    expect(onShowWhy).not.toHaveBeenCalled();
    const menu = screen.getByRole('menu', { name: 'What this chat saved' });
    expect(menu).toHaveTextContent('Saved $0.30 · 75% less than all-T1');
    expect(menu).toHaveTextContent('Across 3 replies that delegated below T1.');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Explain the latest reply' }));
    expect(onShowWhy).toHaveBeenCalled();
  });

  it('shows nothing saved when nothing was', () => {
    renderBar({ savedUsd: 0 });
    expect(screen.queryByText(/saved/)).not.toBeInTheDocument();
  });

  it('renames the chat from its title menu', async () => {
    const { onRename } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Postgres vs SQLite/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('Chat title');
    fireEvent.change(input, { target: { value: 'Storage choice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('c1', 'Storage choice'));
  });

  it('drops an unsaved rename when another chat opens, rather than renaming that one', () => {
    const { onRename, rerender, ...props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Postgres vs SQLite/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Chat title'), { target: { value: 'Storage choice' } });
    rerender(<ChatTopBar {...props} onRename={onRename} conversationId="c2" title="Team offsite plan" />);
    expect(screen.queryByLabelText('Chat title')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Team offsite plan/ })).toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('offers the sidebar back only while it is closed', () => {
    renderBar({ sidebarOpen: true });
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).not.toBeInTheDocument();
    cleanup();
    const { onOpenSidebar } = renderBar({ sidebarOpen: false });
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    expect(onOpenSidebar).toHaveBeenCalled();
  });
});
