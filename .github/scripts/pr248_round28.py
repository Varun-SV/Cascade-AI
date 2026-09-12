from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


controller = Path('src/browser/remote/controller.ts')
s = controller.read_text()

s = replace_once(
    s,
    "  watchQueue?: Promise<unknown>;\n",
    "  watchQueue?: Promise<unknown>;\n"
    "  /**\n"
    "   * One physical CDP attachment attempt for this run.\n"
    "   *\n"
    "   * Watchers are serialized with each other by `watchQueue`, but the\n"
    "   * agent can also need a temporary visibility-proof session while it\n"
    "   * already holds the action slot. Putting that path on `watchQueue`\n"
    "   * would deadlock behind an unwatch that is itself waiting for the\n"
    "   * action slot, so attachment has its own narrower single-flight.\n"
    "   */\n"
    "  attaching?: Promise<CDPSession | null>;\n",
    'RunBrowser attaching field',
)

s = replace_once(
    s,
    "      return (await this.attachScreencast(runId, held, onFrame)) !== null;\n",
    "      const attached = await this.attachScreencast(runId, held, onFrame);\n"
    "      // A failed watch must not leave a dead consumer installed. A real\n"
    "      // watcher that replaced this one meanwhile owns the callback now.\n"
    "      if (!attached && held.onFrame === onFrame) held.onFrame = undefined;\n"
    "      return attached !== null;\n",
    'startWatching attach result',
)

old_header = """  /** Open the CDP session and start the stream, or leave nothing behind. */
  private async attachScreencast(
    runId: string,
    held: RunBrowser,
    onFrame: (frame: BrowserFrame) => void,
  ): Promise<CDPSession | null> {
    const cdp = await held.page.context().newCDPSession(held.page);
"""
new_header = """  /**
   * Attach at most one physical CDP screencast session at a time.
   *
   * `startWatching()` already serializes watcher lifecycle through `watchQueue`,
   * but the agent's detached-hidden restore cannot join that queue: it holds the
   * action slot, while an earlier unwatch may be waiting for exactly that slot.
   * Sharing only the physical attach closes the two-session race without making
   * watcher teardown and agent mutation wait on each other in a cycle.
   *
   * A real watcher claims `onFrame` immediately, before it waits for an attach
   * already started by the agent. The lower-level attach never writes the sink,
   * so finishing an older temporary attempt cannot overwrite a newer viewer.
   */
  private async attachScreencast(
    runId: string,
    held: RunBrowser,
    onFrame?: (frame: BrowserFrame) => void,
  ): Promise<CDPSession | null> {
    if (onFrame) held.onFrame = onFrame;
    if (held.screencast) return held.screencast;

    const existing = held.attaching;
    if (existing) {
      const cdp = await existing;
      if (cdp && onFrame) held.onFrame = onFrame;
      return cdp;
    }

    const attempt = this.attachScreencastFresh(runId, held);
    held.attaching = attempt;
    try {
      const cdp = await attempt;
      if (cdp && onFrame) held.onFrame = onFrame;
      return cdp;
    } finally {
      if (held.attaching === attempt) held.attaching = undefined;
    }
  }

  /** Open one new CDP session and start the stream when it is safe to do so. */
  private async attachScreencastFresh(
    runId: string,
    held: RunBrowser,
  ): Promise<CDPSession | null> {
    // An attachment can be requested for two very different reasons. Ordinary
    // watching may fall back to the provider iframe if CDP viewing is broken;
    // a privacy pause or failed visibility proof may NOT be repaired into
    // "visible" just because the transport failed. Remember which contract this
    // attempt started under before any awaited session creation can fail.
    const safetyGate = held.hiddenByHolder === true || held.visibilityUnconfirmed === true;
    let cdp: CDPSession;
    try {
      cdp = await held.page.context().newCDPSession(held.page);
    } catch {
      if (!safetyGate) {
        // Ordinary viewer failure: do not make the UI suppress a usable provider
        // fallback by confusing transport failure with an explicit Hide.
        held.visibilityUnconfirmed = false;
        held.capturing = true;
        this.announceControl(runId);
      }
      return null;
    }
"""
s = replace_once(s, old_header, new_header, 'attachScreencast header')

old_start_failure = """      } catch {
        // An ordinary CDP-watch failure is not a privacy pause. If we
        // left `capturing: false` here the client would suppress the
        // provider viewer even though that fallback may still work.
        held.visibilityUnconfirmed = false;
        held.capturing = true;
        this.announceControl(runId);
        await cdp.detach().catch(() => {});
        return null;
      }
"""
new_start_failure = """      } catch {
        if (!safetyGate) {
          // An ordinary CDP-watch failure is not a privacy pause. If we left
          // `capturing: false` here the client would suppress the provider
          // viewer even though that fallback may still work.
          held.visibilityUnconfirmed = false;
          held.capturing = true;
          this.announceControl(runId);
        } else {
          // A failed retry of a real privacy/unconfirmed state is the opposite:
          // fail closed and let a later attempt prove visibility with a frame.
          held.capturing = false;
          this.announceControl(runId);
        }
        await cdp.detach().catch(() => {});
        return null;
      }
"""
s = replace_once(s, old_start_failure, new_start_failure, 'startScreencast failure semantics')

s = replace_once(
    s,
    "    held.screencast = cdp;\n    held.onFrame = onFrame;\n    held.capturing = !paused;\n",
    "    held.screencast = cdp;\n"
    "    // Consumer ownership belongs to the caller above. In particular, never\n"
    "    // let an older temporary attach overwrite a watcher that arrived\n"
    "    // while `newCDPSession` / `startScreencast` was still pending.\n"
    "    held.capturing = !paused;\n",
    'do not overwrite frame consumer at attach completion',
)

old_temp_type = """    let temporaryCapture: {
      held: RunBrowser;
      cdp: CDPSession;
      sink: (frame: BrowserFrame) => void;
      watchGen: number | undefined;
    } | undefined;
"""
new_temp_type = """    let temporaryCapture: {
      held: RunBrowser;
      cdp: CDPSession;
      watchGen: number | undefined;
    } | undefined;
"""
s = replace_once(s, old_temp_type, new_temp_type, 'temporary capture type')

old_temp_attach = """      if ((held.hiddenByHolder === true || held.visibilityUnconfirmed === true) && !held.screencast) {
        const sink = (_frame: BrowserFrame) => {};
        const watchGen = held.watchGen;
        let cdp: CDPSession | null = null;
        try {
          cdp = await this.attachScreencast(runId, held, sink);
        } catch {
          // A failed attach is the same safety outcome as a failed restore:
          // without a picture proof the action must not reach the page.
        }
        if (!cdp) {
          return {
            ok: false,
            detail: 'The page could not be shown again, so nothing was done to it.',
          };
        }
        temporaryCapture = { held, cdp, sink, watchGen };
      }
"""
new_temp_attach = """      if ((held.hiddenByHolder === true || held.visibilityUnconfirmed === true) && !held.screencast) {
        const watchGen = held.watchGen;
        let cdp: CDPSession | null = null;
        try {
          // No no-op consumer is installed here. `nextFrame` below needs the
          // Chrome event, not a viewer callback. If a real watcher arrives while
          // this attachment is pending it claims `held.onFrame`, bumps the watch
          // generation, and shares this same physical session.
          cdp = await this.attachScreencast(runId, held);
        } catch {
          // A failed attach is the same safety outcome as a failed restore:
          // without a picture proof the action must not reach the page.
        }
        if (!cdp) {
          return {
            ok: false,
            detail: 'The page could not be shown again, so nothing was done to it.',
          };
        }
        // Only the no-viewer path owns this as a temporary session. A watcher
        // that arrived while the attach was pending adopts it instead.
        if (held.onFrame === undefined && held.watchGen === watchGen) {
          temporaryCapture = { held, cdp, watchGen };
        }
      }
"""
s = replace_once(s, old_temp_attach, new_temp_attach, 'temporary attach sharing')

s = replace_once(
    s,
    "        const { held, cdp, sink, watchGen } = temporaryCapture;\n",
    "        const { held, cdp, watchGen } = temporaryCapture;\n",
    'temporary cleanup destructure',
)
s = replace_once(
    s,
    "          && held.onFrame === sink\n          && held.watchGen === watchGen\n",
    "          && held.onFrame === undefined\n          && held.watchGen === watchGen\n",
    'temporary cleanup ownership',
)
controller.write_text(s)


tests = Path('src/browser/remote/controller.test.ts')
t = tests.read_text()
t = replace_once(
    t,
    "let cdpGate: Promise<void> | null = null;\n",
    "let cdpGate: Promise<void> | null = null;\n"
    "/** Make CDP session creation itself fail, before Page.startScreencast. */\n"
    "let cdpFailure: Error | null = null;\n",
    'cdp failure flag',
)
t = replace_once(
    t,
    "      if (cdpGate) await cdpGate;\n      if (cdpPerAttach) {\n",
    "      if (cdpGate) await cdpGate;\n      if (cdpFailure) throw cdpFailure;\n      if (cdpPerAttach) {\n",
    'fake newCDPSession failure',
)
t = replace_once(
    t,
    "  cdpGate = null;\n  pageContext = defaultContext;\n",
    "  cdpGate = null;\n  cdpFailure = null;\n  pageContext = defaultContext;\n",
    'reset cdp failure',
)

test_anchor = "  it('keeps a failed detached restore paused and retryable', async () => {\n"
new_tests = r"""  it('shares one CDP attachment when a watcher arrives during a detached restore', async () => {
    cdpPerAttach = true;
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const firstFrames: BrowserFrame[] = [];
    expect(await c.startWatching('run-A', (f) => firstFrames.push(f))).toBe(true);
    const first = cdpSessions[0]!;
    if (firstFrames.length === 0) {
      first.pushFrame(10);
      await Promise.resolve();
    }
    c.frameSeen('run-A', firstFrames.at(-1)!.generation);
    c.actorEnded('w1');
    expect(await c.takeOver('run-A')).toEqual({ ok: true });
    expect(await c.setCapture('run-A', false)).toBe(false);
    expect(c.handBack('run-A')).toBe(true);
    await c.stopWatching('run-A');
    expect(first.detached).toBe(true);

    const before = cdpCreated;
    const gate = deferred();
    cdpGate = gate.promise;
    const acting = c.controller(
      { kind: 'click', selector: '#after-hidden-unwatch' },
      ctx('run-A', 'w2'),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(cdpCreated, 'the agent started one physical restore attachment').toBe(before + 1);

    const watcherFrames: BrowserFrame[] = [];
    const watching = c.startWatching('run-A', (f) => watcherFrames.push(f));
    await new Promise((r) => setTimeout(r, 20));
    expect(cdpCreated, 'the arriving watcher joins that attachment instead of opening another').toBe(before + 1);

    gate.resolve();
    cdpGate = null;
    expect(await watching).toBe(true);
    expect((await acting).ok).toBe(true);

    const shared = cdpSessions.at(-1)!;
    expect(shared.detached, 'the watcher adopted the shared session').toBe(false);
    expect(watcherFrames.length, 'the real watcher, not a temporary sink, receives the restore frame').toBeGreaterThan(0);
    expect(cdpCreated, 'there was exactly one replacement CDP session').toBe(before + 1);
  }, 10_000);

  it('restores provider fallback state when CDP session creation itself fails', async () => {
    const { provider } = fakeProvider('https://provider.test/live/abc');
    const c = new RemoteBrowserController({ provider });
    const states: Array<{ human: boolean; capturing: boolean; confirmed: boolean }> = [];
    c.onControlFor('run-A', (state) => states.push(state));

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    expect(await c.startWatching('run-A', () => {})).toBe(true);
    await c.stopWatching('run-A');
    expect(states.at(-1)?.capturing, 'ordinary unwatch has no screencast').toBe(false);

    cdpFailure = new Error('CDP session unavailable');
    expect(await c.startWatching('run-A', () => {})).toBe(false);
    expect(states.at(-1)?.capturing,
      'transport failure is not advertised as a deliberate privacy pause').toBe(true);
  });

"""
if t.count(test_anchor) != 1:
    raise SystemExit(f'test insertion anchor: expected one, found {t.count(test_anchor)}')
t = t.replace(test_anchor, new_tests + test_anchor, 1)
tests.write_text(t)


web = Path('cloud/web/src/chat/BrowserLiveView.tsx')
w = web.read_text()
w = replace_once(
    w,
    "    e.currentTarget instanceof HTMLTextAreaElement && (e.currentTarget.value = '');\n    onInput?.({ kind: 'text', text });\n",
    "    e.currentTarget instanceof HTMLTextAreaElement && (e.currentTarget.value = '');\n"
    "    // Preserve gesture order: a sampled wheel delta happened before\n"
    "    // this discrete paste and must reach the remote FIFO first.\n"
    "    flushPendingScroll();\n"
    "    onInput?.({ kind: 'text', text });\n",
    'flush before paste',
)
w = replace_once(
    w,
    "    // A command must not leave editable residue in the sink.\n    e.currentTarget.value = '';\n    onInput?.({ kind: 'key', key: e.key });\n",
    "    // A command must not leave editable residue in the sink.\n"
    "    e.currentTarget.value = '';\n"
    "    flushPendingScroll();\n"
    "    onInput?.({ kind: 'key', key: e.key });\n",
    'flush before command key',
)
w = replace_once(
    w,
    "    const text = e.currentTarget.value;\n    if (!text) return;\n    e.currentTarget.value = '';\n    onInput?.({ kind: 'text', text });\n",
    "    const text = e.currentTarget.value;\n"
    "    if (!text) return;\n"
    "    e.currentTarget.value = '';\n"
    "    flushPendingScroll();\n"
    "    onInput?.({ kind: 'text', text });\n",
    'flush before committed text',
)
web.write_text(w)


webtests = Path('cloud/web/src/chat/BrowserLiveView.test.tsx')
wt = webtests.read_text()
web_anchor = "  it('flushes pending wheel distance before a later click', async () => {\n"
web_test = r"""  it('flushes pending wheel distance before later keyboard and text input', async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(Date, 'now');
    try {
      const onInput = vi.fn();
      render(<BrowserLiveView active liveViewUrl={undefined} frame={frame} human confirmed onStop={() => {}} onInput={onInput} />);
      const img = screen.getByRole('img') as HTMLImageElement;
      const keyboard = screen.getByLabelText(/type into the agent browser/i) as HTMLTextAreaElement;
      Object.defineProperty(img, 'naturalWidth', { value: 1280 });
      Object.defineProperty(img, 'naturalHeight', { value: 800 });
      img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

      const armPendingScroll = (base: number) => {
        now.mockReturnValue(base);
        fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 10, deltaMode: 0 });
        onInput.mockClear();
        now.mockReturnValue(base + 10);
        fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 20, deltaMode: 0 });
        expect(onInput).not.toHaveBeenCalled();
      };

      armPendingScroll(1_000);
      fireEvent.keyDown(keyboard, { key: 'Enter' });
      expect(onInput.mock.calls.map((c) => c[0]), 'scroll precedes the command key').toEqual([
        { kind: 'scroll', x: 0.5, y: 0.5, deltaY: 20 },
        { kind: 'key', key: 'Enter' },
      ]);

      onInput.mockClear();
      armPendingScroll(1_200);
      fireEvent.input(keyboard, { target: { value: 'hello' }, isComposing: false });
      expect(onInput.mock.calls.map((c) => c[0]), 'scroll precedes committed text').toEqual([
        { kind: 'scroll', x: 0.5, y: 0.5, deltaY: 20 },
        { kind: 'text', text: 'hello' },
      ]);

      onInput.mockClear();
      armPendingScroll(1_400);
      fireEvent.paste(keyboard, { clipboardData: { getData: () => 'secret' } });
      expect(onInput.mock.calls.map((c) => c[0]), 'scroll precedes pasted text').toEqual([
        { kind: 'scroll', x: 0.5, y: 0.5, deltaY: 20 },
        { kind: 'text', text: 'secret' },
      ]);

      await act(async () => { vi.advanceTimersByTime(SCROLL_INTERVAL); });
      expect(onInput, 'flushed timers do not replay scroll after the discrete input').toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

"""
if wt.count(web_anchor) != 1:
    raise SystemExit(f'web test insertion anchor: expected one, found {wt.count(web_anchor)}')
wt = wt.replace(web_anchor, web_test + web_anchor, 1)
webtests.write_text(wt)
