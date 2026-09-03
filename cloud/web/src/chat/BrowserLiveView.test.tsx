// ─────────────────────────────────────────────
//  Cascade Cloud — the agent-browser panel
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BrowserLiveView } from './BrowserLiveView.js';

describe('BrowserLiveView', () => {
  it('shows nothing when there is no browser', () => {
    // Not an empty frame: a provider may have no live view at all, and a blank
    // box reads as something broken rather than something absent.
    const { container } = render(<BrowserLiveView liveViewUrl={undefined} onStop={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('embeds the provider URL exactly as given', () => {
    // It carries the session's own credential. Rebuilding or trimming it would
    // drop the one thing that makes the frame work.
    const url = 'https://provider.test/live/abc?token=xyz&interactive=true';
    render(<BrowserLiveView liveViewUrl={url} onStop={() => {}} />);
    expect(screen.getByTitle('Agent browser session')).toHaveAttribute('src', url);
  });

  it('offers Stop whenever a browser is showing', () => {
    // The panel is the web surface's answer to the desktop's visibility gate:
    // the user watches, and the control to halt it is in the same place.
    const onStop = vi.fn();
    render(<BrowserLiveView liveViewUrl="https://provider.test/live/abc" onStop={onStop} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('calls Stop when pressed', () => {
    const onStop = vi.fn();
    render(<BrowserLiveView liveViewUrl="https://provider.test/live/abc" onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('says the user can take over, because they can', () => {
    // The frame passes input through. Someone who believes it is a video will
    // not try, and the whole point of watching is being able to intervene.
    render(<BrowserLiveView liveViewUrl="https://provider.test/live/abc" onStop={() => {}} />);
    expect(screen.getByText(/take over/i)).toBeInTheDocument();
  });
});
