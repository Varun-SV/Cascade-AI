import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import DownloadSection from './DownloadSection.js';
import { fetchDownloads, detectOs, refineMacArch } from '../lib/downloads.js';

vi.mock('../lib/downloads.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/downloads.js')>('../lib/downloads.js');
  return { ...actual, fetchDownloads: vi.fn(), detectOs: vi.fn(), refineMacArch: vi.fn() };
});

const mockFetch = vi.mocked(fetchDownloads);
const mockDetectOs = vi.mocked(detectOs);
const mockRefineArch = vi.mocked(refineMacArch);

const MANIFEST = {
  version: '0.68.0',
  releasedAt: '2026-08-04T06:16:17Z',
  releasesUrl: 'https://github.com/Varun-SV/Cascade-AI/releases/latest',
  targets: [
    { id: 'mac-arm64', os: 'mac', label: 'macOS', detail: 'Apple silicon', filename: 'Cascade-AI-0.68.0-arm64.dmg', sizeBytes: 151237300, url: 'https://github.com/x/arm64.dmg' },
    { id: 'mac-x64', os: 'mac', label: 'macOS', detail: 'Intel', filename: 'Cascade-AI-0.68.0.dmg', sizeBytes: 156061585, url: 'https://github.com/x/x64.dmg' },
    { id: 'win-x64', os: 'windows', label: 'Windows', detail: 'Installer', filename: 'Cascade-AI-Setup-0.68.0.exe', sizeBytes: 127347976, url: 'https://github.com/x/setup.exe' },
    { id: 'linux-appimage', os: 'linux', label: 'Linux', detail: 'AppImage', filename: 'Cascade-AI-0.68.0.AppImage', sizeBytes: 162232955, url: 'https://github.com/x/app.AppImage' },
  ],
} as unknown as Awaited<ReturnType<typeof fetchDownloads>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue(MANIFEST);
  mockRefineArch.mockResolvedValue(null);
});

describe('DownloadSection', () => {
  it('puts the detected platform under one button, with its size', async () => {
    mockDetectOs.mockReturnValue('windows');
    render(<DownloadSection reduced />);

    const button = await screen.findByRole('link', { name: /Download for Windows/ });
    expect(button).toHaveAttribute('href', '/download/win-x64');
    expect(button).toHaveTextContent('127 MB');
  });

  it('defaults a Mac to Apple silicon and offers the Intel build in one click', async () => {
    mockDetectOs.mockReturnValue('mac');
    render(<DownloadSection reduced />);

    const primary = await screen.findByRole('link', { name: /Download for macOS/ });
    expect(primary).toHaveAttribute('href', '/download/mac-arm64');
    expect(primary).toHaveTextContent('Apple silicon');

    // The guess is only a guess on Safari/Firefox, so the escape hatch is
    // visible without opening the full list.
    const intel = await screen.findByRole('link', { name: /Download that build instead/ });
    expect(intel).toHaveAttribute('href', '/download/mac-x64');
  });

  it('corrects the guess when the browser reports an Intel Mac', async () => {
    mockDetectOs.mockReturnValue('mac');
    mockRefineArch.mockResolvedValue('x86');
    render(<DownloadSection reduced />);

    await waitFor(async () => {
      expect(await screen.findByRole('link', { name: /Download for macOS/ })).toHaveAttribute('href', '/download/mac-x64');
    });
    // …and the sibling flips to the one it is no longer offering.
    expect(await screen.findByRole('link', { name: /Download that build instead/ })).toHaveAttribute('href', '/download/mac-arm64');
  });

  it('offers no primary button on a platform with no build, but still lists everything', async () => {
    mockDetectOs.mockReturnValue(null);
    render(<DownloadSection reduced />);

    expect(await screen.findByText(/Pick the build for your machine/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Download for/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /All platforms/ }));
    expect(screen.getByRole('link', { name: /Cascade-AI-0.68.0.AppImage/ })).toHaveAttribute('href', '/download/linux-appimage');
  });

  it('lists every build once when expanded, primary included', async () => {
    mockDetectOs.mockReturnValue('mac');
    render(<DownloadSection reduced />);

    fireEvent.click(await screen.findByRole('button', { name: /All platforms \(4\)/ }));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    // No duplicate of the primary/sibling that were already shown above.
    const hrefs = rows.map((r) => r.querySelector('a')?.getAttribute('href'));
    expect(new Set(hrefs).size).toBe(4);
  });

  it('shows the version it is offering', async () => {
    mockDetectOs.mockReturnValue('linux');
    render(<DownloadSection reduced />);
    expect(await screen.findByText(/Version 0\.68\.0/)).toBeInTheDocument();
  });

  it('falls back to the GitHub releases page when the manifest cannot be fetched', async () => {
    mockDetectOs.mockReturnValue('mac');
    mockFetch.mockRejectedValue(new Error('503'));
    render(<DownloadSection reduced />);

    // Degrades to where the link used to point — worse, not broken.
    const link = await screen.findByRole('link', { name: /Downloads on GitHub/ });
    expect(link).toHaveAttribute('href', 'https://github.com/Varun-SV/Cascade-AI/releases/latest');
  });
});
