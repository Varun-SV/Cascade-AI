import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import BrowserDevices from './BrowserDevices.js';
import { fetchRelayDevices, removeRelayDevice, type RelayDevice } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({ fetchRelayDevices: vi.fn(), removeRelayDevice: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const NOW = Date.UTC(2026, 10, 17, 12, 0);
const devices: RelayDevice[] = [
  { id: 'd1', name: 'Work Chrome', kind: 'extension', createdAt: 0, lastSeenAt: NOW, online: true },
  { id: 'd2', name: 'Laptop', kind: 'cli', createdAt: 0, lastSeenAt: NOW - 3 * 3600_000, online: false },
  { id: 'd3', name: 'Spare', kind: 'cli', createdAt: 0, lastSeenAt: null, online: false },
];

describe('Settings → Browser', () => {
  it('lists the paired devices with whether each is online now', async () => {
    vi.mocked(fetchRelayDevices).mockResolvedValue(devices);
    render(<BrowserDevices now={() => NOW} />);
    expect(await screen.findByText('Work Chrome')).toBeInTheDocument();
    expect(screen.getByText('Chrome extension · Online now')).toBeInTheDocument();
    expect(screen.getByText('Computer (Cascade CLI) · Last seen 3 h ago')).toBeInTheDocument();
    expect(screen.getByText('Computer (Cascade CLI) · Never connected')).toBeInTheDocument();
  });

  it('removes a device only after the user confirms, then shows the list again', async () => {
    vi.mocked(fetchRelayDevices).mockResolvedValueOnce(devices).mockResolvedValueOnce(devices.slice(1));
    vi.mocked(removeRelayDevice).mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<BrowserDevices now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Work Chrome' }));
    expect(removeRelayDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work Chrome' }));
    await waitFor(() => expect(removeRelayDevice).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(screen.queryByText('Work Chrome')).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('with none paired, says how to add one', async () => {
    vi.mocked(fetchRelayDevices).mockResolvedValue([]);
    render(<BrowserDevices now={() => NOW} />);
    expect(await screen.findByText('No devices yet. Pair one below.')).toBeInTheDocument();
    expect(screen.getByText('cascade relay pair')).toBeInTheDocument();
  });

  it('a failed load says so instead of showing an empty list', async () => {
    vi.mocked(fetchRelayDevices).mockRejectedValue(new Error('Not signed in'));
    render(<BrowserDevices now={() => NOW} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not signed in');
    expect(screen.queryByText('No devices yet. Pair one below.')).not.toBeInTheDocument();
  });
});
