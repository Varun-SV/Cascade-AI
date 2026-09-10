// ─────────────────────────────────────────────
//  Cascade Cloud — the agent-browser panel
// ─────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
  /** Mirrors `MOVE_INTERVAL_MS` in the component. */
  const MOVE_INTERVAL = 60;

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

  it('survives a browser becoming active on a panel already mounted', () => {
    // THE ordinary path, and it was a crash. This component is mounted for the
    // whole conversation and merely switches `active` when a run opens a
    // browser — so an early `return null` placed above a hook meant the first
    // render ran fewer hooks than the activation re-render, and React threw
    // "Rendered more hooks than during the previous render", taking the chat
    // down at exactly the moment the panel was supposed to appear.
    //
    // Every other test in this file renders with `active` already settled one
    // way or the other, which is why none of them could see it: the defect is
    // in the TRANSITION, and nothing crossed it.
    const { rerender } = render(
      <BrowserLiveView active={false} liveViewUrl={undefined} onStop={() => {}} />,
    );
    expect(screen.queryByRole('img'), 'nothing before a browser exists').toBeNull();

    expect(() => rerender(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} />,
    )).not.toThrow();
    expect(screen.getByRole('img'), 'and the page appears').toBeInTheDocument();

    // And back again: the reverse transition renders fewer hooks if the same
    // mistake is made the other way round.
    expect(() => rerender(
      <BrowserLiveView active={false} liveViewUrl={undefined} onStop={() => {}} />,
    )).not.toThrow();
    expect(screen.queryByRole('img'), 'and goes away when the run gives it up').toBeNull();
  });

  it('ignores the mouse buttons that mean Back and Forward', () => {
    // They report 3 and 4. Mapping "not middle, not right" onto `left` turned a
    // navigation gesture into a real left click on the remote page — the client
    // repairing an unsupported input into a mutation nobody asked for.
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onInput={onInput} />,
    );
    const img = screen.getByRole('img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 3, detail: 1 });
    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 4, detail: 1 });
    expect(onInput, 'Back and Forward are not clicks').not.toHaveBeenCalled();

    // The three that ARE buttons still work.
    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 2, detail: 1 });
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', x: 0.5, y: 0.5, button: 'right', clicks: 1 });
  });

  it('scrolls by pixels whatever units the wheel reported', () => {
    // `deltaY` is not always pixels — `deltaMode` says whether it counts pixels,
    // lines or pages, and Firefox on Windows and Linux routinely reports lines.
    // CDP's wheel delta is always CSS pixels, so a full notch forwarded raw
    // scrolled about three pixels and scrolling looked broken.
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onInput={onInput} />,
    );
    const img = screen.getByRole('img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

    fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 120, deltaMode: 0 });
    expect(onInput, 'pixels are already pixels')
      .toHaveBeenCalledWith({ kind: 'scroll', x: 0.5, y: 0.5, deltaY: 120 });

    onInput.mockClear();
    fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 3, deltaMode: 1 });
    expect(onInput, 'three lines is a notch, not three pixels')
      .toHaveBeenCalledWith({ kind: 'scroll', x: 0.5, y: 0.5, deltaY: 48 });

    onInput.mockClear();
    fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 1, deltaMode: 2 });
    expect(onInput, 'and a page is the height of the picture')
      .toHaveBeenCalledWith({ kind: 'scroll', x: 0.5, y: 0.5, deltaY: 800 });
  });

  it('does not take focus back from wherever the person put it', () => {
    // The hidden surface focuses itself when it appears, because the element
    // they were typing into just unmounted. An INLINE callback ref made that
    // happen on every parent render instead: React detaches and re-runs a new
    // function each time, so any later render — a socket status among them —
    // snatched focus back and routed the next keystrokes to the remote page.
    const { rerender } = render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false} confirmed
        onStop={() => {}} notice={undefined}
      />,
    );
    const surface = screen.getByRole('group', { name: /picture hidden/i });
    expect(surface, 'it takes focus when it appears').toHaveFocus();

    // The person goes back to the composer.
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(elsewhere).toHaveFocus();

    // Anything at all re-renders the panel.
    rerender(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false} confirmed
        onStop={() => {}} notice="the agent said something"
      />,
    );
    expect(elsewhere, 'and the caret stays where they put it').toHaveFocus();
  });

  it('reports a frame only once the image says it rendered', () => {
    // The receipt opens Hide and, with it, the blind keyboard surface, so it
    // has to mean "shown". `load` is the browser saying the JPEG decoded and is
    // ready to paint — the closest thing to seen that a client can honestly
    // report. Rendering the frame is not that; a client handed a JPEG it cannot
    // decode renders nothing and must confirm nothing.
    const onFrameShown = vi.fn();
    render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={{ ...frame, generation: 12 }} human
        onStop={() => {}} onFrameShown={onFrameShown}
      />,
    );
    const img = screen.getByRole('img');
    expect(onFrameShown, 'on screen in the DOM is not decoded').not.toHaveBeenCalled();

    fireEvent.load(img);
    expect(onFrameShown).toHaveBeenCalledWith(12);
  });

  it('pastes into the page instead of nowhere', () => {
    // Ctrl/Cmd+V is a modifier chord, which the key handler deliberately leaves
    // to the viewer's own browser — and both surfaces here are non-editable, so
    // the default paste had nothing to insert and went nowhere at all. Hiding
    // the picture exists FOR entering a credential, and a credential mostly
    // comes out of a password manager, so the feature's primary use case was
    // the one thing that could not be done.
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onInput={onInput} />,
    );
    fireEvent.paste(screen.getByRole('img'), {
      clipboardData: { getData: () => 'correct horse battery staple' },
    });
    expect(onInput).toHaveBeenCalledWith({ kind: 'text', text: 'correct horse battery staple' });
  });

  it('pastes into the hidden surface, which is where a password goes', () => {
    // The picture is off and the person is typing a password they cannot see.
    // This is the surface the manager actually pastes into.
    const onInput = vi.fn();
    render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false} confirmed
        onStop={() => {}} onInput={onInput}
      />,
    );
    fireEvent.paste(screen.getByRole('group', { name: /picture hidden/i }), {
      clipboardData: { getData: () => 'hunter2' },
    });
    expect(onInput).toHaveBeenCalledWith({ kind: 'text', text: 'hunter2' });
  });

  it('does not paste into a page it is only watching', () => {
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} onStop={() => {}} onInput={onInput} />,
    );
    fireEvent.paste(screen.getByRole('img'), {
      clipboardData: { getData: () => 'not yours to send' },
    });
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

  it('forwards pointer movement so hover happens before the click', () => {
    // `dispatch` sends `mouseMoved` immediately before `mousePressed`, so a
    // click always lands somewhere the pointer has "been" — but only by one
    // event, at the click's own coordinates. Anything hover reveals therefore
    // appeared for the first time between the frame the person aimed at and the
    // press. `move` was declared here and handled in `dispatch` from the start;
    // the client never produced one, so the path was dead.
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onInput={onInput} />,
    );
    const img = screen.getByRole('img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      fireEvent.mouseMove(img, { clientX: 200, clientY: 200 });
      expect(onInput, 'the pointer arriving is sent as a move')
        .toHaveBeenCalledWith({ kind: 'move', x: 0.5, y: 0.5 });

      // A mousemove fires per pixel of travel. Every one of them taking the
      // action slot and a CDP round trip would put a queue of stale positions
      // in front of the click that follows.
      onInput.mockClear();
      now.mockReturnValue(1_010);
      fireEvent.mouseMove(img, { clientX: 300, clientY: 200 });
      expect(onInput, 'and the ones a flick of the wrist produces do not go immediately')
        .not.toHaveBeenCalled();

      // Far enough apart to be a different intention rather than the same
      // gesture, and in the letterbox, which is not the page.
      now.mockReturnValue(1_100);
      fireEvent.mouseMove(img, { clientX: 200, clientY: 10 });
      expect(onInput, 'a move across a black bar is not a move on anything').not.toHaveBeenCalled();

      // …and that one must not have spent the interval the next real move needs.
      now.mockReturnValue(1_120);
      fireEvent.mouseMove(img, { clientX: 200, clientY: 300 });
      expect(onInput, 'the next move over the page still goes')
        .toHaveBeenCalledWith({ kind: 'move', x: 0.5, y: 0.9 });
    } finally {
      now.mockRestore();
    }
  });

  it('does not fall back to the provider\'s viewer over a hidden page', () => {
    // `Page.stopScreencast` stops OUR frames. It does nothing to the provider's
    // own viewer, which is an independent stream of the same session. So hiding
    // a page to type a password and then handing it back — or simply letting
    // the hold lapse — cleared the frame, dropped `human`, and mounted the
    // fallback iframe, putting the credential page back on screen and back on
    // the wire before the agent restored capture. Hiding one of two windows is
    // not hiding.
    const { rerender } = render(
      <BrowserLiveView
        active liveViewUrl="https://provider.test/live/abc" frame={undefined}
        human capturing={false} confirmed onStop={() => {}}
      />,
    );
    // Handed back, or lapsed, while still hidden.
    rerender(
      <BrowserLiveView
        active liveViewUrl="https://provider.test/live/abc" frame={undefined}
        human={false} capturing={false} onStop={() => {}}
      />,
    );

    expect(screen.queryByTitle('Agent browser session (view only)'), 'the page stays hidden').toBeNull();
    expect(screen.getByText(/picture is paused/i), 'and the panel says why rather than lying about a stream')
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop/i }), 'Stop survives, as it always must')
      .toBeInTheDocument();
  });

  it('still falls back to the provider\'s viewer when nothing is paused', () => {
    // The gate is the PAUSE, not the absence of frames. A deployment with no
    // screencast at all must still get its viewer.
    render(
      <BrowserLiveView active liveViewUrl="https://provider.test/live/abc" frame={undefined} onStop={() => {}} />,
    );
    expect(screen.getByTitle('Agent browser session (view only)')).toBeInTheDocument();
  });

  it('sends the position the pointer came to rest at', async () => {
    // A leading-edge throttle alone drops the LAST move of a gesture, because
    // nothing follows it to take its place — and that is the position hover
    // depends on. The person moves onto a menu, stops, and the page never
    // learns they arrived, so the dropdown appears for the first time under the
    // `mouseMoved` that `dispatch` synthesises just before the press, and the
    // click lands on something the frame they were looking at could not show.
    vi.useFakeTimers();
    try {
      const onInput = vi.fn();
      render(
        <BrowserLiveView active liveViewUrl={undefined} frame={frame} human onStop={() => {}} onInput={onInput} />,
      );
      const img = screen.getByRole('img') as HTMLImageElement;
      Object.defineProperty(img, 'naturalWidth', { value: 1280 });
      Object.defineProperty(img, 'naturalHeight', { value: 800 });
      img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

      // Travelling, then stopping. Only the first goes out at once.
      fireEvent.mouseMove(img, { clientX: 100, clientY: 200 });
      fireEvent.mouseMove(img, { clientX: 200, clientY: 200 });
      fireEvent.mouseMove(img, { clientX: 300, clientY: 200 });
      expect(onInput).toHaveBeenCalledTimes(1);

      await act(async () => { vi.advanceTimersByTime(MOVE_INTERVAL); });
      expect(onInput, 'the resting position follows, and only that one').toHaveBeenCalledTimes(2);
      expect(onInput.mock.calls.at(-1)?.[0], 'the ones it passed through are not resent')
        .toEqual({ kind: 'move', x: 0.75, y: 0.5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send a held-back move after the page is handed back', async () => {
    // The trailing position is armed while driving and fires later. Landing
    // after the handback, it would be refused by the server and put a notice on
    // screen for a mouse that moved before the person let go.
    vi.useFakeTimers();
    try {
      const onInput = vi.fn();
      const props = { active: true, liveViewUrl: undefined, frame, onStop: () => {}, onInput };
      const { rerender } = render(<BrowserLiveView {...props} human />);
      const img = screen.getByRole('img') as HTMLImageElement;
      Object.defineProperty(img, 'naturalWidth', { value: 1280 });
      Object.defineProperty(img, 'naturalHeight', { value: 800 });
      img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

      fireEvent.mouseMove(img, { clientX: 100, clientY: 200 });
      fireEvent.mouseMove(img, { clientX: 300, clientY: 200 });
      onInput.mockClear();

      // Given back before the trailing move was due.
      rerender(<BrowserLiveView {...props} human={false} />);
      await act(async () => { vi.advanceTimersByTime(MOVE_INTERVAL * 4); });
      expect(onInput, 'nothing is sent for a page that is no longer theirs').not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not forward pointer movement to a page it is only watching', () => {
    // Watching is not driving. Movement over a picture nobody handed you is
    // not input, and forwarding it would reach the session outside the lease.
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} onStop={() => {}} onInput={onInput} />,
    );
    const img = screen.getByRole('img') as HTMLImageElement;
    // The SAME measurable picture the driving test sets up. Without these the
    // coordinate helper has nothing to measure against and answers "not on the
    // page" whatever the guard does — so the first draft of this test passed
    // with the guard deleted, which is the one thing a scope test must not do.
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

    fireEvent.mouseMove(img, { clientX: 200, clientY: 200 });
    expect(onInput).not.toHaveBeenCalled();
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
    // so `frame` is undefined. An earlier test rendered `capturing={false} confirmed`
    // WITH a frame, which is a combination that never occurs — and it missed
    // that clearing the frame unmounted the only element carrying onKeyDown,
    // making credential entry, the reason this feature exists, impossible.
    const onInput = vi.fn();
    render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false} confirmed
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

  it('refuses to be typed into before the first picture has ever arrived', () => {
    // The deliberate blind period is the exception, not the rule. `streaming`
    // is announced as soon as Page.startScreencast returns — before Chrome has
    // necessarily produced a frame — so a takeover in that window would be
    // typing into a page nobody has ever seen. That is the same "typing into
    // the dark" the server refuses, and a component is not where it becomes
    // acceptable.
    const onInput = vi.fn();
    render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing streaming
        onStop={() => {}} onInput={onInput}
      />,
    );

    const waiting = screen.getByLabelText(/waiting for the first picture/i);
    expect(waiting).not.toHaveAttribute('tabindex');
    fireEvent.keyDown(waiting, { key: 'h' });
    fireEvent.keyDown(waiting, { key: 'Enter' });
    expect(onInput, 'nothing reaches a page that has never been seen').not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /picture hidden/i })).not.toBeInTheDocument();
  });

  it('will not offer to hide a page that has never been shown', () => {
    // The bypass. Take control before the first frame is deliberately allowed —
    // pausing the agent is the useful half — but Hide was offered for EVERY
    // driving state, so "waiting for the first picture" was one click from the
    // focusable blind-typing placeholder. `capturing === false` is supposed to
    // prove the person saw the page and then chose to stop seeing it; the UI
    // could manufacture that state before a picture had ever arrived.
    const onCapture = vi.fn();
    const onInput = vi.fn();
    const { rerender } = render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing streaming
        onStop={() => {}} onCapture={onCapture} onInput={onInput}
      />,
    );

    expect(screen.getByLabelText(/waiting for the first picture/i)).not.toHaveAttribute('tabindex');
    expect(
      screen.queryByRole('button', { name: /hide the page/i }),
      'there is nothing to hide yet',
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /picture hidden/i })).not.toBeInTheDocument();
    expect(onCapture, 'so the blind period cannot be asked for').not.toHaveBeenCalled();

    // A picture arrives. Now it is a page they have seen, and hiding it is a
    // choice they can actually make.
    rerender(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={frame} human capturing streaming
        onStop={() => {}} onCapture={onCapture} onInput={onInput}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /hide the page/i }));
    expect(onCapture).toHaveBeenCalledWith(false);

    // And Show stays offered while hidden — the frame is gone by then, so a
    // gate that only asked for a frame would strand them on a dark panel.
    rerender(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false} confirmed streaming
        onStop={() => {}} onCapture={onCapture} onInput={onInput}
      />,
    );
    expect(screen.getByRole('button', { name: /show the page/i })).toBeInTheDocument();
  });

  it('will not be typed into over a page hidden before this view opened', () => {
    // Reachable with the ordinary client: a takeover survives a reload and the
    // hidden state is replayed with it, so this view can be handed
    // `capturing: false` for a page it has never been shown. The page may have
    // changed while hidden — a timer, a redirect, the last thing typed into it
    // — so the viewer that has gone having seen it is not this one seeing it.
    const onInput = vi.fn();
    const { rerender } = render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false}
        confirmed={false} onStop={() => {}} onInput={onInput}
      />,
    );

    const inherited = screen.getByLabelText(/picture hidden and not yet seen/i);
    expect(inherited, 'nothing to focus and nothing to type into').not.toHaveAttribute('tabindex');
    fireEvent.keyDown(inherited, { key: 'p' });
    fireEvent.keyDown(inherited, { key: 'Enter' });
    expect(onInput, 'not one keystroke into a page this view never saw').not.toHaveBeenCalled();
    // Showing it is the way out, so that control has to still be there.
    expect(screen.getByRole('button', { name: /show the page/i })).toBeInTheDocument();

    // Once the server says this watch has seen the page, it is a blind period
    // the person chose and the keyboard comes back.
    rerender(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false}
        confirmed onStop={() => {}} onInput={onInput}
      />,
    );
    const chosen = screen.getByRole('group', { name: /picture hidden/i });
    fireEvent.keyDown(chosen, { key: 'p' });
    expect(onInput).toHaveBeenCalledWith({ kind: 'text', text: 'p' });
  });

  it('offers no pointer surface without a picture to aim at', () => {
    // A coordinate means nothing with no frame to measure against, and
    // inventing one would put a click somewhere the person cannot see.
    const onInput = vi.fn();
    render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={undefined} human capturing={false} confirmed
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
        active liveViewUrl="https://provider.test/live/abc" frame={undefined} human capturing={false} confirmed
        onStop={() => {}}
      />,
    );
    expect(screen.queryByTitle(/view only/i)).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: /picture hidden/i })).toBeInTheDocument();
  });

  it('says the picture is paused rather than looking broken', () => {
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human capturing={false} confirmed onStop={() => {}} />,
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
