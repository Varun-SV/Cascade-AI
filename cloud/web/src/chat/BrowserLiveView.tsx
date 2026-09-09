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

import { useRef } from 'react';

/** The keys the server will accept as commands. Everything else is text. */
const COMMAND_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

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
  frame?: { data: string; width: number; height: number } | undefined;
  /** The server confirmed a stream is running, so a blank panel is worth explaining. */
  streaming?: boolean;
  /** The user holds the page: the agent is being refused until they hand it back. */
  human?: boolean;
  /** Whether frames are being produced. False while the picture is paused. */
  capturing?: boolean;
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
  /** Pause or resume the picture without giving the page back. */
  onCapture?: (on: boolean) => void;
}

export function BrowserLiveView({
  active, liveViewUrl, frame, streaming, human, capturing, notice,
  onStop, onTakeOver, onHandBack, onInput, onCapture,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  if (!active) return null;
  // Frames first: they come from the browser itself, so they exist whoever is
  // hosting it. The provider's own viewer is the fallback for a deployment
  // still on the old path, and neither being available is now unusual rather
  // than expected.
  const watchable = !!frame || !!liveViewUrl;
  // Taking over means driving the frames, so it is offered only where they are
  // the thing on screen. The provider's iframe has no lease behind it — input
  // through it would be a second, uncoordinated controller racing the agent.
  const takeable = !!frame || streaming === true;
  const driving = human === true;

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
    ? capturing === false
      ? 'You have control. The picture is paused — Cascade cannot see this page either.'
      : 'You have control of this browser. Cascade is paused until you give it back.'
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
        {driving && (
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
            const p = at(e.clientX, e.clientY);
            if (p) onInput?.({ kind: 'click', ...p, button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left', clicks: e.detail || 1 });
          } : undefined}
          onContextMenu={driving ? (e) => e.preventDefault() : undefined}
          onWheel={driving ? (e) => {
            const p = at(e.clientX, e.clientY);
            if (p) onInput?.({ kind: 'scroll', ...p, deltaY: e.deltaY });
          } : undefined}
          onKeyDown={driving ? onKey : undefined}
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
        capturing === false ? (
          <div
            ref={(el) => {
              // Focus follows the surface, because the element the person was
              // typing into just unmounted.
              if (el) el.focus();
            }}
            role="group"
            aria-label="Agent browser, picture hidden"
            tabIndex={0}
            onKeyDown={onKey}
            style={{
              width: '100%', minHeight: 400, display: 'grid', placeItems: 'center',
              background: '#000', color: 'var(--warn-fg, #f5c96b)', fontSize: 13,
              textAlign: 'center', padding: 16, cursor: 'text',
            }}
          >
            <span>The picture is hidden. What you type still goes to the page.</span>
          </div>
        ) : (
          // Inert on purpose: nothing to see yet, so nothing to type into.
          <div
            aria-label="Agent browser, waiting for the first picture"
            style={{
              width: '100%', minHeight: 400, display: 'grid', placeItems: 'center',
              background: '#000', color: 'var(--ink-400, #888)', fontSize: 13,
              textAlign: 'center', padding: 16,
            }}
          >
            <span>Waiting for the first picture. You can type once you can see the page.</span>
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
      {!frame && !driving && liveViewUrl && (
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
