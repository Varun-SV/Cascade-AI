// ─────────────────────────────────────────────
//  Cascade Cloud — watching the agent's browser
// ─────────────────────────────────────────────
//
//  The web surface's answer to the desktop's visibility gate.
//
//  On the desktop the agent refuses to act unless the browser is on screen,
//  which is what makes its Stop button mean something: the user can always see
//  what they are stopping. A browser in someone else's data centre offers no
//  such guarantee, so this panel takes that role — the page streams here, the
//  user watches it happen, and Stop is right there.
//
//  It is also where the page changes hands. Watching alone leaves a run stuck
//  the moment the agent reaches a login or a consent dialog only the user can
//  answer, with Stop — throwing the whole session away — as the only control.
//  Taking over is the other half: the agent is paused on the same lease its
//  workers queue on BEFORE a single event is accepted here, so control is
//  exclusive rather than concurrent.
//
//  The iframe src is a BEARER CAPABILITY issued by the provider: it carries its
//  own session credential and is deliberately token-free so it can be embedded.
//  It arrives over the socket, lives in component state, and goes nowhere else.

import { useEffect, useRef } from 'react';

/** The keys the server will accept as commands. Everything else is text. */
const COMMAND_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

/**
 * How often pointer movement is forwarded while the person is driving.
 *
 * A rate, not every event: a mousemove fires per pixel of travel, and each one
 * that went through would take the action slot and a CDP round trip, so a
 * flick across the panel would put a queue of stale positions in front of the
 * click that follows it. Roughly the screencast's own cadence — often enough
 * that hover states appear in a frame before the person clicks, rare enough
 * that the queue drains faster than they can aim.
 */
const MOVE_INTERVAL_MS = 60;

/**
 * A wheel notch in CSS pixels, whatever units the device reported it in.
 *
 * `deltaY` is NOT always pixels: `deltaMode` says whether the number counts
 * pixels, lines or pages, and Firefox on Windows and Linux routinely reports
 * lines. CDP's `mouseWheel` delta is always CSS pixels, so forwarding the raw
 * value made a full notch scroll about three pixels — scrolling looked broken
 * for those clients rather than slightly off.
 *
 * The line height is nominal, and deliberately so: the real one belongs to the
 * remote page's own styles, which this side cannot see and the remote side
 * cannot attribute to a particular element under the cursor. 16px is the
 * ordinary default and makes a notch travel about what it travels locally.
 *
 * Page mode is rarer still and approximated from the frame's own height, which
 * is the only page-sized number this side has. That number is the screencast's
 * DEVICE height rather than the page's CSS height, so at a device scale other
 * than 1 it is off by that scale — noted rather than hidden, because the
 * alternative is a page-mode wheel that scrolls three pixels.
 */
const NOMINAL_LINE_PX = 16;

/**
 * How often accumulated wheel distance is forwarded.
 *
 * Scrolling is sampled like movement, but it cannot be DROPPED like movement:
 * a position is superseded by the next one, whereas a wheel delta is a distance
 * that only exists once — throw it away and the page scrolls less far than the
 * person asked for. So pending deltas are summed rather than discarded, and the
 * total goes out at this rate.
 *
 * It needs a rate at all because a trackpad emits wheel events faster than a
 * remote CDP round trip, and every one of them was taking the FIFO action slot.
 * Scrolling also repaints, which invalidates the cached viewport and puts a
 * `Page.getLayoutMetrics` in front of the next coordinate event — so the
 * backlog grew faster than it drained, ran past the slot's two-second bound,
 * and truncated the scroll while refusing whatever click came next.
 */
const SCROLL_INTERVAL_MS = 60;
function wheelPixels(e: { deltaY: number; deltaMode: number }, framePx = 800): number {
  if (e.deltaMode === 1) return e.deltaY * NOMINAL_LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * framePx;
  return e.deltaY;
}

/** One thing the user did to the page. Coordinates are fractions of the frame. */
export type BrowserInputEvent =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number }
  | { kind: 'scroll'; x: number; y: number; deltaY: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string };

interface Props {
  /**
   * Whether a browser is attached to this run at all.
   *
   * Separate from `liveViewUrl` on purpose. A bare CDP endpoint has no session
   * API to ask a view from, so it streams nothing — and keying the panel on the
   * URL meant that configuration got no Stop button either. The agent was
   * driving a browser with neither of the two things that make the capability
   * safe: you could not see it, and you could not halt it.
   */
  active: boolean;
  /** The provider's live session URL, absent when it cannot be streamed. */
  liveViewUrl: string | undefined;
  /**
   * The newest frame of the page, rendered by the browser itself over CDP.
   *
   * This is the primary way to watch now, and it works for every provider —
   * including a bare CDP endpoint, which has no viewer API at all and so used
   * to get a Stop button and an apology.
   */
  frame?: { data: string; width: number; height: number; generation?: number } | undefined;
  /** The server confirmed a stream is running, so a blank panel is worth explaining. */
  streaming?: boolean;
  /** The user holds the page: the agent is being refused until they hand it back. */
  human?: boolean;
  /** Whether frames are being produced. False while the picture is paused. */
  capturing?: boolean;
  /**
   * Whether THIS watch has confirmed receiving a picture, per the server.
   *
   * The blind keyboard surface is gated on it. A takeover survives a reload and
   * the hidden state is replayed with it, so without this a fresh viewer could
   * be handed `capturing: false` for a page it has never been shown — and the
   * page can have changed while hidden, by timer, redirect, or the last thing
   * typed into it.
   */
  confirmed?: boolean;
  /** Something the user asked of the browser that did not happen. */
  notice?: string | undefined;
  /** Stop the agent using the browser for this run. */
  onStop: () => void;
  /** Ask for the page. Granted once the agent's action in flight has settled. */
  onTakeOver?: () => void;
  /** Give it back, so the run can carry on. */
  onHandBack?: () => void;
  /** One thing the user did to the page, while they hold it. */
  onInput?: (event: BrowserInputEvent) => void;
  /**
   * This frame is on screen — not merely in state.
   *
   * Called from the image's own `load`, which is the browser saying the JPEG
   * decoded and is ready to paint. The server treats it as the receipt that
   * opens Hide and the blind keyboard surface, so it has to mean "shown"; an
   * effect firing when the bytes arrived would confirm a page a slow or broken
   * client never rendered.
   */
  onFrameShown?: (generation: number) => void;
  /** Pause or resume the picture without giving the page back. */
  onCapture?: (on: boolean) => void;
}

export function BrowserLiveView({
  active, liveViewUrl, frame, streaming, human, capturing, confirmed, notice,
  onStop, onTakeOver, onHandBack, onInput, onCapture, onFrameShown,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  /**
   * When a pointer move was last forwarded, so they go out at a rate rather
   * than one per mousemove event.
   *
   * A ref rather than state: throttling must not re-render, and the value is
   * read and written inside the handler that produces the next one.
   */
  const lastMoveRef = useRef(0);
  /**
   * The position a throttled-away move was carrying, and the timer that will
   * send it.
   *
   * A leading-edge throttle alone drops the LAST move of a gesture — the one
   * that says where the pointer came to rest — because nothing follows it to
   * take its place. That is the position hover actually depends on: the person
   * moves onto a menu, stops, and the page never learns they arrived, so the
   * dropdown appears for the first time under the `mouseMoved` that `dispatch`
   * synthesises just before the press. The click then lands on something the
   * frame they were looking at could not have shown.
   */
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const moveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Wheel distance not yet sent, summed. See `SCROLL_INTERVAL_MS`. */
  const pendingScrollRef = useRef<{ x: number; y: number; deltaY: number } | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollRef = useRef(0);
  /**
   * The person paused the picture, and the pause has to reach EVERY way of
   * seeing the page.
   *
   * `Page.stopScreencast` stops our frames. It does nothing to the provider's
   * own viewer, which is an independent stream of the same session — so the
   * fallback iframe below would happily go on showing the credential page that
   * was just hidden. Hiding one of two windows is not hiding.
   */
  const paused = capturing === false;
  // Frames first: they come from the browser itself, so they exist whoever is
  // hosting it. The provider's own viewer is the fallback for a deployment
  // still on the old path, and neither being available is now unusual rather
  // than expected. A paused page is watchable through NEITHER, whatever the
  // provider would otherwise offer.
  const watchable = !!frame || (!!liveViewUrl && !paused);
  // Taking over means driving the frames, so it is offered only where they are
  // the thing on screen. The provider's iframe has no lease behind it — input
  // through it would be a second, uncoordinated controller racing the agent.
  const takeable = !!frame || streaming === true;
  const driving = human === true;
  /**
   * The person is driving a page they deliberately cannot see.
   *
   * Named once because two things need it and they must not drift: the surface
   * that renders, and the effect that focuses it.
   */
  const blind = active && !frame && driving && capturing === false && confirmed === true;
  const blindRef = useRef<HTMLDivElement>(null);
  // Focus follows the surface, because the element the person was typing into
  // just unmounted. From an EFFECT keyed on entering that state, not from an
  // inline callback ref: an inline ref is a new function every render, so React
  // detached and re-ran it on every parent update — which meant any later
  // render, a socket status among them, snatched focus back to this div from
  // wherever the person had since put it, and routed their next keystrokes to
  // the remote page instead of the composer they were typing in.
  useEffect(() => {
    if (blind) blindRef.current?.focus();
  }, [blind]);

  // A held-back move must not outlive the control it was made under. The timer
  // is armed only while driving, so this cleanup covers both giving the page
  // back and the panel going away — otherwise a trailing position could arrive
  // after the handback and be refused, putting a notice on screen for a mouse
  // that moved before the person let go.
  useEffect(() => {
    if (!driving) return;
    return () => {
      if (moveTimerRef.current) {
        clearTimeout(moveTimerRef.current);
        moveTimerRef.current = null;
      }
      pendingMoveRef.current = null;
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
      pendingScrollRef.current = null;
    };
  }, [driving]);

  // AFTER every hook, and that is not a style preference.
  //
  // This used to sit above the two hooks below it, which is a crash rather than
  // an inefficiency: React counts hooks per render, and this component is
  // mounted for the whole conversation and merely switches `active` when a run
  // opens a browser. So the first render ran two hooks and returned; the
  // activation re-render ran four, and React threw "Rendered more hooks than
  // during the previous render" — taking the chat down at exactly the moment
  // the panel was supposed to appear, on the ordinary path rather than an edge
  // case. Nothing above this line may return early, and nothing below it may
  // call a hook.
  if (!active) return null;

  /**
   * Where on the PAGE the user clicked, as a fraction of it.
   *
   * The frame is drawn with `object-fit: contain`, so the picture is centred
   * inside the element with bars on two sides whenever their aspect ratios
   * differ. Measuring against the element would therefore be wrong by the
   * width of those bars — and wrong by more the narrower the panel gets. The
   * contained rectangle is reconstructed from the image's natural size, which
   * is the only thing that says what shape the picture actually is.
   */
  const at = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const nw = img.naturalWidth || rect.width;
    const nh = img.naturalHeight || rect.height;
    if (!nw || !nh || !rect.width || !rect.height) return null;
    const scale = Math.min(rect.width / nw, rect.height / nh);
    const w = nw * scale;
    const h = nh * scale;
    const x = (clientX - (rect.left + (rect.width - w) / 2)) / w;
    const y = (clientY - (rect.top + (rect.height - h) / 2)) / h;
    // A click in the letterbox is not a click on the page. Dropping it beats
    // clamping it to an edge the user was not pointing at.
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  /**
   * What the person typed, on its way to the page.
   *
   * Shared by the picture and by the privacy placeholder below, because the
   * whole point of hiding the picture is to keep typing into a page you cannot
   * see — a handler that lived only on the <img> disappeared with it.
   */
  /**
   * A paste, forwarded as the text it carries.
   *
   * Ctrl/Cmd+V is a modifier chord, and `onKey` below deliberately lets those
   * through to the viewer's own browser rather than stealing them. That is
   * right for copy and reload — and it left paste going nowhere at all, because
   * both surfaces here are non-editable, so the default paste has nothing to
   * insert. The one thing the hidden-capture mode exists for is entering a
   * credential, and a credential mostly arrives from a password manager, so the
   * feature's primary use case was the one that could not be done.
   *
   * The clipboard is read only in response to the person's own paste gesture —
   * this handler cannot see it otherwise — and the text goes through `onInput`
   * like anything else they type, so it takes the lease, the action slot and
   * the 4,000-character bound with it.
   */
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text) return;
    e.preventDefault();
    onInput?.({ kind: 'text', text });
  };

  const onKey = (e: React.KeyboardEvent) => {
    // Modifier chords are not forwarded: they are the viewer's own shortcuts —
    // copy, reload, close the tab — and stealing them from the person's actual
    // browser to send to a remote one is worse than not supporting them.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) {
      e.preventDefault();
      onInput?.({ kind: 'text', text: e.key });
      return;
    }
    if (COMMAND_KEYS.has(e.key)) {
      e.preventDefault();
      onInput?.({ kind: 'key', key: e.key });
    }
  };

  const banner = driving
    ? paused
      ? 'You have control. The picture is paused — Cascade cannot see this page either.'
      : 'You have control of this browser. Cascade is paused until you give it back.'
    : paused
      // Handed back, or lapsed, while still hidden. Saying "it cannot be
      // streamed" here would be a lie about a stream that is merely off, and
      // "watch it here" would point at a panel showing nothing.
      ? 'The picture is paused. Cascade will turn it back on before it does anything to the page.'
    : watchable
      ? 'Cascade is using a browser. Watch it here, and stop it whenever you want.'
      : streaming
        ? 'Cascade is using a browser. Waiting for the first frame…'
        : 'Cascade is using a browser. It cannot be streamed right now, so you can only stop it.';

  return (
    <section
      aria-label="Agent browser"
      style={{
        display: 'flex', flexDirection: 'column',
        border: '1px solid var(--border, #333)', borderRadius: 8,
        overflow: 'hidden', margin: '8px 0', background: 'var(--panel, #111)',
      }}
    >
      <header
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          background: driving ? 'var(--ok-bg, #10331f)' : 'var(--warn-bg, #4a3410)',
          color: driving ? 'var(--ok-fg, #7fd6a0)' : 'var(--warn-fg, #f5c96b)',
          fontSize: 12.5, flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}
        />
        <span style={{ flex: 1 }}>{banner}</span>
        {/*
          Offered only once there is a picture to hide. Take control is
          deliberately available before the first frame — pausing the agent is
          useful on its own — but Hide was offered for any takeover, which gave a
          one-click path from "waiting for the first picture" to the focusable
          blind-typing placeholder. That inverts the whole claim `capturing ===
          false` makes: a period the person chose, having already seen the page.

          `capturing === false` stays in the condition so **Show** is always
          reachable. A hidden page with no way to bring it back is a worse trap
          than the one being closed.
        */}
        {driving && (!!frame || capturing === false) && (
          <button
            type="button"
            onClick={() => onCapture?.(capturing === false)}
            title="Stop sending pictures of this page while you type something private"
            style={chip}
          >
            {capturing === false ? 'Show the page' : 'Hide the page'}
          </button>
        )}
        {takeable && (
          <button
            type="button"
            onClick={() => (driving ? onHandBack?.() : onTakeOver?.())}
            title={driving
              ? 'Give the browser back so Cascade can carry on'
              : 'Take the browser yourself — Cascade stops as soon as its current action finishes'}
            style={chip}
          >
            {driving ? 'Give it back' : 'Take control'}
          </button>
        )}
        <button
          type="button"
          onClick={onStop}
          title="Stop Cascade from using the browser for this run"
          style={chip}
        >
          Stop
        </button>
      </header>
      {notice && (
        <p
          role="status"
          style={{
            margin: 0, padding: '5px 10px', fontSize: 12,
            background: 'var(--warn-bg, #4a3410)', color: 'var(--warn-fg, #f5c96b)',
          }}
        >
          {notice}
        </p>
      )}
      {/*
        The page, as Chrome itself rendered it.

        An <img> with a data URL rather than a canvas: the browser decodes JPEG
        natively and keeps the previous frame on screen until the next one is
        ready, which is exactly the double-buffering a canvas would otherwise
        have to be given by hand. Frames arrive only while this panel is
        mounted — the hook watches on the run this pane is showing and unwatches
        when it stops — so nothing is being encoded or shipped behind a closed
        panel.

        A minimum height because these views are unusable when squeezed: the
        page renders at the remote viewport and scales down, so a short frame
        shows a thumbnail nobody can read.

        Inert unless the user has taken control, and that is the point of this
        element rather than styling. Input that reached the session without
        passing through the lease would let the agent be mid-click while the
        user typed into the same form — which is exactly what the provider's
        interactive viewer does, and why it stays switched off. Once the lease
        IS the user's, the same element becomes focusable and starts forwarding
        events, because by then the agent is being refused.
      */}
      {frame && (
        <img
          ref={imgRef}
          src={`data:image/jpeg;base64,${frame.data}`}
          alt="The page Cascade's browser is on"
          title={driving ? 'Agent browser session (you have control)' : 'Agent browser session (view only)'}
          tabIndex={driving ? 0 : -1}
          onMouseDown={driving ? (e) => {
            // The image takes focus so the keys go here rather than to the
            // chat composer behind it.
            e.preventDefault();
            imgRef.current?.focus();
            // 0, 1, 2 and nothing else. A mouse's Back and Forward buttons
            // report 3 and 4, and mapping "anything that is not middle or
            // right" onto `left` turned a navigation gesture into a real left
            // click on the remote page — the client repairing an unsupported
            // input into a mutation the person never asked for, which is the
            // shape the server boundary was hardened against three rounds ago.
            if (e.button > 2) return;
            const p = at(e.clientX, e.clientY);
            if (p) onInput?.({ kind: 'click', ...p, button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left', clicks: e.detail || 1 });
          } : undefined}
          onMouseMove={driving ? (e) => {
            // Hover is part of the page, and the person could not see it.
            //
            // `dispatch` already sends `mouseMoved` immediately before
            // `mousePressed`, so a click always arrives somewhere the pointer
            // has "been" — but only by one event, at the click's own
            // coordinates, a moment before the press. Anything hover reveals —
            // a nav dropdown, a tooltip, a toolbar that appears on the row
            // under the cursor — therefore appeared for the first time BETWEEN
            // the frame the person aimed at and the press, so the press landed
            // on content that was not in the picture they clicked.
            //
            // Forwarding movement while they travel is what puts that content
            // in a frame first. `move` was declared on this event type and
            // handled all the way down in `dispatch` from the start; the client
            // simply never produced one, so the whole path was dead.
            const p = at(e.clientX, e.clientY);
            // A move across the letterbox is not a move on the page, and must
            // not spend the interval the next real one needs.
            if (!p) return;
            const now = Date.now();
            const since = now - lastMoveRef.current;
            if (since >= MOVE_INTERVAL_MS) {
              // This one goes now, so anything held back is already stale.
              if (moveTimerRef.current) {
                clearTimeout(moveTimerRef.current);
                moveTimerRef.current = null;
              }
              pendingMoveRef.current = null;
              lastMoveRef.current = now;
              onInput?.({ kind: 'move', ...p });
              return;
            }
            // Held back, not dropped. Only the newest is kept — the ones
            // between are positions the pointer has already left.
            pendingMoveRef.current = p;
            if (moveTimerRef.current) return;
            moveTimerRef.current = setTimeout(() => {
              moveTimerRef.current = null;
              const last = pendingMoveRef.current;
              pendingMoveRef.current = null;
              if (!last) return;
              lastMoveRef.current = Date.now();
              onInput?.({ kind: 'move', ...last });
            }, MOVE_INTERVAL_MS - since);
          } : undefined}
          onContextMenu={driving ? (e) => e.preventDefault() : undefined}
          onWheel={driving ? (e) => {
            const p = at(e.clientX, e.clientY);
            if (!p) return;
            const dy = wheelPixels(e, frame.height);
            const now = Date.now();
            const since = now - lastScrollRef.current;
            // Nothing waiting and the window has passed: this one goes as it is.
            if (since >= SCROLL_INTERVAL_MS && !pendingScrollRef.current) {
              lastScrollRef.current = now;
              onInput?.({ kind: 'scroll', ...p, deltaY: dy });
              return;
            }
            // SUMMED, not replaced — a wheel delta is a distance that exists
            // once, and dropping one scrolls the page less far than the person
            // asked. The position is the latest, since that is where they are.
            const pending = pendingScrollRef.current;
            pendingScrollRef.current = { ...p, deltaY: (pending?.deltaY ?? 0) + dy };
            if (scrollTimerRef.current) return;
            scrollTimerRef.current = setTimeout(() => {
              scrollTimerRef.current = null;
              const total = pendingScrollRef.current;
              pendingScrollRef.current = null;
              if (!total) return;
              lastScrollRef.current = Date.now();
              onInput?.({ kind: 'scroll', ...total });
            }, Math.max(0, SCROLL_INTERVAL_MS - since));
          } : undefined}
          onKeyDown={driving ? onKey : undefined}
          onPaste={driving ? onPaste : undefined}
          onLoad={() => {
            // Reported from HERE — the browser saying the JPEG decoded — rather
            // than from the arrival of the bytes. See `onFrameShown`.
            if (frame.generation !== undefined) onFrameShown?.(frame.generation);
          }}
          style={{
            width: '100%', minHeight: 400, maxHeight: 600, objectFit: 'contain',
            display: 'block', background: '#000',
            ...(driving ? { cursor: 'crosshair' } : { pointerEvents: 'none' }),
          }}
        />
      )}
      {/*
        A place to type when there is no picture to type into — and only when
        the person chose to have no picture.

        Hiding the page is FOR entering a credential, and the input surface
        lived entirely inside the <img>, so clearing the frame to hide it took
        the keyboard with it and made the one thing the feature exists for
        impossible. That is the case this restores.

        The blind period has to be one the person CHOSE, though. `capturing ===
        false` means they saw the page, put the caret where they wanted it, and
        then asked us to stop showing it. Merely waiting for a first frame is
        not that: the server says a stream started as soon as
        `Page.startScreencast` returns, before Chrome has necessarily produced
        anything, so a takeover in that window would be typing into a page
        nobody has ever seen. That is the same "typing into the dark" the
        server refuses input for, and it is not made acceptable by happening in
        a component.

        Keys only either way: a pointer coordinate means nothing without a
        frame to measure it against, and inventing one would put a click
        somewhere the person could not see.
      */}
      {!frame && driving && (
        // AND confirmed: a hidden page this watch has not been shown is not a
        // blind period the person chose, it is a blind period they inherited
        // from a viewer that is gone. Showing the page is how they get out of
        // it — that control stays available, and one frame later this is a
        // choice again.
        blind ? (
          <div
            ref={blindRef}
            role="group"
            aria-label="Agent browser, picture hidden"
            tabIndex={0}
            onKeyDown={onKey}
            // The surface a password is actually entered on, so the surface a
            // password manager actually pastes into.
            onPaste={onPaste}
            style={{
              width: '100%', minHeight: 400, display: 'grid', placeItems: 'center',
              background: '#000', color: 'var(--warn-fg, #f5c96b)', fontSize: 13,
              textAlign: 'center', padding: 16, cursor: 'text',
            }}
          >
            <span>The picture is hidden. What you type still goes to the page.</span>
          </div>
        ) : (
          // Inert on purpose: nothing this watch has seen, so nothing to type
          // into. Two ways to arrive here and they need different words — one
          // is waiting for a stream that is running, the other is a page
          // someone else hid before this view existed.
          <div
            aria-label={capturing === false
              ? 'Agent browser, picture hidden and not yet seen'
              : 'Agent browser, waiting for the first picture'}
            style={{
              width: '100%', minHeight: 400, display: 'grid', placeItems: 'center',
              background: '#000', color: 'var(--ink-400, #888)', fontSize: 13,
              textAlign: 'center', padding: 16,
            }}
          >
            <span>
              {capturing === false
                ? 'The picture was hidden before this view opened. Show the page to carry on.'
                : 'Waiting for the first picture. You can type once you can see the page.'}
            </span>
          </div>
        )
      )}
      {/*
        The provider's own viewer, for a deployment not yet streaming frames.
        Always inert, whoever holds the lease: input here would go straight to
        the session over the provider's channel without passing through it. And
        `sandbox` is deliberately unset, because the viewer needs scripts and
        same-origin access to its own session and a sandbox permitting both is
        equivalent to none.
      */}
      {!frame && !driving && !paused && liveViewUrl && (
        <iframe
          src={liveViewUrl}
          title="Agent browser session (view only)"
          tabIndex={-1}
          style={{
            width: '100%', height: 600, border: 'none', display: 'block',
            pointerEvents: 'none',
          }}
        />
      )}
    </section>
  );
}

const chip: React.CSSProperties = {
  padding: '3px 9px', background: 'transparent', color: 'inherit',
  border: '1px solid currentColor', borderRadius: 4, fontSize: 12, cursor: 'pointer',
};
