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

  it('says plainly when there is nothing to watch', () => {
    // Rarer than it was: frames come from the browser itself now, so this is a
    // run that has not produced one yet or a stream that would not start —
    // not, as before, an entire class of provider.
    render(<BrowserLiveView active liveViewUrl={undefined} onStop={() => {}} />);
    expect(screen.getByText(/cannot be streamed/i)).toBeInTheDocument();
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

// A bare CDP endpoint has no viewer API, so before frames this configuration
// got a Stop button and an apology. Rendering what Chrome itself drew is what
// makes every provider watchable.
describe('BrowserLiveView — watching by frames', () => {
  const frame = { data: 'BASE64JPEG', width: 1280, height: 800 };

  it('shows the page even with no provider viewer URL at all', () => {
    render(<BrowserLiveView active liveViewUrl={undefined} frame={frame} onStop={() => {}} />);

    const img = screen.getByAltText(/page Cascade's browser is on/i);
    expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,BASE64JPEG');
    expect(screen.getByText(/watch it here/i)).toBeInTheDocument();
  });

  it('is inert: watching is not driving', () => {
    // Input here would reach the session without passing through the lease
    // that decides who may act on the page — the agent could be mid-click
    // while the user typed into the same form.
    render(<BrowserLiveView active liveViewUrl={undefined} frame={frame} onStop={() => {}} />);

    const img = screen.getByAltText(/page Cascade's browser is on/i);
    expect(img).toHaveStyle({ pointerEvents: 'none' });
    expect(img).toHaveAttribute('tabindex', '-1');
  });

  it('prefers its own frames over the provider\'s viewer', () => {
    // Both available: the frame is ours, arrives over an authenticated socket,
    // and needs no bearer-capability URL. Showing both would double the cost
    // and stream the page twice.
    render(
      <BrowserLiveView
        active liveViewUrl="https://provider.test/live/abc" frame={frame} onStop={() => {}}
      />,
    );

    expect(screen.getByAltText(/page Cascade's browser is on/i)).toBeInTheDocument();
    expect(screen.queryByTitle('Agent browser session (view only)')?.tagName).not.toBe('IFRAME');
  });

  it('says it is waiting when a stream started but no frame has arrived', () => {
    // Distinct from "cannot be streamed": one resolves itself in a moment, the
    // other never will, and a user deciding whether to press Stop needs to
    // know which they are looking at.
    render(<BrowserLiveView active liveViewUrl={undefined} streaming onStop={() => {}} />);

    expect(screen.getByText(/waiting for the first frame/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });
});

// Watching leaves a run stuck the moment the agent reaches a login only the
// user can answer, with Stop — throwing the session away — as the only control.
describe('BrowserLiveView — taking the page over', () => {
  const frame = { data: 'AAAA', width: 1280, height: 800 };

  it('offers control only where there are frames to drive', () => {
    // The provider's iframe has no lease behind it: input through it would be a
    // second, uncoordinated controller racing the agent on the same page.
    render(<BrowserLiveView active liveViewUrl="https://provider.test/live/abc" onStop={() => {}} />);
    expect(screen.queryByRole('button', { name: /take control/i })).not.toBeInTheDocument();
  });

  it('asks for the page rather than assuming it got it', () => {
    // The agent may be mid-action; the server grants control only once that
    // has settled, and says so on its own event.
    const onTakeOver = vi.fn();
    render(<BrowserLiveView active liveViewUrl={undefined} frame={frame} onStop={() => {}} onTakeOver={onTakeOver} />);

    fireEvent.click(screen.getByRole('button', { name: /take control/i }));
    expect(onTakeOver).toHaveBeenCalledOnce();
    expect(screen.getByRole('img'), 'still inert until the server says otherwise')
      .toHaveStyle({ pointerEvents: 'none' });
  });

  it('becomes drivable once the server says the page is the user\'s', () => {
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onInput={onInput} />,
    );
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(img, { key: 'a' });
    fireEvent.keyDown(img, { key: 'Enter' });
    expect(onInput.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'key', key: 'Enter' },
    ]);
  });

  it('leaves the viewer\'s own shortcuts alone', () => {
    // Ctrl-R, Cmd-W, Ctrl-C: these belong to the browser the person is
    // actually sitting in front of, and stealing them to send somewhere else
    // is worse than not supporting them.
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onInput={onInput} />,
    );
    fireEvent.keyDown(screen.getByRole('img'), { key: 'r', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('img'), { key: 'w', metaKey: true });
    expect(onInput).not.toHaveBeenCalled();
  });

  it('sends a click as a fraction of the picture, not of the element', () => {
    // `object-fit: contain` centres the picture with bars on two sides whenever
    // the aspect ratios differ, so measuring against the element is wrong by
    // the width of those bars — and wronger the narrower the panel gets.
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onInput={onInput} />,
    );
    const img = screen.getByRole('img') as HTMLImageElement;
    // A 400×400 element showing a 1280×800 picture: the picture is 400×250,
    // letterboxed by 75px top and bottom.
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 0, detail: 1 });
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', x: 0.5, y: 0.5, button: 'left', clicks: 1 });

    // In the letterbox, which is not the page at all.
    onInput.mockClear();
    fireEvent.mouseDown(img, { clientX: 200, clientY: 10, button: 0, detail: 1 });
    expect(onInput, 'a click on a black bar is not a click on anything').not.toHaveBeenCalled();
  });

  it('can pause the picture without giving the page back', () => {
    // Signing in: the password is dots, but the manager's dropdown, a one-time
    // code and the page afterwards are not.
    const onCapture = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onCapture={onCapture} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /hide the page/i }));
    expect(onCapture).toHaveBeenCalledWith(false);
  });

  it('can still be typed into with the picture hidden — the real prop state', () => {
    // The state the hook actually produces: hiding the page clears the frame,
    // so `frame` is undefined. An earlier test rendered `capturing={false}`
    // WITH a frame, which is a combination that never occurs — and it missed
    // that clearing the frame unmounted the only element carrying onKeyDown,
    // making credential entry, the reason this feature exists, impossible.
    const onInput = vi.fn();
    render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false}
        onStop={() => {}} onInput={onInput}
      />,
    );

    expect(screen.queryByRole('img'), 'no picture, as asked').not.toBeInTheDocument();
    const surface = screen.getByRole('group', { name: /picture hidden/i });
    expect(surface, 'and focus followed it').toHaveFocus();

    fireEvent.keyDown(surface, { key: 'h' });
    fireEvent.keyDown(surface, { key: 'Enter' });
    expect(onInput.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'text', text: 'h' },
      { kind: 'key', key: 'Enter' },
    ]);
  });

  it('offers no pointer surface without a picture to aim at', () => {
    // A coordinate means nothing with no frame to measure against, and
    // inventing one would put a click somewhere the person cannot see.
    const onInput = vi.fn();
    render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false}
        onStop={() => {}} onInput={onInput}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('group', { name: /picture hidden/i }), { clientX: 5, clientY: 5 });
    expect(onInput).not.toHaveBeenCalled();
  });

  it('does not show the provider iframe underneath a takeover', () => {
    // The person holds the page; the provider's viewer has no lease behind it
    // and would put a second, uncoordinated view of the session on screen.
    render(
      <BrowserLiveView
        active liveViewUrl="https://provider.test/live/abc" frame={undefined} human capturing={false}
        onStop={() => {}}
      />,
    );
    expect(screen.queryByTitle(/view only/i)).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: /picture hidden/i })).toBeInTheDocument();
  });

  it('says the picture is paused rather than looking broken', () => {
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human capturing={false} onStop={() => {}} />,
    );
    expect(screen.getByText(/picture is paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show the page/i })).toBeInTheDocument();
  });

  it('hands the page back, and keeps Stop meaning what it meant', () => {
    const onHandBack = vi.fn();
    const onStop = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={onStop} onHandBack={onHandBack} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /give it back/i }));
    expect(onHandBack).toHaveBeenCalledOnce();
    // Stop takes the browser from everyone, the user included. A takeover must
    // not turn the kill switch into one that only stops the agent.
    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('says what the browser refused to do', () => {
    render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={frame}
        notice="The agent is still finishing an action on this page."
        onStop={() => {}}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/still finishing/i);
  });
});
