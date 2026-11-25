import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import Composer from './Composer.js';

vi.mock('../lib/api.js', () => ({
  uploadImage: vi.fn(),
  uploadUrl: (id: string) => `/api/uploads/${encodeURIComponent(id)}`,
  uploadDocument: vi.fn(),
  fetchMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
  setMcpServerEnabled: vi.fn(),
}));

afterEach(cleanup);

type Picker = NonNullable<ComponentProps<typeof Composer>['workspace']>;

const base = {
  skills: [], skillId: '', onSkillChange: vi.fn(), hasProviders: true, busy: false, onSend: vi.fn(), onStop: vi.fn(),
  routingMode: 'auto' as const, onRoutingModeChange: vi.fn(), forceTier: 'auto' as const, onForceTierChange: vi.fn(),
  webSearch: false, onWebSearchChange: vi.fn(), browserMode: false, onBrowserModeChange: vi.fn(), browserAvailable: false,
};
const devices = [{ id: 'd1', name: 'Work PC', online: true }, { id: 'd2', name: 'Home PC', online: false }];
const picker = (over: Partial<Picker> = {}): Picker => ({
  devices, known: true, loading: false, selected: undefined, onSelect: vi.fn(), onOpen: vi.fn(), ...over,
});

describe('the environment picker', () => {
  it('is absent when the server has no workspace relay', () => {
    render(<Composer {...base} />);
    expect(screen.queryByRole('button', { name: 'Environment' })).toBeNull();
  });

  it('with workspaces off on the server, is still there: Cloud stays chosen, nothing else is, and it says why', () => {
    const ws = picker({ devices: [], unavailable: true });
    render(<Composer {...base} workspace={ws} />);
    fireEvent.click(screen.getByRole('button', { name: 'Environment' }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);
    expect(screen.getByRole('menuitemradio', { name: /Cloud \(no files\)/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/doesn.t have workspaces turned on, so runs work in the Cloud only/)).toBeInTheDocument();
    expect(screen.getByText('WORKSPACE_RELAY')).toBeInTheDocument();
    expect(screen.getByText('BROWSER_RELAY')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How workspaces work' })).toHaveAttribute('href', '/docs/workspaces');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Cloud/ }));
    expect(ws.onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('lists Cloud and each computer, re-reads the list on open, and disables an offline one with a hint', () => {
    const ws = picker();
    render(<Composer {...base} workspace={ws} />);
    fireEvent.click(screen.getByRole('button', { name: 'Environment' }));
    expect(ws.onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitemradio', { name: /Cloud \(no files\)/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /Work PC/ })).not.toBeDisabled();
    const home = screen.getByRole('menuitemradio', { name: /Home PC/ });
    expect(home).toBeDisabled();
    expect(home).toHaveTextContent('Open the Cascade desktop app on it and turn workspace serving on');
  });

  it('chooses a computer, and goes back to Cloud', () => {
    const ws = picker();
    render(<Composer {...base} workspace={ws} />);
    fireEvent.click(screen.getByRole('button', { name: 'Environment' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Work PC/ }));
    expect(ws.onSelect).toHaveBeenCalledWith('d1');
    cleanup();
    const chosen = picker({ selected: 'd1' });
    render(<Composer {...base} workspace={chosen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work PC' }));
    expect(chosen.onSelect).toHaveBeenCalledWith(undefined);
  });

  it('with no desktop devices, says how to pair one', () => {
    render(<Composer {...base} workspace={picker({ devices: [] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Environment' }));
    expect(screen.getByText(/Settings → Cloud runs in the desktop app/)).toBeInTheDocument();
  });

  it('turns Fast answer off and keeps it off while a computer is chosen', () => {
    const { rerender } = render(<Composer {...base} workspace={picker()} />);
    fireEvent.click(screen.getByTitle('Routing and tier'));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Fast answer/ }));
    expect(screen.getByRole('button', { name: 'Remove Fast answer' })).toBeInTheDocument();
    rerender(<Composer {...base} workspace={picker({ selected: 'd1' })} />);
    expect(screen.queryByRole('button', { name: 'Remove Fast answer' })).toBeNull();
    // The menu is still open: a toggle leaves it so.
    expect(screen.getByRole('menuitemcheckbox', { name: /Fast answer/ })).toBeDisabled();
  });
});
