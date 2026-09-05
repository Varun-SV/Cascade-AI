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
  /** Stop the agent using the browser for this run. */
  onStop: () => void;
}

export function BrowserLiveView({ active, liveViewUrl, onStop }: Props) {
  if (!active) return null;

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
          {liveViewUrl
            ? 'Cascade is using a browser. Watch it here, and stop it whenever you want.'
            : 'Cascade is using a browser. This provider cannot stream it, so you cannot watch it — only stop it.'}
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
        A minimum height because these viewers are unusable when squeezed — the
        page renders at the remote viewport and scales down, so a short frame
        shows a thumbnail nobody can read.

        `pointer-events: none` is the point of this element, not styling. The
        URL already asks the provider for a watch-only session, but that flag's
        meaning belongs to the provider — and if input DOES get through, it goes
        straight to the live session over the provider's own channel, never
        through the lease that decides who may drive this page. The agent would
        then be mid-`click` while the user typed into the same form, and its
        action would land on top of theirs. Refusing pointer events here makes
        watch-only a property of our own code rather than a request.

        `sandbox` is deliberately NOT set. The viewer needs scripts and
        same-origin access to its own session, and a sandbox permitting both is
        equivalent to none — it would cost the stream and buy nothing. The frame
        is third-party content the operator explicitly configured, which is the
        trust decision they already made when they supplied the endpoint.
      */}
      {/* Only when there is something to show. An empty frame reads as broken;
          the banner above says plainly that this configuration cannot be
          watched, which is the honest version of the same information. */}
      {liveViewUrl && (
        <iframe
          src={liveViewUrl}
          title="Agent browser session (view only)"
          // Not focusable either: a keystroke into the frame is input too.
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
