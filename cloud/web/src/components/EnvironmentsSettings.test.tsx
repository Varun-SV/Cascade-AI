import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import EnvironmentsSettings, { mergeDevices } from './EnvironmentsSettings.js';
import { fetchRelayDevices, fetchWorkspaceDevices, removeRelayDevice, renameRelayDevice, type RelayDevice } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  fetchRelayDevices: vi.fn(), fetchWorkspaceDevices: vi.fn(), removeRelayDevice: vi.fn(), renameRelayDevice: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const NOW = Date.UTC(2026, 10, 17, 12, 0);
const devices: RelayDevice[] = [
  { id: 'd1', name: 'Work Chrome', kind: 'extension', createdAt: 0, lastSeenAt: NOW, online: true },
  { id: 'd2', name: 'Laptop', kind: 'cli', createdAt: 0, lastSeenAt: NOW - 3 * 3600_000, online: false },
  { id: 'd3', name: 'Desk PC', kind: 'desktop', createdAt: 0, lastSeenAt: null, online: false },
];
const ws = [{ id: 'd3', name: 'Desk PC', kind: 'desktop' as const, online: true }];

describe('Settings → Environments', () => {
  it('lists each device once, with its kind, whether it is online and what it can do', async () => {
    vi.mocked(fetchRelayDevices).mockResolvedValue(devices);
    vi.mocked(fetchWorkspaceDevices).mockResolvedValue({ devices: ws });
    render(<EnvironmentsSettings browserRelay workspaceRelay now={() => NOW} />);
    expect(await screen.findByText('Work Chrome')).toBeInTheDocument();
    expect(screen.getByText('Chrome extension · Online now')).toBeInTheDocument();
    expect(screen.getByText('Cascade CLI · Last seen 3 h ago')).toBeInTheDocument();
    // The desktop is online for its workspace, which counts as online.
    expect(screen.getByText('Desktop app · Online now')).toBeInTheDocument();
    expect(screen.getAllByText('Desk PC')).toHaveLength(1);
    // Workspace only where the workspace relay lists the device; Browser for every one.
    expect(screen.getAllByText('Workspace')).toHaveLength(1);
    expect(screen.getAllByText('Browser')).toHaveLength(3);
  });

  it("with only workspaces on, lists the workspace relay's devices, and an older server's are desktops", async () => {
    vi.mocked(fetchWorkspaceDevices).mockResolvedValue({ devices: [{ id: 'w1', name: 'Old PC', online: false }, { id: 'w2', name: 'Shell box', kind: 'cli', online: true }] });
    render(<EnvironmentsSettings browserRelay={false} workspaceRelay now={() => NOW} />);
    expect(await screen.findByText('Desktop app · Never connected')).toBeInTheDocument();
    expect(screen.getByText('Cascade CLI · Online now')).toBeInTheDocument();
    expect(fetchRelayDevices).not.toHaveBeenCalled();
    expect(screen.queryByText('Browser')).toBeNull();
    expect(screen.getByText(/browser relay is off on this server/)).toBeInTheDocument();
  });

  it('renames a device and reads the list again', async () => {
    vi.mocked(fetchRelayDevices).mockResolvedValueOnce(devices).mockResolvedValueOnce(devices.map((d) => (d.id === 'd2' ? { ...d, name: 'Study laptop' } : d)));
    vi.mocked(fetchWorkspaceDevices).mockResolvedValue({ devices: [] });
    vi.mocked(renameRelayDevice).mockResolvedValue({ ok: true, name: 'Study laptop' });
    render(<EnvironmentsSettings browserRelay workspaceRelay now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Laptop' }));
    const input = screen.getByLabelText('Device name');
    fireEvent.change(input, { target: { value: '  Study laptop ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(renameRelayDevice).toHaveBeenCalledWith('d2', 'Study laptop', 'browser'));
    expect(await screen.findByText('Study laptop')).toBeInTheDocument();
    expect(screen.queryByLabelText('Device name')).toBeNull();
  });

  it('cancelling a rename changes nothing', async () => {
    vi.mocked(fetchRelayDevices).mockResolvedValue(devices);
    vi.mocked(fetchWorkspaceDevices).mockResolvedValue({ devices: [] });
    render(<EnvironmentsSettings browserRelay workspaceRelay now={() => NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Laptop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));
    expect(renameRelayDevice).not.toHaveBeenCalled();
    expect(screen.getByText('Laptop')).toBeInTheDocument();
  });

  it('removes a device only after the user confirms, through the relay that is on', async () => {
    vi.mocked(fetchWorkspaceDevices).mockResolvedValueOnce({ devices: [{ id: 'w1', name: 'Old PC', online: true }] }).mockResolvedValueOnce({ devices: [] });
    vi.mocked(removeRelayDevice).mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<EnvironmentsSettings browserRelay={false} workspaceRelay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Old PC' }));
    expect(removeRelayDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Old PC' }));
    await waitFor(() => expect(removeRelayDevice).toHaveBeenCalledWith('w1', 'workspace'));
    await waitFor(() => expect(screen.queryByText('Old PC')).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('with none paired, says how to connect each kind and links the docs', async () => {
    vi.mocked(fetchRelayDevices).mockResolvedValue([]);
    vi.mocked(fetchWorkspaceDevices).mockResolvedValue({ devices: [] });
    render(<EnvironmentsSettings browserRelay workspaceRelay />);
    expect(await screen.findByText('No devices yet. Connect one below.')).toBeInTheDocument();
    expect(screen.getByText(/Settings → Cloud runs and pair it/)).toBeInTheDocument();
    expect(screen.getByText('cascade relay pair')).toBeInTheDocument();
    expect(screen.getByText('cascade relay serve')).toBeInTheDocument();
    expect(screen.getByText('cascade workspace serve [folder]')).toBeInTheDocument();
    expect(screen.getByText(/Chrome extension:/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('href', '/docs/workspaces');
    expect(screen.getByRole('link', { name: 'Browser relay' })).toHaveAttribute('href', '/docs/browser-relay');
  });

  it('with both relays off, says so, points self-hosters at the settings, and reads no list', () => {
    render(<EnvironmentsSettings browserRelay={false} workspaceRelay={false} />);
    expect(screen.getByRole('note')).toHaveTextContent('turned off');
    expect(screen.getByText('WORKSPACE_RELAY')).toBeInTheDocument();
    expect(screen.getByText('BROWSER_RELAY')).toBeInTheDocument();
    expect(fetchRelayDevices).not.toHaveBeenCalled();
    expect(fetchWorkspaceDevices).not.toHaveBeenCalled();
    expect(screen.queryByText('Your devices')).toBeNull();
  });

  it('a failed load says so instead of showing an empty list', async () => {
    vi.mocked(fetchRelayDevices).mockRejectedValue(new Error('Not signed in'));
    vi.mocked(fetchWorkspaceDevices).mockResolvedValue({ devices: [] });
    render(<EnvironmentsSettings browserRelay workspaceRelay />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not signed in');
    expect(screen.queryByText('No devices yet. Connect one below.')).not.toBeInTheDocument();
  });
});

describe('mergeDevices', () => {
  it('keeps a CLI listed by the workspace relay as workspace-capable', () => {
    const rows = mergeDevices([devices[1]!], [{ id: 'd2', name: 'Laptop', kind: 'cli', online: true }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'cli', browser: { online: false }, workspace: { online: true } });
  });
});
