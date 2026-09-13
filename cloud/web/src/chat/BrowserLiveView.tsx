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
 * Maximum local pointer travel that still counts as the same click gesture.
 *
 * Mouse-down and mouse-up are deliberately separate so a drag can cancel a
 * destructive click. Leaving the image already cancels the candidate, but a
 * drag can stay entirely inside the frame; without a distance check that would
 * turn a press on one remote element into a click on whatever is under release.
 * A few CSS pixels keeps ordinary hand jitter usable without treating a real
 * drag as a click.
 */
const CLICK_SLOP_PX = 5;

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
  | { kind: 'key'; key: string; modifiers?: Array<'Control' | 'Meta' | 'Shift'> };

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
  /**
   * WHICH run's browser this is.
   *
   * Not rendered — it is the view's identity, and the sampled-input timers need
   * it. A held-back move or an accumulated scroll belongs to the page it was
   * made on, and switching straight from one conversation to another whose
   * browser is ALSO under human control leaves `driving` true the whole way, so
   * nothing else here changes to say the view did.
   */
  taskId?: string | undefined;
}

export function BrowserLiveView({
  active, liveViewUrl, frame, streaming, human, capturing, confirmed, notice,
  onStop, onTakeOver, onHandBack, onInput, onCapture, onFrameShown, taskId,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  /**
   * An actual editable element, kept visually out of the way, is the keyboard
   * boundary for the remote page.
   *
   * This is not decorative. `keydown` can approximate ASCII, but it cannot
   * produce what an input method commits: dead keys, CJK IMEs, compose keys,
   * mobile/software keyboards, AltGr layouts and other text systems all turn
   * several physical key events into one browser `input` event. Feeding the
   * remote page `event.key` therefore dropped or corrupted perfectly ordinary
   * text. A textarea lets the LOCAL browser do the layout/IME work it already
   * knows how to do; we forward only the committed text.
   */
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  /**
   * A pointer press is only a candidate click until the matching release.
   * Sending a complete remote click from mouse-down made dragging away unable
   * to cancel a destructive action: the server had already pressed AND
   * released before the local button came back up.
   */
  const pendingClickRef = useRef<{
    button: number; clicks: number; clientX: number; clientY: number;
  } | null>(null);
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
  const hasFrame = frame !== undefined;
  const watchable = hasFrame || (!!liveViewUrl && !paused);
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
  // Ownership is not enough to type. Across a reconnect `human` deliberately
  // survives while this watch has seen nothing yet; keeping the old textarea
  // mounted would keep browser focus too, so the next physical key could reach
  // a page whose fresh frame has not even been confirmed. Mount the keyboard
  // boundary only for a confirmed current picture or confirmed blind mode.
  const keyboardEnabled = driving && confirmed === true && (hasFrame || blind);
  // Focus follows the keyboard boundary, because the visual surface may vanish
  // when the person presses Hide. The textarea stays mounted while they hold
  // control, so composition/dead-key state and paste all have one stable target.
  useEffect(() => {
    if (blind) keyboardRef.current?.focus();
  }, [blind]);

  // React 19 delegates wheel through a passive listener. Consume the local
  // default with a native non-passive listener while the event still bubbles
  // to React's handler, which forwards the same gesture to CDP.
  useEffect(() => {
    if (!active || !driving || !hasFrame) return;
    const img = imgRef.current;
    if (!img) return;
    const keepWheelRemote = (event: WheelEvent) => event.preventDefault();
    img.addEventListener('wheel', keepWheelRemote, { passive: false });
    return () => img.removeEventListener('wheel', keepWheelRemote);
  }, [active, driving, hasFrame]);

  // A held-back move must not outlive the control it was made under, NOR the
  // page it was made on.
  //
  // Keyed on the task as well as on `driving`, because the two failures are
  // different and only one of them changes `driving`. Giving the page back ends
  // the control: a trailing position arriving after it would be refused and put
  // a notice on screen for a mouse that moved before the person let go.
  // Switching straight to another conversation whose browser is also held ends
  // the PAGE while `driving` stays true throughout — and `sendBrowserInput`
  // reads the task id at send time, so A's coordinates or A's accumulated
  // scroll distance would arrive at B, moving or scrolling the wrong remote
  // page. Anything still pending belongs to the view that produced it.
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
      pendingClickRef.current = null;
      // Text accumulated by an IME belongs to the same view as the pointer
      // samples above. Never let a composition started in task A become the
      // first input delivered after a straight switch to task B.
      if (keyboardRef.current) keyboardRef.current.value = '';
    };
  }, [driving, taskId]);

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
   * A paste, forwarded as the text it carries.
   *
   * Clipboard text is read only from the person's paste gesture and goes
   * through the same lease/action slot as typed text. Preventing the local
   * insertion also means the keyboard sink stays empty, so the subsequent
   * `input` event cannot send the paste a second time.
   */
  /** Flush sampled wheel distance before a later discrete decision. */
  const flushPendingScroll = () => {
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
    const total = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (!total) return;
    lastScrollRef.current = Date.now();
    onInput?.({ kind: 'scroll', ...total });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text) return;
    e.preventDefault();
    e.currentTarget instanceof HTMLTextAreaElement && (e.currentTarget.value = '');
    // Preserve gesture order: a sampled wheel delta happened before
    // this discrete paste and must reach the remote FIFO first.
    flushPendingScroll();
    onInput?.({ kind: 'text', text });
  };

  /**
   * Command keys are protocol commands; printable text is NOT.
   *
   * Printable keys fall through into the textarea so the local browser can
   * apply Shift, AltGr, dead-key and IME rules and emit the resulting text. A
   * shifted command, however, is a DIFFERENT command (`Shift+Tab`, selection
   * with Shift+Arrow, newline semantics of Shift+Enter). The protocol has no
   * modifier field, so sending its base key would perform an action the person
   * did not request. Refuse it locally rather than silently degrading it.
   */
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // During composition, physical key names (`Process`, Enter, arrows) belong
    // to the IME, not to the remote page. The committed text arrives via input.
    if (e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Dead') return;

    // Editing chords are different from browser/application shortcuts. Letting
    // Ctrl/Meta+A run only against this always-empty off-screen textarea and
    // then forwarding the person's replacement text changes APPEND into
    // REPLACE-without-the-replace. Carry the chord to the remote boundary so
    // safe edits (select-all, undo/redo, delete-word) happen there. Copy/cut are
    // sent too, but the controller refuses them explicitly because a remote
    // clipboard is not the local clipboard the person expects.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const editing = new Set(['a', 'c', 'x', 'z', 'y', 'Backspace', 'Delete']);
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (editing.has(key)) {
        e.preventDefault();
        e.currentTarget.value = '';
        flushPendingScroll();
        const modifiers: Array<'Control' | 'Meta' | 'Shift'> = [];
        if (e.ctrlKey) modifiers.push('Control');
        if (e.metaKey) modifiers.push('Meta');
        if (e.shiftKey) modifiers.push('Shift');
        onInput?.({ kind: 'key', key, modifiers });
      }
      return;
    }
    // Let Alt/AltGr and unrelated local browser shortcuts do their normal thing.
    if (e.altKey) return;
    if (!COMMAND_KEYS.has(e.key)) return;
    e.preventDefault();
    // Shift+Tab/Arrow/Enter is a materially different command. This protocol
    // still does not expose those shifted navigation commands, so fail closed.
    if (e.shiftKey) return;
    e.currentTarget.value = '';
    flushPendingScroll();
    onInput?.({ kind: 'key', key: e.key });
  };

  /**
   * Text AFTER the local browser has resolved layout/composition.
   *
   * `InputEvent.isComposing` remains true for intermediate IME updates, which
   * are candidate-state rather than committed text and must never reach the
   * remote page. The final input event is non-composing and the textarea value
   * then contains exactly the committed string — including dead-key accents,
   * CJK text or a Shift/AltGr-produced symbol. Send it once, then clear the
   * sink so the next input cannot repeat it.
   */
  const onTextInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent as InputEvent;
    if (native.isComposing) return;
    const text = e.currentTarget.value;
    if (!text) return;
    e.currentTarget.value = '';
    flushPendingScroll();
    onInput?.({ kind: 'text', text });
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
        {(driving || takeable) && (
          <button
            type="button"
            onClick={() => {
              if (driving) {
                // A wheel delta sampled before Give it back is still part of
                // the person's gesture. Send it first; the server's action slot
                // then makes handback wait until that scroll has actually
                // landed instead of releasing ownership and refusing it later.
                flushPendingScroll();
                onHandBack?.();
              } else {
                onTakeOver?.();
              }
            }}
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
      {keyboardEnabled && (
        <textarea
          ref={keyboardRef}
          aria-label="Type into the agent browser"
          tabIndex={0}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onKey}
          onInput={onTextInput}
          onPaste={onPaste}
          style={{
            position: 'fixed', left: -10000, top: 0, width: 1, height: 1,
            opacity: 0, pointerEvents: 'none', resize: 'none',
          }}
        />
      )}
      {frame && (
        <img
          ref={imgRef}
          src={`data:image/jpeg;base64,${frame.data}`}
          alt="The page Cascade's browser is on"
          title={driving ? 'Agent browser session (you have control)' : 'Agent browser session (view only)'}
          tabIndex={-1}
          draggable={false}
          onMouseDown={driving ? (e) => {
            // Keep the keyboard on the editable sink, where the browser can
            // perform real layout/IME composition instead of us guessing from
            // keydown. Mouse-down itself is NOT a remote click: the person can
            // still drag away and release to cancel it, just like a local page.
            e.preventDefault();
            keyboardRef.current?.focus();
            pendingClickRef.current = null;
            if (e.button > 2) return;
            if (!at(e.clientX, e.clientY)) return;
            pendingClickRef.current = {
              button: e.button, clicks: e.detail || 1,
              clientX: e.clientX, clientY: e.clientY,
            };
          } : undefined}
          onMouseUp={driving ? (e) => {
            e.preventDefault();
            const press = pendingClickRef.current;
            pendingClickRef.current = null;
            if (!press || press.button !== e.button) return;
            const dx = e.clientX - press.clientX;
            const dy = e.clientY - press.clientY;
            if ((dx * dx) + (dy * dy) > CLICK_SLOP_PX * CLICK_SLOP_PX) return;
            const p = at(e.clientX, e.clientY);
            if (!p) return;
            // The sampled wheel happened before this completed click. Flush it
            // before the discrete event so the remote FIFO preserves gesture order.
            flushPendingScroll();
            onInput?.({
              kind: 'click', ...p,
              button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
              clicks: e.detail || press.clicks || 1,
            });
          } : undefined}
          onMouseLeave={driving ? (e) => {
            // Leaving while a button is down cancels the candidate. If the
            // person comes back before releasing, they must press again; being
            // conservative here is preferable to committing a destructive click
            // whose release happened somewhere else.
            if (e.buttons !== 0) pendingClickRef.current = null;
          } : undefined}
          onMouseMove={driving ? (e) => {
            const p = at(e.clientX, e.clientY);
            if (!p) return;
            const now = Date.now();
            const since = now - lastMoveRef.current;
            if (since >= MOVE_INTERVAL_MS) {
              if (moveTimerRef.current) {
                clearTimeout(moveTimerRef.current);
                moveTimerRef.current = null;
              }
              pendingMoveRef.current = null;
              lastMoveRef.current = now;
              onInput?.({ kind: 'move', ...p });
              return;
            }
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
            if (since >= SCROLL_INTERVAL_MS && !pendingScrollRef.current) {
              lastScrollRef.current = now;
              onInput?.({ kind: 'scroll', ...p, deltaY: dy });
              return;
            }
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
          onLoad={() => {
            if (frame.generation !== undefined) onFrameShown?.(frame.generation);
          }}
          style={{
            width: '100%', minHeight: 400, maxHeight: 600, objectFit: 'contain',
            display: 'block', background: '#000',
            ...(driving ? { cursor: 'crosshair' } : { pointerEvents: 'none' }),
          }}
        />
      )}
      {!frame && driving && (
        blind ? (
          <div
            role="group"
            aria-label="Agent browser, picture hidden"
            onMouseDown={() => keyboardRef.current?.focus()}
            style={{
              width: '100%', minHeight: 400, display: 'grid', placeItems: 'center',
              background: '#000', color: 'var(--warn-fg, #f5c96b)', fontSize: 13,
              textAlign: 'center', padding: 16, cursor: 'text',
            }}
          >
            <span>The picture is hidden. What you type still goes to the page.</span>
          </div>
        ) : (
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
