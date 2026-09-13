from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


controller = "src/browser/remote/controller.ts"
web = "cloud/web/src/chat/BrowserLiveView.tsx"
controller_test = "src/browser/remote/controller.test.ts"
web_test = "cloud/web/src/chat/BrowserLiveView.test.tsx"

# 1) A takeover request belongs to the viewer that asked for it. If that viewer
# unwatches/remounts while the request is queued behind an agent action, do not
# grant an invisible human hold after the wait.
replace_once(
    controller,
    """    if (!this.runs.has(runId)) {\n      return { ok: false, detail: 'This run has no browser open.' };\n    }\n    const lease = this.leaseFor(runId);\n""",
    """    const requested = this.runs.get(runId);\n    if (!requested) {\n      return { ok: false, detail: 'This run has no browser open.' };\n    }\n    // A takeover is a request for the VIEW the person is looking at, not a\n    // reservation on whichever view happens to exist after an agent action\n    // finishes. Snapshot both halves because unwatch clears the session without\n    // bumping the watch, while reconnect/remount bumps the watch and may reuse\n    // the same physical session. Either change invalidates the request.\n    const requestedCdp = requested.screencast;\n    const requestedWatch = requested.watchGen;\n    if (!requestedCdp || requestedWatch === undefined || !requested.onFrame) {\n      return { ok: false, detail: 'This browser is not being watched right now.' };\n    }\n    const lease = this.leaseFor(runId);\n""",
)
replace_once(
    controller,
    """      if (!held || held.page.isClosed()) {\n        return { ok: false, detail: 'That browser closed while you were waiting for it.' };\n      }\n      lease.takeOver(runId);\n""",
    """      if (!held || held.page.isClosed()) {\n        return { ok: false, detail: 'That browser closed while you were waiting for it.' };\n      }\n      // The panel may have gone away while this request was queued. Refuse\n      // rather than retarget: granting the human lease now would pause the\n      // agent on a hidden run until idle expiry, even though nobody is left to\n      // drive it. A replacement watcher is a different viewing boundary and\n      // can ask again once it has its own picture.\n      if (held.screencast !== requestedCdp || held.watchGen !== requestedWatch || !held.onFrame) {\n        return { ok: false, detail: 'The browser view changed while you were waiting. Take control again from the current view.' };\n      }\n      lease.takeOver(runId);\n""",
)

# 2) Main-frame navigation is a new sight epoch even when the CDP session and
# frame consumer stay physically attached. Bump watchGen so an old receipt can
# neither keep blind input enabled nor authorize Hide on the destination page.
replace_once(
    controller,
    "this.trackPageNavigation(held, page);",
    "this.trackPageNavigation(runId, held, page);",
)
replace_once(
    controller,
    "this.trackPageNavigation(held, next);",
    "this.trackPageNavigation(runId, held, next);",
)
replace_once(
    controller,
    """  /** Count main-frame navigation only while this page is the run's active page. */\n  private trackPageNavigation(held: RunBrowser, page: Page): void {\n    page.on('framenavigated', ((frame: unknown) => {\n      if (held.page !== page || frame !== page.mainFrame()) return;\n      held.generation += 1;\n    }) as never);\n  }\n""",
    """  /** Count main-frame navigation only while this page is the run's active page. */\n  private trackPageNavigation(runId: string, held: RunBrowser, page: Page): void {\n    page.on('framenavigated', ((frame: unknown) => {\n      if (held.page !== page || frame !== page.mainFrame()) return;\n      held.generation += 1;\n\n      // A different main document is also a different claim of SIGHT. The CDP\n      // session and callback deliberately survive navigation, so leaving the\n      // watch generation alone let the receipt for the old document vouch for\n      // the destination: hidden input stayed enabled across a password -> MFA\n      // navigation, and a stale receipt could immediately authorize Hide if the\n      // destination's first volatile frame was dropped. Give the same physical\n      // watcher a fresh generation instead. Its next decoded frame can confirm\n      // that generation; a late receipt for the old document cannot.\n      if (held.onFrame && held.watchGen !== undefined) {\n        held.watchGen += 1;\n        this.announceControl(runId);\n      }\n    }) as never);\n  }\n""",
)

# 3) Touch-only devices need a real remote gesture path. Pointer events cover
# touch without building a second touch-event stack. We explicitly handle taps
# too because cancelling touch pointer defaults suppresses compatibility mouse
# events on browsers that otherwise synthesize them.
replace_once(
    web,
    """  const pendingClickRef = useRef<{\n    button: number; clicks: number; clientX: number; clientY: number;\n  } | null>(null);\n""",
    """  const pendingClickRef = useRef<{\n    button: number; clicks: number; clientX: number; clientY: number;\n  } | null>(null);\n  /** One active finger gesture. A tap becomes a click; a drag becomes scroll. */\n  const touchGestureRef = useRef<{\n    pointerId: number; startX: number; startY: number; lastY: number; scrolling: boolean;\n  } | null>(null);\n  /** Suppress compatibility mouse events after a touch we handled ourselves. */\n  const ignoreMouseUntilRef = useRef(0);\n""",
)
replace_once(
    web,
    """      pendingScrollRef.current = null;\n      pendingClickRef.current = null;\n      // Text accumulated by an IME belongs to the same view as the pointer\n""",
    """      pendingScrollRef.current = null;\n      pendingClickRef.current = null;\n      touchGestureRef.current = null;\n      // Text accumulated by an IME belongs to the same view as the pointer\n""",
)
replace_once(
    web,
    """  /** Flush sampled wheel distance before a later discrete decision. */\n  const flushPendingScroll = () => {\n""",
    """  /** Queue one scroll distance without putting every sample in the remote FIFO. */\n  const queueScroll = (p: { x: number; y: number }, deltaY: number) => {\n    if (!Number.isFinite(deltaY) || deltaY === 0) return;\n    const now = Date.now();\n    const since = now - lastScrollRef.current;\n    if (since >= SCROLL_INTERVAL_MS && !pendingScrollRef.current) {\n      lastScrollRef.current = now;\n      onInput?.({ kind: 'scroll', ...p, deltaY });\n      return;\n    }\n    const pending = pendingScrollRef.current;\n    pendingScrollRef.current = { ...p, deltaY: (pending?.deltaY ?? 0) + deltaY };\n    if (scrollTimerRef.current) return;\n    scrollTimerRef.current = setTimeout(() => {\n      scrollTimerRef.current = null;\n      const total = pendingScrollRef.current;\n      pendingScrollRef.current = null;\n      if (!total) return;\n      lastScrollRef.current = Date.now();\n      onInput?.({ kind: 'scroll', ...total });\n    }, Math.max(0, SCROLL_INTERVAL_MS - since));\n  };\n\n  /** Flush sampled wheel/touch distance before a later discrete decision. */\n  const flushPendingScroll = () => {\n""",
)
replace_once(
    web,
    """          onMouseDown={driving ? (e) => {\n            // Keep the keyboard on the editable sink, where the browser can\n""",
    """          onMouseDown={driving ? (e) => {\n            if (Date.now() < ignoreMouseUntilRef.current) { e.preventDefault(); return; }\n            // Keep the keyboard on the editable sink, where the browser can\n""",
)
replace_once(
    web,
    """          onMouseUp={driving ? (e) => {\n            e.preventDefault();\n""",
    """          onMouseUp={driving ? (e) => {\n            if (Date.now() < ignoreMouseUntilRef.current) { e.preventDefault(); return; }\n            e.preventDefault();\n""",
)
replace_once(
    web,
    """          onContextMenu={driving ? (e) => e.preventDefault() : undefined}\n          onWheel={driving ? (e) => {\n            const p = at(e.clientX, e.clientY);\n            if (!p) return;\n            const dy = wheelPixels(e, frame.height);\n            const now = Date.now();\n            const since = now - lastScrollRef.current;\n            if (since >= SCROLL_INTERVAL_MS && !pendingScrollRef.current) {\n              lastScrollRef.current = now;\n              onInput?.({ kind: 'scroll', ...p, deltaY: dy });\n              return;\n            }\n            const pending = pendingScrollRef.current;\n            pendingScrollRef.current = { ...p, deltaY: (pending?.deltaY ?? 0) + dy };\n            if (scrollTimerRef.current) return;\n            scrollTimerRef.current = setTimeout(() => {\n              scrollTimerRef.current = null;\n              const total = pendingScrollRef.current;\n              pendingScrollRef.current = null;\n              if (!total) return;\n              lastScrollRef.current = Date.now();\n              onInput?.({ kind: 'scroll', ...total });\n            }, Math.max(0, SCROLL_INTERVAL_MS - since));\n          } : undefined}\n""",
    """          onPointerDown={driving ? (e) => {\n            if (e.pointerType !== 'touch') return;\n            const p = at(e.clientX, e.clientY);\n            if (!p) return;\n            e.preventDefault();\n            ignoreMouseUntilRef.current = Date.now() + 750;\n            touchGestureRef.current = {\n              pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,\n              lastY: e.clientY, scrolling: false,\n            };\n            try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* best effort */ }\n          } : undefined}\n          onPointerMove={driving ? (e) => {\n            if (e.pointerType !== 'touch') return;\n            const gesture = touchGestureRef.current;\n            if (!gesture || gesture.pointerId !== e.pointerId) return;\n            e.preventDefault();\n            const p = at(e.clientX, e.clientY);\n            if (!p) return;\n            const dx = e.clientX - gesture.startX;\n            const dyFromStart = e.clientY - gesture.startY;\n            if (!gesture.scrolling && (dx * dx) + (dyFromStart * dyFromStart) <= CLICK_SLOP_PX * CLICK_SLOP_PX) return;\n            const deltaY = gesture.lastY - e.clientY;\n            gesture.scrolling = true;\n            gesture.lastY = e.clientY;\n            queueScroll(p, deltaY);\n          } : undefined}\n          onPointerUp={driving ? (e) => {\n            if (e.pointerType !== 'touch') return;\n            const gesture = touchGestureRef.current;\n            if (!gesture || gesture.pointerId !== e.pointerId) return;\n            e.preventDefault();\n            touchGestureRef.current = null;\n            const dx = e.clientX - gesture.startX;\n            const dy = e.clientY - gesture.startY;\n            const p = at(e.clientX, e.clientY);\n            if (!p) return;\n            if (gesture.scrolling || (dx * dx) + (dy * dy) > CLICK_SLOP_PX * CLICK_SLOP_PX) {\n              if (!gesture.scrolling) queueScroll(p, gesture.startY - e.clientY);\n              flushPendingScroll();\n              return;\n            }\n            keyboardRef.current?.focus();\n            flushPendingScroll();\n            onInput?.({ kind: 'click', ...p, button: 'left', clicks: 1 });\n          } : undefined}\n          onPointerCancel={driving ? (e) => {\n            if (e.pointerType !== 'touch') return;\n            const gesture = touchGestureRef.current;\n            if (!gesture || gesture.pointerId !== e.pointerId) return;\n            e.preventDefault();\n            touchGestureRef.current = null;\n            if (gesture.scrolling) flushPendingScroll();\n          } : undefined}\n          onContextMenu={driving ? (e) => e.preventDefault() : undefined}\n          onWheel={driving ? (e) => {\n            const p = at(e.clientX, e.clientY);\n            if (!p) return;\n            queueScroll(p, wheelPixels(e, frame.height));\n          } : undefined}\n""",
)
replace_once(
    web,
    """            ...(driving ? { cursor: 'crosshair' } : { pointerEvents: 'none' }),\n""",
    """            ...(driving ? { cursor: 'crosshair', touchAction: 'none' } : { pointerEvents: 'none' }),\n""",
)

# Controller regressions: a queued takeover cannot survive its watcher, and
# main-document navigation invalidates the old sight receipt until a fresh frame
# from the new generation is decoded/acknowledged.
controller_extra = r'''

describe('round 34 view-boundary regressions', () => {
  it('does not grant a queued takeover after the viewer has left', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#open' }, ctx('run-A', 'w1'));
    await c.startWatching('run-A', () => {});
    cdp.pushFrame(1);

    const entered = deferred();
    const release = deferred();
    const realClick = page.click;
    page.click = async (selector: string) => {
      page.calls.push(`click:${selector}`);
      if (selector === '#slow') {
        entered.resolve();
        await release.promise;
      }
    };

    const acting = c.controller({ kind: 'click', selector: '#slow' }, ctx('run-A', 'w1'));
    await entered.promise;
    const takeover = c.takeOver('run-A');
    await Promise.resolve();

    // The person switches conversations while Take control is still waiting.
    // stopWatching invalidates the consumer immediately, before its detach can
    // take the action slot behind the same slow action.
    const unwatch = c.stopWatching('run-A');
    await Promise.resolve();
    release.resolve();

    expect((await acting).ok).toBe(true);
    const out = await takeover;
    expect(out.ok, 'a button from a view that no longer exists cannot acquire the human lease').toBe(false);
    expect(out.detail).toMatch(/view changed|not being watched/i);
    expect(c.humanHolds('run-A'), 'the hidden run remains available to the agent').toBe(false);
    await unwatch;
    page.click = realClick;
  });

  it('requires a fresh sight receipt after main-frame navigation', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    const frames: BrowserFrame[] = [];
    const states: Array<{ human: boolean; capturing: boolean; confirmed: boolean }> = [];

    await c.controller({ kind: 'click', selector: '#open' }, ctx('run-A', 'w1'));
    c.onControlFor('run-A', (state) => states.push(state));
    await c.startWatching('run-A', (frame) => frames.push(frame));
    cdp.pushFrame(7, 'LOGIN');
    const login = frames.at(-1)!;
    c.frameSeen('run-A', login.generation);
    c.actorEnded('w1');
    expect((await c.takeOver('run-A')).ok).toBe(true);
    expect(await c.setCapture('run-A', false), 'the confirmed login page can be hidden').toBe(false);

    // A password submission can navigate while capture is deliberately off.
    // The receipt for LOGIN must not vouch for the MFA document.
    await page.goto('https://mfa.test/');
    expect(states.at(-1)?.confirmed, 'navigation immediately invalidates sight').toBe(false);
    const blind = await c.input('run-A', { kind: 'text', text: '123456' });
    expect(blind.ok, 'blind input stays shut on a document this watch has never seen').toBe(false);
    expect(cdp.calls.filter((x) => x.method === 'Input.insertText').map((x) => x.params?.['text']))
      .not.toContain('123456');

    // Showing produces a frame under the NEW sight generation. Only its receipt
    // can reopen Hide/blind typing.
    expect(await c.setCapture('run-A', true)).toBe(true);
    await Promise.resolve();
    const mfa = frames.at(-1)!;
    expect(mfa.generation, 'navigation creates a new receipt namespace').not.toBe(login.generation);
    expect(states.at(-1)?.confirmed, 'a delivered frame is not yet a viewer receipt').toBe(false);
    c.frameSeen('run-A', mfa.generation);
    expect(states.at(-1)?.confirmed).toBe(true);
    expect(await c.setCapture('run-A', false)).toBe(false);
    expect((await c.input('run-A', { kind: 'text', text: '123456' })).ok).toBe(true);
  });
});
'''
Path(controller_test).write_text(Path(controller_test).read_text() + controller_extra)

web_extra = r'''

describe('BrowserLiveView — touch takeover gestures', () => {
  const frame = { data: 'TOUCH', width: 1280, height: 800, generation: 1 };

  it('turns a finger drag into remote scroll and keeps the local chat still', () => {
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human confirmed
        onStop={() => {}} onInput={onInput} />,
    );
    const img = screen.getByRole('img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400 }) as DOMRect;
    expect(img).toHaveStyle({ touchAction: 'none' });

    fireEvent.pointerDown(img, { pointerId: 4, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 300 });
    fireEvent.pointerMove(img, { pointerId: 4, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 220 });
    fireEvent.pointerUp(img, { pointerId: 4, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 220 });

    expect(onInput.mock.calls.map((c) => c[0]).filter((e) => e.kind === 'scroll'))
      .toEqual([{ kind: 'scroll', x: 0.5, y: 0.55, deltaY: 80 }]);
    expect(onInput.mock.calls.some((c) => c[0].kind === 'click'), 'a swipe is not a tap').toBe(false);
  });

  it('keeps a touch tap as one remote click', () => {
    const onInput = vi.fn();
    render(
      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human confirmed
        onStop={() => {}} onInput={onInput} />,
    );
    const img = screen.getByRole('img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400 }) as DOMRect;

    fireEvent.pointerDown(img, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 200 });
    fireEvent.pointerUp(img, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: 322, clientY: 201 });

    expect(onInput.mock.calls.map((c) => c[0]).filter((e) => e.kind === 'click'))
      .toEqual([{ kind: 'click', x: 0.503125, y: 0.5025, button: 'left', clicks: 1 }]);
  });
});
'''
Path(web_test).write_text(Path(web_test).read_text() + web_extra)

print('round34 patch applied')
