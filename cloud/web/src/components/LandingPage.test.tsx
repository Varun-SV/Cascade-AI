import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import LandingPage from './LandingPage.js';

// The 3D scene is a separate chunk. Here its download fails, as it can on a
// flaky network or after a deploy replaces the file.
vi.mock('./landing/descentScene.js', () => {
  throw new Error('Failed to fetch dynamically imported module');
});
vi.mock('../lib/downloads.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/downloads.js')>('../lib/downloads.js');
  return { ...actual, fetchDownloads: vi.fn().mockResolvedValue(null), refineMacArch: vi.fn().mockResolvedValue(null) };
});

afterEach(cleanup);

const config = { githubEnabled: false, googleEnabled: false, devLoginEnabled: true } as never;

describe('LandingPage', () => {
  it('falls back to the still story when the scene chunk fails to load', async () => {
    const { container } = render(<LandingPage config={config} onDevLogin={() => {}} />);
    await waitFor(() => expect(container.querySelector('.descent')).toHaveClass('still'));
    // The story is told as text instead of leaving a blank track to scroll.
    expect(screen.getByRole('heading', { name: 'How one prompt moves through Cascade.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'That was Cascade.' })).toBeVisible();
  });

  it('uses the still layout when Settings → Reduce motion is on', () => {
    const { container } = render(<LandingPage config={config} onDevLogin={() => {}} reduceMotion />);
    expect(container.querySelector('.descent')).toHaveClass('still');
  });
});
