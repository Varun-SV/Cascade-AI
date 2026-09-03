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
  /** The provider's live session URL, or undefined when there is no browser. */
  liveViewUrl: string | undefined;
  /** Stop the agent using the browser for this run. */
  onStop: () => void;
}

export function BrowserLiveView({ liveViewUrl, onStop }: Props) {
  if (!liveViewUrl) return null;

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
          Cascade is using a browser. You can take over in this window.
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
        shows a thumbnail nobody can read or click accurately.

        `sandbox` is deliberately NOT set. The provider's viewer needs scripts,
        same-origin access to its own session, and pointer events to pass the
        user's clicks through; a sandbox tight enough to be worth having would
        break the interaction this panel exists for. The frame is third-party
        content the operator explicitly configured, which is the trust decision
        that was already made when they supplied the endpoint.
      */}
      <iframe
        src={liveViewUrl}
        title="Agent browser session"
        style={{ width: '100%', height: 600, border: 'none', display: 'block' }}
      />
    </section>
  );
}
