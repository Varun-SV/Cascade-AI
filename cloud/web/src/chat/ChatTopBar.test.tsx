import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ChatTopBar from './ChatTopBar.js';

afterEach(cleanup);

function renderBar(over: Partial<React.ComponentProps<typeof ChatTopBar>> = {}) {
  const props = {
    title: 'Postgres vs SQLite',
    hasConversation: true,
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
  render(<ChatTopBar {...props} />);
  return props;
}

describe('ChatTopBar', () => {
  it('shows what this chat saved, and opens its explanation', () => {
    const { onShowWhy } = renderBar({ savedUsd: 0.3412 });
    fireEvent.click(screen.getByRole('button', { name: /saved \$0\.34/ }));
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
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Storage choice'));
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
