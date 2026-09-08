// ─────────────────────────────────────────────
//  Cascade Cloud — watching the agent's browser
// ─────────────────────────────────────────────
//
//  The web surface's answer to the desktop's visibility gate.
//
//  On the desktop the agent refuses to act unless the browser is on screen,
//  which is what makes its Stop button mean something: the user can always see
//  what they are stopping. A browser in someone else's data centre offers no
//  such guarantee, so this panel takes that role — the provider streams the
//  live session, the user watches it happen, and Stop is right there.
//
//  The iframe src is a BEARER CAPABILITY issued by the provider: it carries its
//  own session credential and is deliberately token-free so it can be embedded.
//  It arrives over the socket, lives in component state, and goes nowhere else.

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
  /** Stop the agent using the browser for this run. */
  onStop: () => void;
}

export function BrowserLiveView({ active, liveViewUrl, frame, streaming, onStop }: Props) {
  if (!active) return null;
  // Frames first: they come from the browser itself, so they exist whoever is
  // hosting it. The provider's own viewer is the fallback for a deployment
  // still on the old path, and neither being available is now unusual rather
  // than expected.
  const watchable = !!frame || !!liveViewUrl;

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
          background: 'var(--warn-bg, #4a3410)', color: 'var(--warn-fg, #f5c96b)',
          fontSize: 12.5, flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}
        />
        <span style={{ flex: 1 }}>
          {watchable
            ? 'Cascade is using a browser. Watch it here, and stop it whenever you want.'
            : streaming
              ? 'Cascade is using a browser. Waiting for the first frame…'
              : 'Cascade is using a browser. It cannot be streamed right now, so you can only stop it.'}
        </span>
        <button
          type="button"
          onClick={onStop}
          title="Stop Cascade from using the browser for this run"
          style={{
            padding: '3px 9px', background: 'transparent', color: 'inherit',
            border: '1px solid currentColor', borderRadius: 4, fontSize: 12, cursor: 'pointer',
          }}
        >
          Stop
        </button>
      </header>
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

        `pointer-events: none`, and not focusable, is the point of this element
        rather than styling. Watching is not driving: input here would reach the
        session without passing through the lease that decides who may act on
        the page, so the agent could be mid-click while the user typed into the
        same form. Making the view inert is what keeps "watch-only" a property
        of this code rather than a promise about someone else's.
      */}
      {frame && (
        <img
          src={`data:image/jpeg;base64,${frame.data}`}
          alt="The page Cascade's browser is on"
          title="Agent browser session (view only)"
          tabIndex={-1}
          style={{
            width: '100%', minHeight: 400, maxHeight: 600, objectFit: 'contain',
            display: 'block', background: '#000', pointerEvents: 'none',
          }}
        />
      )}
      {/*
        The provider's own viewer, for a deployment not yet streaming frames.
        Same inertness for the same reason — and `sandbox` is deliberately unset
        here, because the viewer needs scripts and same-origin access to its own
        session and a sandbox permitting both is equivalent to none.
      */}
      {!frame && liveViewUrl && (
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
