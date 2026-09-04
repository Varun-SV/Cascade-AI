// ─────────────────────────────────────────────
//  Cascade Cloud — the agent-browser panel
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BrowserLiveView } from './BrowserLiveView.js';

describe('BrowserLiveView', () => {
  it('shows nothing when no browser is attached', () => {
    // Not an empty frame: a provider may have no live view at all, and a blank
    // box reads as something broken rather than something absent.
    const { container } = render(<BrowserLiveView active={false} liveViewUrl={undefined} onStop={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('embeds the provider URL exactly as given', () => {
    // It carries the session's own credential. Rebuilding or trimming it would
    // drop the one thing that makes the frame work.
    const url = 'https://provider.test/live/abc?token=xyz&interactive=true';
    render(<BrowserLiveView active liveViewUrl={url} onStop={() => {}} />);
    expect(screen.getByTitle('Agent browser session')).toHaveAttribute('src', url);
  });

  it('offers Stop whenever a browser is showing', () => {
    // The panel is the web surface's answer to the desktop's visibility gate:
    // the user watches, and the control to halt it is in the same place.
    const onStop = vi.fn();
    render(<BrowserLiveView active liveViewUrl="https://provider.test/live/abc" onStop={onStop} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('calls Stop when pressed', () => {
    const onStop = vi.fn();
    render(<BrowserLiveView active liveViewUrl="https://provider.test/live/abc" onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('says the user can take over, because they can', () => {
    // The frame passes input through. Someone who believes it is a video will
    // not try, and the whole point of watching is being able to intervene.
    render(<BrowserLiveView active liveViewUrl="https://provider.test/live/abc" onStop={() => {}} />);
    expect(screen.getByText(/take over/i)).toBeInTheDocument();
  });

  it('keeps Stop when the provider cannot stream a view', () => {
    // The whole point of splitting `active` from the URL. A bare CDP endpoint
    // streams nothing, and keying the panel on the URL meant that
    // configuration lost its Stop button too — the agent driving a browser the
    // user could neither see nor halt.
    render(<BrowserLiveView active liveViewUrl={undefined} onStop={() => {}} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('says plainly that this configuration cannot be watched', () => {
    render(<BrowserLiveView active liveViewUrl={undefined} onStop={() => {}} />);
    expect(screen.getByText(/cannot stream it/i)).toBeInTheDocument();
  });

  it('shows no empty frame when there is nothing to stream', () => {
    // An empty iframe reads as broken; the banner says the honest version.
    render(<BrowserLiveView active liveViewUrl={undefined} onStop={() => {}} />);
    expect(screen.queryByTitle('Agent browser session')).toBeNull();
  });
});
