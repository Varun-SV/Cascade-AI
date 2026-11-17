import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import BrowserSettings from './BrowserSettings.js';
import { fetchBrowserPrefs, removeBrowserEndpoint, saveBrowserEndpoint, setBrowserSource, type BrowserPrefs } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  fetchBrowserPrefs: vi.fn(), setBrowserSource: vi.fn(), saveBrowserEndpoint: vi.fn(), removeBrowserEndpoint: vi.fn(),
  fetchRelayDevices: vi.fn().mockResolvedValue([]), removeRelayDevice: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const prefs = (over: Partial<BrowserPrefs> = {}): BrowserPrefs => ({
  source: 'device', endpoint: null, offers: { device: true, endpoint: true, desktop: true }, privateEndpoints: false, ...over,
});

describe('Settings → Browser: where runs get a browser (stage 6)', () => {
  it('offers only the sources this server offers', async () => {
    vi.mocked(fetchBrowserPrefs).mockResolvedValue(prefs({ offers: { device: true, endpoint: false, desktop: true } }));
    render(<BrowserSettings />);
    const group = await screen.findByRole('group', { name: 'Where runs get a browser' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['My devices', 'Run on my desktop']);
    // The device list is the device source's.
    expect(await screen.findByText('Your devices')).toBeInTheDocument();
  });

  it('saves an endpoint, then shows only its host; a refusal is said', async () => {
    const onChange = vi.fn();
    vi.mocked(fetchBrowserPrefs).mockResolvedValue(prefs({ source: 'endpoint' }));
    vi.mocked(saveBrowserEndpoint)
      .mockRejectedValueOnce(new Error('That address is on a private network, which this server doesn\'t connect to.'))
      .mockResolvedValueOnce(prefs({ source: 'endpoint', endpoint: { host: 'connect.steel.dev' } }));
    render(<BrowserSettings onChange={onChange} />);
    const field = await screen.findByLabelText('Connect address');
    fireEvent.change(field, { target: { value: 'wss://127.0.0.1:9222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('private network');
    fireEvent.change(field, { target: { value: 'wss://connect.steel.dev?apiKey=SECRET' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('connect.steel.dev')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SECRET');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: { host: 'connect.steel.dev' } }));
    vi.mocked(removeBrowserEndpoint).mockResolvedValue(prefs({ source: 'endpoint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByLabelText('Connect address')).toBeInTheDocument();
  });

  it('choosing the desktop says what will happen to a browser message', async () => {
    vi.mocked(fetchBrowserPrefs).mockResolvedValue(prefs());
    vi.mocked(setBrowserSource).mockResolvedValue(prefs({ source: 'desktop' }));
    render(<BrowserSettings />);
    fireEvent.click(within(await screen.findByRole('group', { name: 'Where runs get a browser' })).getByRole('button', { name: 'Run on my desktop' }));
    await waitFor(() => expect(setBrowserSource).toHaveBeenCalledWith('desktop'));
    expect(await screen.findByText(/handed to the Cascade desktop app with a one-time code/)).toBeInTheDocument();
  });
});
