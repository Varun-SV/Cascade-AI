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
    const url = 'https://provider.test/live/abc?token=xyz&interactive=false';
    render(<BrowserLiveView active liveViewUrl={url} onStop={() => {}} />);
    expect(screen.getByTitle('Agent browser session (view only)')).toHaveAttribute('src', url);
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

  it('says what the user can actually do: watch it, and stop it', () => {
    // This used to assert the banner offered to let the user take the page
    // over, which the frame really did allow — and that was the bug. Viewer
    // input reaches the session over the provider's own channel, bypassing the
    // lease, so "taking over" meant driving the page AT THE SAME TIME as the
    // agent rather than instead of it.
    render(<BrowserLiveView active liveViewUrl="https://provider.test/live/abc" onStop={() => {}} />);
    expect(screen.getByText(/watch it here/i)).toBeInTheDocument();
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

describe('BrowserLiveView — the frame is for watching, not driving', () => {
  it('refuses pointer and keyboard input into the session', () => {
    // The URL asks the provider for a watch-only viewer, but that flag's
    // meaning is the provider's. If input got through it would reach the live
    // session over their channel, never through the lease that decides who may
    // drive the page — so the agent could be mid-click while the user typed
    // into the same form, and its action would land on top of theirs.
    render(
      <BrowserLiveView active liveViewUrl="https://provider.test/live/abc?interactive=false" onStop={() => {}} />,
    );
    const frame = screen.getByTitle('Agent browser session (view only)');
    expect(frame).toHaveStyle({ pointerEvents: 'none' });
    expect(frame).toHaveAttribute('tabindex', '-1');
  });
});
