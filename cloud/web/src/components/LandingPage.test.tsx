import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('heading', { name: "That's how Cascade runs it." })).toBeVisible();
  });

  it('uses the still layout when Settings → Reduce motion is on', () => {
    const { container } = render(<LandingPage config={config} onDevLogin={() => {}} reduceMotion />);
    expect(container.querySelector('.descent')).toHaveClass('still');
  });
});

describe('LandingPage navigation in the still layout', () => {
  it('"How it works" goes to the text story, not the empty descent', () => {
    const { container } = render(<LandingPage config={config} onDevLogin={() => {}} reduceMotion />);
    const root = container.querySelector('.descent') as HTMLDivElement;
    const scrolls: ScrollToOptions[] = [];
    root.scrollTo = ((opts: ScrollToOptions) => { scrolls.push(opts); }) as never;
    const story = screen.getByRole('heading', { name: 'How one prompt moves through Cascade.' });
    // Lay the story out 900px into the scroll container.
    root.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    story.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;

    fireEvent.click(screen.getByRole('link', { name: 'How it works' }));

    expect(scrolls).toEqual([{ top: 876, behavior: 'auto' }]);
    expect(document.activeElement).toBe(story);
  });
});

describe('LandingPage says the descent is a simulation', () => {
  it('discloses it before anything is submitted, on the prompt itself', () => {
    render(<LandingPage config={config} onDevLogin={() => {}} />);
    const input = screen.getByLabelText('Your prompt');
    const note = document.getElementById(input.getAttribute('aria-describedby')!);
    expect(note).toHaveTextContent("A simulated walkthrough. Your prompt isn't sent anywhere");
  });

  it('ends on the walkthrough, with a way to run it for real', () => {
    render(<LandingPage config={config} onDevLogin={() => {}} reduceMotion />);
    expect(screen.queryByText('That was Cascade.')).toBeNull();
    expect(screen.getByText(/^A simulated walkthrough: one prompt becomes a plan/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in to run this for real' })).toBeInTheDocument();
  });
});
