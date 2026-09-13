from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

controller_path = Path('src/browser/remote/controller.ts')
controller = controller_path.read_text()

controller = replace_once(
    controller,
    """/** Maximum accepted discrete human inputs waiting behind the active one. */\nconst MAX_HUMAN_INPUT_QUEUE = 64;\n""",
    """/** Maximum accepted discrete human inputs waiting behind the active one. */\nconst MAX_HUMAN_INPUT_QUEUE = 64;\n/**\n * Hide/Show are lossless human decisions once accepted, but admission still\n * has to be finite when a CDP endpoint is wedged. The state transition itself\n * is tiny, so sixteen outstanding decisions is already far beyond ordinary UI\n * use while keeping a hostile/stuck client from retaining unbounded waiters.\n */\nconst MAX_CAPTURE_TRANSITION_QUEUE = 16;\n/**\n * Watch lifecycle requests are ordered, but a broken attach/detach must not\n * turn that ordering promise into an unbounded promise chain. Past this bound\n * pending requests collapse to the newest desired lifecycle operation.\n */\nconst MAX_WATCH_LIFECYCLE_QUEUE = 16;\n""",
    'queue constants',
)

controller = replace_once(
    controller,
    """  watchQueue?: Promise<unknown>;\n""",
    """  watchQueue?: Promise<unknown>;\n  /** Number of ordinary lifecycle turns retained in `watchQueue`. */\n  watchQueueDepth?: number;\n  /**\n   * Once the lifecycle queue is full, only the newest pending operation is\n   * retained. Every overflow caller shares `watchCollapsedPromise`, so a flood\n   * cannot retain one closure/promise chain node per watch/unwatch request.\n   */\n  watchCollapsed?: () => Promise<unknown>;\n  watchCollapsedPromise?: Promise<unknown>;\n  /**\n   * Identity of the newest watch/unwatch REQUEST, distinct from `watchGen`\n   * (which identifies a viewer that actually began). An unwatch increments\n   * this synchronously so an in-flight popup attachment cannot resurrect the\n   * callback after the panel has already gone away.\n   */\n  watchIntentGen?: number;\n""",
    'watch fields',
)

controller = replace_once(
    controller,
    """    const held = this.runs.get(runId);\n    if (!held) return false;\n    // Queued rather than refused. The check for \"already watching\" happens\n""",
    """    const held = this.runs.get(runId);\n    if (!held) return false;\n    // Assigned when REQUESTED, not when this queued turn eventually runs. A\n    // later unwatch therefore invalidates an attachment already in flight even\n    // though the physical lifecycle operations still execute in their original\n    // order. `watchGen` remains the identity of a viewer that actually begins.\n    const watchIntent = (held.watchIntentGen ?? 0) + 1;\n    held.watchIntentGen = watchIntent;\n    // Queued rather than refused. The check for \"already watching\" happens\n""",
    'start watching intent',
)

controller = replace_once(
    controller,
    """      held.onFrame = onFrame;\n      // A NEW watcher has been shown nothing, whatever the last one saw. This\n""",
    """      // Do not resurrect a consumer already superseded by an unwatch or a\n      // newer watch request. The physical turn still runs in order; only the\n      // stale recipient is withheld.\n      if (held.watchIntentGen === watchIntent) held.onFrame = onFrame;\n      // A NEW watcher has been shown nothing, whatever the last one saw. This\n""",
    'start watcher callback',
)

controller = replace_once(
    controller,
    """      const attached = await this.attachScreencast(runId, held, onFrame);\n      // A failed watch must not leave a dead consumer installed. A real\n      // watcher that replaced this one meanwhile owns the callback now.\n      if (!attached && held.onFrame === onFrame) held.onFrame = undefined;\n""",
    """      const attached = await this.attachScreencast(runId, held, onFrame, watchIntent);\n      // A failed watch must not leave a dead consumer installed. A real\n      // watcher that replaced this one meanwhile owns the callback now.\n      if (!attached && held.watchIntentGen === watchIntent && held.onFrame === onFrame) {\n        held.onFrame = undefined;\n      }\n""",
    'start attach intent',
)

old_queue = """  private queueWatch<T>(held: RunBrowser, op: () => Promise<T>): Promise<T> {\n    const mine = (held.watchQueue ?? Promise.resolve()).then(op, op);\n    held.watchQueue = mine.catch(() => {});\n    return mine;\n  }\n"""
new_queue = """  private queueWatch<T>(held: RunBrowser, op: () => Promise<T>): Promise<T> {\n    const depth = held.watchQueueDepth ?? 0;\n\n    // Keep at most one overflow operation: the newest desired lifecycle state.\n    // This is deliberately a collapse rather than a timeout. A slow attach may\n    // take as long as it takes, but a client toggling watch/unwatch thousands of\n    // times while it does so retains one closure, not thousands, and the LAST\n    // request still gets a real turn after the bounded prefix drains.\n    if (held.watchCollapsedPromise || depth >= MAX_WATCH_LIFECYCLE_QUEUE) {\n      held.watchCollapsed = op as () => Promise<unknown>;\n      if (!held.watchCollapsedPromise) {\n        const drain = async (): Promise<unknown> => {\n          let result: unknown;\n          while (held.watchCollapsed) {\n            const latest = held.watchCollapsed;\n            held.watchCollapsed = undefined;\n            try { result = await latest(); } catch { /* lifecycle chain stays usable */ }\n          }\n          return result;\n        };\n        const tail = (held.watchQueue ?? Promise.resolve()).then(drain, drain);\n        let tracked: Promise<unknown>;\n        tracked = tail.finally(() => {\n          if (held.watchCollapsedPromise === tracked) {\n            held.watchCollapsedPromise = undefined;\n            held.watchCollapsed = undefined;\n          }\n        });\n        held.watchCollapsedPromise = tracked;\n        held.watchQueue = tracked.catch(() => {});\n      }\n      // All overflow callers share the SAME promise. Its result is the newest\n      // operation that actually survives coalescing, which is the only state\n      // that matters once requests have exceeded the admission bound.\n      return held.watchCollapsedPromise as Promise<T>;\n    }\n\n    held.watchQueueDepth = depth + 1;\n    const mine = (held.watchQueue ?? Promise.resolve()).then(op, op);\n    const counted = mine.finally(() => {\n      held.watchQueueDepth = Math.max(0, (held.watchQueueDepth ?? 1) - 1);\n    });\n    held.watchQueue = counted.catch(() => {});\n    return counted;\n  }\n"""
controller = replace_once(controller, old_queue, new_queue, 'bounded watch queue')

controller = replace_once(
    controller,
    """  private async attachScreencast(\n    runId: string,\n    held: RunBrowser,\n    onFrame?: (frame: BrowserFrame) => void,\n  ): Promise<CDPSession | null> {\n    if (onFrame) held.onFrame = onFrame;\n""",
    """  private async attachScreencast(\n    runId: string,\n    held: RunBrowser,\n    onFrame?: (frame: BrowserFrame) => void,\n    expectedWatchIntent = held.watchIntentGen,\n  ): Promise<CDPSession | null> {\n    const consumerIntent = onFrame ? expectedWatchIntent : undefined;\n    if (onFrame && held.watchIntentGen === consumerIntent) held.onFrame = onFrame;\n""",
    'attach signature',
)

controller = replace_once(
    controller,
    """        return this.attachScreencast(runId, held, onFrame);\n""",
    """        return this.attachScreencast(runId, held, onFrame, expectedWatchIntent);\n""",
    'attach recursive intent',
)

controller = replace_once(
    controller,
    """      const cdp = held.screencastPage === targetPage ? held.screencast ?? null : null;\n      if (cdp && onFrame) held.onFrame = onFrame;\n      return cdp;\n""",
    """      const cdp = held.screencastPage === targetPage ? held.screencast ?? null : null;\n      if (consumerIntent !== undefined && held.watchIntentGen !== consumerIntent) return null;\n      if (cdp && onFrame) held.onFrame = onFrame;\n      return cdp;\n""",
    'attach existing intent',
)

controller = replace_once(
    controller,
    """    const attempt = this.attachScreencastFresh(runId, held, targetPage);\n""",
    """    const attempt = this.attachScreencastFresh(runId, held, targetPage, consumerIntent);\n""",
    'fresh attach intent',
)

controller = replace_once(
    controller,
    """      const cdp = await attempt;\n      if (cdp && onFrame) held.onFrame = onFrame;\n      return cdp;\n""",
    """      const cdp = await attempt;\n      if (consumerIntent !== undefined && held.watchIntentGen !== consumerIntent) return null;\n      if (cdp && onFrame) held.onFrame = onFrame;\n      return cdp;\n""",
    'attach completion intent',
)

controller = replace_once(
    controller,
    """  private async attachScreencastFresh(\n    runId: string,\n    held: RunBrowser,\n    targetPage: Page,\n  ): Promise<CDPSession | null> {\n""",
    """  private async attachScreencastFresh(\n    runId: string,\n    held: RunBrowser,\n    targetPage: Page,\n    consumerIntent?: number,\n  ): Promise<CDPSession | null> {\n""",
    'fresh signature',
)

controller = replace_once(
    controller,
    """    // Recorded BEFORE this promise resolves, so a stop that awaited the attach\n    // finds the session rather than racing the assignment.\n    held.screencast = cdp;\n""",
    """    // An unwatch invalidates its consumer synchronously, even when this attach\n    // belongs to a popup handoff outside `watchQueue`. Never publish a physical\n    // stream whose viewer disappeared while newCDPSession/startScreencast was\n    // awaited; otherwise stopWatching can return with no session and this older\n    // continuation can resurrect both the stream and its callback afterwards.\n    if (consumerIntent !== undefined && held.watchIntentGen !== consumerIntent) {\n      if (!paused) await cdp.send('Page.stopScreencast').catch(() => {});\n      await cdp.detach().catch(() => {});\n      return null;\n    }\n    // Recorded BEFORE this promise resolves, so a stop that awaited the attach\n    // finds the session rather than racing the assignment.\n    held.screencast = cdp;\n""",
    'fresh publish guard',
)

controller = replace_once(
    controller,
    """  async stopWatching(runId: string): Promise<void> {\n    const held = this.runs.get(runId);\n    if (!held) return;\n    await this.queueWatch(held, async () => {\n      const cdp = held.screencast;\n      // Invalidate the view immediately. Queued human events must fail\n      // their post-wait identity check rather than land in a departed view.\n      held.onFrame = undefined;\n""",
    """  async stopWatching(runId: string): Promise<void> {\n    const held = this.runs.get(runId);\n    if (!held) return;\n    // REQUEST-TIME invalidation is intentional. Popup handoff attachment is not\n    // on `watchQueue` (putting it there can deadlock against the action slot),\n    // so an unwatch must make that in-flight consumer stale before this method\n    // waits for its own lifecycle turn. The attach path checks this generation\n    // before publishing and tears its just-created session back down.\n    held.watchIntentGen = (held.watchIntentGen ?? 0) + 1;\n    held.onFrame = undefined;\n    await this.queueWatch(held, async () => {\n      const cdp = held.screencast;\n      // Invalidate the view immediately. Queued human events must fail\n      // their post-wait identity check rather than land in a departed view.\n      held.onFrame = undefined;\n""",
    'unwatch intent invalidation',
)

controller = replace_once(
    controller,
    """    const token = await lease.acquireActionSlot(null);\n""",
    """    const token = await lease.acquireActionSlot(null, true, MAX_CAPTURE_TRANSITION_QUEUE);\n""",
    'capture queue bound',
)

controller = replace_once(
    controller,
    """    if (!held || held.page.isClosed()) return { ok: false, detail: 'This run has no browser open.' };\n    // No CDP session means nobody is watching, and input you cannot see the\n""",
    """    if (!held || held.page.isClosed()) return { ok: false, detail: 'This run has no browser open.' };\n    // A queued event is an instruction for THIS document, not for whatever a\n    // previous accepted event navigates to while it waits in the FIFO. Watch\n    // identity alone cannot see that change: main-frame navigation deliberately\n    // keeps the same screencast/session and only bumps `generation`.\n    const page = held.page;\n    const pageGeneration = held.generation;\n    // No CDP session means nobody is watching, and input you cannot see the\n""",
    'input generation snapshot',
)

controller = replace_once(
    controller,
    """      if (!lease.heldByHuman) {\n        return { ok: false, detail: 'Your control of this browser ended while that was waiting.' };\n      }\n      if (held.screencast !== cdp || held.watchGen !== watch) {\n""",
    """      if (!lease.heldByHuman) {\n        return { ok: false, detail: 'Your control of this browser ended while that was waiting.' };\n      }\n      if (held.page !== page || held.generation !== pageGeneration) {\n        return { ok: false, detail: 'The page changed while that input was waiting, so it did not land.' };\n      }\n      if (held.screencast !== cdp || held.watchGen !== watch) {\n""",
    'input generation recheck',
)

old_follow = """  private async followOpenedPage(runId: string, held: RunBrowser, before: Set<Page>): Promise<void> {\n    if (this.runs.get(runId) !== held || held.abort.signal.aborted) return;\n    const candidates = held.page.context().pages().filter((p) => !p.isClosed() && !before.has(p));\n    const next = candidates.at(-1);\n    if (!next || next === held.page) return;\n\n    held.page = next;\n    held.generation += 1;\n    held.viewport = undefined;\n    held.metricsStale = true;\n    this.trackPageNavigation(held, next);\n\n    const deliver = held.onFrame;\n    if (deliver) {\n      // The old JPEG is about the opener. Invalidate it BEFORE any awaited\n      // detach/attach and give the popup its own watch generation, so neither a\n      // late old frame nor a late old receipt can authorise input into the new\n      // page. A fresh frame will clear visibilityUnconfirmed; the client's\n      // receipt separately opens Hide/blind input.\n      held.watchGen = (held.watchGen ?? 0) + 1;\n      held.visibilityUnconfirmed = true;\n      held.capturing = false;\n      this.announceControl(runId);\n      await this.attachScreencast(runId, held, deliver);\n      return;\n    }\n\n    // No viewer is mounted. A temporary/old physical stream is useless after\n    // the target moved, so make sure it cannot keep encoding the opener. Do not\n    // manufacture a privacy pause: without `hiddenByHolder`, provider fallback\n    // remains a valid supervision surface when somebody comes back later.\n    const pending = held.attaching;\n    if (pending) await pending.catch(() => null);\n    if (held.screencast && held.screencastPage !== next) {\n      const stale = held.screencast;\n      held.screencast = undefined;\n      held.screencastPage = undefined;\n      await stale.send('Page.stopScreencast').catch(() => {});\n      await stale.detach().catch(() => {});\n    }\n    held.visibilityUnconfirmed = false;\n    held.capturing = held.hiddenByHolder !== true;\n    this.announceControl(runId);\n  }\n"""
new_follow = """  private async followOpenedPage(runId: string, held: RunBrowser, before: Set<Page>): Promise<void> {\n    if (this.runs.get(runId) !== held || held.abort.signal.aborted) return;\n    const candidates = held.page.context().pages().filter((p) => !p.isClosed() && !before.has(p));\n    const next = candidates.at(-1);\n    if (!next || next === held.page) return;\n    await this.adoptPage(runId, held, next);\n  }\n\n  /**\n   * Make one live page the run's controlled/viewed page. Used in both\n   * directions: into a popup opened by an action, and back to another surviving\n   * page when that popup closes itself after OAuth/login completion.\n   */\n  private async adoptPage(runId: string, held: RunBrowser, next: Page): Promise<void> {\n    if (next === held.page || next.isClosed()) return;\n\n    held.page = next;\n    held.generation += 1;\n    held.viewport = undefined;\n    held.metricsStale = true;\n    this.trackPageNavigation(held, next);\n\n    const deliver = held.onFrame;\n    if (deliver) {\n      // The old JPEG is about the previous page. Invalidate it BEFORE any\n      // awaited detach/attach and give the replacement its own watch generation,\n      // so neither a late old frame nor a late old receipt can authorise input.\n      held.watchGen = (held.watchGen ?? 0) + 1;\n      held.visibilityUnconfirmed = true;\n      held.capturing = false;\n      this.announceControl(runId);\n      await this.attachScreencast(runId, held, deliver);\n      return;\n    }\n\n    // No viewer is mounted. A temporary/old physical stream is useless after\n    // the target moved, so make sure it cannot keep encoding the previous page.\n    // Do not manufacture a privacy pause: without `hiddenByHolder`, provider\n    // fallback remains a valid supervision surface when somebody returns.\n    const pending = held.attaching;\n    if (pending) await pending.catch(() => null);\n    if (held.screencast && held.screencastPage !== next) {\n      const stale = held.screencast;\n      held.screencast = undefined;\n      held.screencastPage = undefined;\n      await stale.send('Page.stopScreencast').catch(() => {});\n      await stale.detach().catch(() => {});\n    }\n    held.visibilityUnconfirmed = false;\n    held.capturing = held.hiddenByHolder !== true;\n    this.announceControl(runId);\n  }\n"""
controller = replace_once(controller, old_follow, new_follow, 'page adoption helper')

controller = replace_once(
    controller,
    """    const existing = this.runs.get(runId);\n    if (existing && !existing.page.isClosed()) return existing;\n    if (existing) {\n""",
    """    const existing = this.runs.get(runId);\n    if (existing && !existing.page.isClosed()) return existing;\n    if (existing && existing.page.isClosed()) {\n      // A followed popup commonly closes itself after OAuth/login succeeds. The\n      // session is not stale just because that one page is: the opener (or\n      // another tab in this run's isolated context) may still be live and now\n      // contains the authenticated state. Prefer it over tearing down the whole\n      // provider session and losing the flow.\n      const fallback = existing.page.context().pages().filter((p) => !p.isClosed()).at(-1);\n      if (fallback) {\n        await this.adoptPage(runId, existing, fallback);\n        return existing;\n      }\n    }\n    if (existing) {\n""",
    'closed popup fallback',
)

controller_path.write_text(controller)

# Client: preserve gesture order when Hide follows a sampled wheel.
view_path = Path('cloud/web/src/chat/BrowserLiveView.tsx')
view = view_path.read_text()
view = replace_once(
    view,
    """            onClick={() => onCapture?.(capturing === false)}\n""",
    """            onClick={() => {\n              // Hide is a discrete decision just like a click/key/handback. A\n              // sampled wheel that happened first must reach the remote FIFO\n              // first; otherwise the timer scrolls the now-hidden page after\n              // the person's last visible picture.\n              if (capturing !== false) flushPendingScroll();\n              onCapture?.(capturing === false);\n            }}\n""",
    'flush scroll before hide',
)
view_path.write_text(view)

# BrowserLiveView regression for wheel -> Hide ordering.
view_test_path = Path('cloud/web/src/chat/BrowserLiveView.test.tsx')
view_test = view_test_path.read_text()
view_marker = """  it('does not send a held-back move after the page is handed back', async () => {\n"""
view_add = """  it('flushes wheel distance before hiding the page', async () => {\n    vi.useFakeTimers();\n    try {\n      const order: string[] = [];\n      const onInput = vi.fn(() => { order.push('scroll'); });\n      const onCapture = vi.fn(() => { order.push('hide'); });\n      render(\n        <BrowserLiveView active liveViewUrl={undefined} frame={frame} human confirmed\n          onStop={() => {}} onInput={onInput} onCapture={onCapture} />,\n      );\n      const img = screen.getByRole('img') as HTMLImageElement;\n      Object.defineProperty(img, 'naturalWidth', { value: 1280 });\n      Object.defineProperty(img, 'naturalHeight', { value: 800 });\n      img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;\n\n      fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 10, deltaMode: 0 });\n      onInput.mockClear();\n      order.length = 0;\n      fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 25, deltaMode: 0 });\n      expect(onInput).not.toHaveBeenCalled();\n\n      fireEvent.click(screen.getByRole('button', { name: /hide the page/i }));\n      expect(order, 'the earlier wheel reaches the remote FIFO before capture stops').toEqual(['scroll', 'hide']);\n      expect(onInput).toHaveBeenCalledWith({ kind: 'scroll', x: 0.5, y: 0.5, deltaY: 25 });\n      expect(onCapture).toHaveBeenCalledWith(false);\n\n      await act(async () => { vi.advanceTimersByTime(SCROLL_INTERVAL * 2); });\n      expect(onInput, 'the flushed distance is not sent again while hidden').toHaveBeenCalledOnce();\n    } finally {\n      vi.useRealTimers();\n    }\n  });\n\n"""
view_test = replace_once(view_test, view_marker, view_add + view_marker, 'BrowserLiveView hide ordering test')
view_test_path.write_text(view_test)

# Controller regressions. Appended as a focused review block so they use the
# same faithful fake harness as the rest of this file.
controller_test_path = Path('src/browser/remote/controller.test.ts')
controller_test = controller_test_path.read_text()
controller_test += r'''

describe('round 33 review regressions', () => {
  async function openWatchedHuman(c: InstanceType<typeof RemoteBrowserController>, runId: string) {
    await c.controller({ kind: 'click', selector: '#open' }, ctx(runId, 'worker-r33'));
    const frames: BrowserFrame[] = [];
    await c.startWatching(runId, (f) => frames.push(f));
    await Promise.resolve();
    if (!frames.length) cdp.pushFrame(3301);
    if (!frames.length) throw new Error('watch produced no frame');
    c.frameSeen(runId, frames.at(-1)!.generation);
    c.actorEnded('worker-r33');
    expect((await c.takeOver(runId)).ok).toBe(true);
  }

  function popupPage(url = 'https://popup.test/') {
    const popup = {
      ...page,
      closed: false,
      currentUrl: url,
      navHandlers: [] as Array<(frame: unknown) => void>,
      calls: [] as string[],
      closeCount: 0,
      keyboard: { press: async (k: string) => { popup.calls.push(`key:${k}`); } },
      context() { return pageContext; },
    } as typeof page;
    return popup;
  }

  it('bounds accepted Hide transitions behind a stalled human input', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await openWatchedHuman(c, 'run-cap-bound');

    const gate = deferred();
    const realSend = cdp.send;
    let blocked = false;
    cdp.send = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.insertText' && !blocked) {
        blocked = true;
        await gate.promise;
      }
      return realSend.call(cdp, method, params);
    };

    const active = c.input('run-cap-bound', { kind: 'text', text: 'hold' });
    while (!blocked) await Promise.resolve();
    let settled = 0;
    const hides = Array.from({ length: 40 }, () => c.setCapture('run-cap-bound', false)
      .then((value) => { settled += 1; return value; }));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled, 'overflow Hide requests are refused immediately instead of retaining waiters').toBeGreaterThan(0);
    expect(settled, 'the bounded prefix is still waiting for the action slot').toBeLessThan(40);

    gate.resolve();
    await active;
    await Promise.all(hides);
    cdp.send = realSend;
  });

  it('bounds a stalled watch lifecycle and still applies the newest overflow request', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#open' }, ctx('run-watch-bound', 'worker'));

    cdpPerAttach = true;
    const gate = deferred();
    cdpGate = gate.promise;
    const requests: Array<Promise<unknown>> = [];
    requests.push(c.startWatching('run-watch-bound', () => {}));
    // Far more than the retained prefix. End on WATCH so final-state semantics
    // are observable even though the middle of the flood is coalesced.
    for (let i = 0; i < 40; i++) {
      requests.push(i % 2 === 0
        ? c.stopWatching('run-watch-bound')
        : c.startWatching('run-watch-bound', () => {}));
    }
    requests.push(c.startWatching('run-watch-bound', () => {}));

    gate.resolve();
    await Promise.all(requests);
    expect(cdpCreated, 'the lifecycle flood is bounded instead of replayed in full').toBeLessThan(30);
    const driven = await c.takeOver('run-watch-bound');
    expect(driven.ok, 'the newest watch request really became the final state').toBe(true);
    expect((await c.input('run-watch-bound', { kind: 'text', text: 'still-visible' })).ok).toBe(true);
  });

  it('refuses queued input when an earlier accepted event navigated the main frame', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await openWatchedHuman(c, 'run-nav-input');

    const gate = deferred();
    const realSend = cdp.send;
    let first = true;
    cdp.send = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.insertText' && first) {
        first = false;
        await gate.promise;
        page.currentUrl = 'https://destination.test/';
        page.navHandlers.forEach((h) => h(MAIN_FRAME));
      }
      return realSend.call(cdp, method, params);
    };

    const one = c.input('run-nav-input', { kind: 'text', text: 'first' });
    await Promise.resolve();
    const two = c.input('run-nav-input', { kind: 'text', text: 'second' });
    await Promise.resolve();
    gate.resolve();
    expect((await one).ok).toBe(true);
    const refused = await two;
    expect(refused.ok, 'input aimed at the old document does not land in the destination').toBe(false);
    expect(refused.detail).toMatch(/page changed/i);
    expect(cdp.calls.filter((x) => x.method === 'Input.insertText')).toHaveLength(1);
    cdp.send = realSend;
  });

  it('does not let an in-flight popup attachment resurrect a watcher after unwatch', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    cdpPerAttach = true;
    await openWatchedHuman(c, 'run-popup-unwatch');
    const openerCdp = cdp;
    const popup = popupPage();
    const frames = vi.fn();
    await c.startWatching('run-popup-unwatch', frames);
    await Promise.resolve();
    frames.mockClear();

    const attachGate = deferred();
    cdpGate = attachGate.promise;
    const realSend = openerCdp.send;
    openerCdp.send = async (method: string, params?: Record<string, unknown>) => {
      const out = await realSend.call(openerCdp, method, params);
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseReleased') {
        pageContext.pageList = [page, popup];
      }
      return out;
    };

    const clicking = c.input('run-popup-unwatch', { kind: 'click', x: 0.5, y: 0.5 });
    for (let i = 0; i < 20 && cdpCreated < 3; i++) await Promise.resolve();
    const unwatching = c.stopWatching('run-popup-unwatch');
    await unwatching;
    attachGate.resolve();
    await clicking;

    const popupCdp = cdpSessions.at(-1)!;
    expect(popupCdp.detached, 'the attachment invalidated by unwatch is torn back down').toBe(true);
    popupCdp.pushFrame(3302, 'LATE-POPUP');
    expect(frames, 'no old callback is resurrected after the panel left').not.toHaveBeenCalled();
    openerCdp.send = realSend;
  });

  it('falls back to a surviving page when a followed popup closes itself', async () => {
    const { provider, created, ended } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    cdpPerAttach = true;
    await openWatchedHuman(c, 'run-popup-close');
    const openerCdp = cdp;
    const popup = popupPage('https://login.test/');
    pageContext.pageList = [page];

    const realSend = openerCdp.send;
    openerCdp.send = async (method: string, params?: Record<string, unknown>) => {
      const out = await realSend.call(openerCdp, method, params);
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseReleased') {
        pageContext.pageList = [page, popup];
      }
      return out;
    };
    expect((await c.input('run-popup-close', { kind: 'click', x: 0.5, y: 0.5 })).ok).toBe(true);
    expect(c.handBack('run-popup-close')).toBe(true);

    popup.closed = true;
    pageContext.pageList = [page, popup];
    const result = await c.controller({ kind: 'click', selector: '#after-login' }, ctx('run-popup-close', 'worker-after'));
    expect(result.ok, 'the surviving opener is usable').toBe(true);
    expect(page.calls).toContain('click:#after-login');
    expect(popup.calls).not.toContain('click:#after-login');
    expect(created, 'closing a popup does not allocate a replacement provider session').toEqual(['sess-1']);
    expect(ended, 'nor throw away the authenticated session').toEqual([]);
    openerCdp.send = realSend;
  });
});
'''
controller_test_path.write_text(controller_test)
