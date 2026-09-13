from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{label}: expected one match, found {n}")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# BrowserLease: allow a caller to bound an otherwise lossless FIFO.
# ---------------------------------------------------------------------------
p = Path('src/browser/lease.ts')
s = p.read_text()
old = """  async acquireActionSlot(\n    withinMs: number | null = ACTION_HANDOFF_MS,\n    countsAsHumanActivity = true,\n  ): Promise<symbol | null> {\n"""
new = """  async acquireActionSlot(\n    withinMs: number | null = ACTION_HANDOFF_MS,\n    countsAsHumanActivity = true,\n    maxQueued: number | null = null,\n  ): Promise<symbol | null> {\n"""
s = replace_once(s, old, new, 'action slot signature')
old = """    if (!this.action && this.actionQueue.length === 0) {\n      return this.beginAction(countsAsHumanActivity);\n    }\n    return await new Promise<symbol | null>((resolve) => {\n"""
new = """    if (!this.action && this.actionQueue.length === 0) {\n      return this.beginAction(countsAsHumanActivity);\n    }\n    // An unbounded WAIT does not have to mean an unbounded QUEUE. Discrete\n    // human input passes a finite maxQueued so already-accepted keys/clicks\n    // never age out, while a client that can produce events faster than a\n    // remote endpoint can drain them cannot retain promises/callbacks without\n    // limit. Lifecycle barriers deliberately pass no cap: dropping teardown is\n    // not an acceptable form of backpressure.\n    if (maxQueued !== null && this.actionQueue.length >= maxQueued) return null;\n    return await new Promise<symbol | null>((resolve) => {\n"""
s = replace_once(s, old, new, 'action queue cap')
old = """   * `null` as a RESULT means a bounded wait ran out. `null` as `withinMs` means\n   * this accepted operation is intentionally unbounded by time and will leave\n   * the queue only when its turn arrives. `countsAsHumanActivity=false` is for\n"""
new = """   * `null` as a RESULT means a bounded wait ran out OR a caller-supplied queue\n   * cap refused a new waiter. `null` as `withinMs` means an ACCEPTED operation\n   * is intentionally unbounded by time and will leave the queue only when its\n   * turn arrives; it does not require accepting infinitely many operations.\n   * `countsAsHumanActivity=false` is for\n"""
s = replace_once(s, old, new, 'action slot docs')
p.write_text(s)


# ---------------------------------------------------------------------------
# Remote controller: cap human-input backlog and follow newly opened pages.
# ---------------------------------------------------------------------------
p = Path('src/browser/remote/controller.ts')
s = p.read_text()

# Human input queue bound. Paste/IME text is already one event, so this is a
# generous burst while making memory use finite under a stalled CDP endpoint.
anchor = "const RESTORE_FRAME_MS = 2_000;\n"
s = replace_once(
    s,
    anchor,
    anchor + """/** Maximum accepted discrete human inputs waiting behind the active one. */\nconst MAX_HUMAN_INPUT_QUEUE = 64;\n""",
    'human input queue constant',
)

# Track which page a physical screencast/attach belongs to. This is necessary
# once a click can move the run to a popup while a watcher attach is in flight.
old = """  screencast?: CDPSession;\n  /**\n   * Watch and unwatch, applied in the order they were asked for.\n"""
new = """  screencast?: CDPSession;\n  /** The page `screencast` is physically attached to. */\n  screencastPage?: Page;\n  /**\n   * Watch and unwatch, applied in the order they were asked for.\n"""
s = replace_once(s, old, new, 'screencast page field')
old = """  attaching?: Promise<CDPSession | null>;\n  /**\n   * Where this run's frames go, held here rather than captured in the handler.\n"""
new = """  attaching?: Promise<CDPSession | null>;\n  /** The page the in-flight physical attachment was started for. */\n  attachingPage?: Page;\n  /**\n   * Where this run's frames go, held here rather than captured in the handler.\n"""
s = replace_once(s, old, new, 'attaching page field')

# Replace attach single-flight with page-aware form.
pattern = re.compile(r"  private async attachScreencast\(\n    runId: string,\n    held: RunBrowser,\n    onFrame\?: \(frame: BrowserFrame\) => void,\n  \): Promise<CDPSession \| null> \{.*?\n  \}\n\n  /\*\* Open one new CDP session and start the stream when it is safe to do so\. \*/", re.S)
replacement = """  private async attachScreencast(\n    runId: string,\n    held: RunBrowser,\n    onFrame?: (frame: BrowserFrame) => void,\n  ): Promise<CDPSession | null> {\n    if (onFrame) held.onFrame = onFrame;\n    if (held.screencast && held.screencastPage === held.page) return held.screencast;\n\n    // A popup can replace `held.page` while the old page is attaching. Never\n    // adopt that old session into the new target: wait it out, let the fresh\n    // attach notice it lost page identity, then retry against the page that is\n    // current NOW. This is deliberately narrower than `watchQueue`; the agent\n    // may hold the action slot while an unwatch in that queue waits for it.\n    const targetPage = held.page;\n    const existing = held.attaching;\n    if (existing) {\n      const existingPage = held.attachingPage;\n      await existing.catch(() => null);\n      if (held.page !== targetPage || existingPage !== targetPage) {\n        return this.attachScreencast(runId, held, onFrame);\n      }\n      const cdp = held.screencastPage === targetPage ? held.screencast ?? null : null;\n      if (cdp && onFrame) held.onFrame = onFrame;\n      return cdp;\n    }\n\n    // A stale completed stream can exist only across a page handoff. Dispose it\n    // before attaching the replacement; input has already finished and still\n    // owns the action slot when this path is used for a popup.\n    if (held.screencast && held.screencastPage !== targetPage) {\n      const stale = held.screencast;\n      held.screencast = undefined;\n      held.screencastPage = undefined;\n      await stale.send('Page.stopScreencast').catch(() => {});\n      await stale.detach().catch(() => {});\n    }\n\n    const attempt = this.attachScreencastFresh(runId, held, targetPage);\n    held.attaching = attempt;\n    held.attachingPage = targetPage;\n    try {\n      const cdp = await attempt;\n      if (cdp && onFrame) held.onFrame = onFrame;\n      return cdp;\n    } finally {\n      if (held.attaching === attempt) {\n        held.attaching = undefined;\n        held.attachingPage = undefined;\n      }\n    }\n  }\n\n  /** Open one new CDP session and start the stream when it is safe to do so. */"""
s, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit(f'attachScreencast replacement: {n}')

# Freeze the page identity for a fresh attachment.
s = replace_once(
    s,
    """  private async attachScreencastFresh(\n    runId: string,\n    held: RunBrowser,\n  ): Promise<CDPSession | null> {\n""",
    """  private async attachScreencastFresh(\n    runId: string,\n    held: RunBrowser,\n    targetPage: Page,\n  ): Promise<CDPSession | null> {\n""",
    'fresh attach signature',
)
s = replace_once(
    s,
    "cdp = await held.page.context().newCDPSession(held.page);",
    "cdp = await targetPage.context().newCDPSession(targetPage);",
    'fresh attach target page',
)
# Ignore frames from a page that was superseded while its attach completed.
s = replace_once(
    s,
    """      if (typeof e?.data === 'string') {\n        const width = e.metadata?.deviceWidth ?? 0;\n""",
    """      if (held.page === targetPage && typeof e?.data === 'string') {\n        const width = e.metadata?.deviceWidth ?? 0;\n""",
    'late old-page frame guard',
)
# If the target changed during session creation, do not start/keep a screencast
# on the superseded page.
s = replace_once(
    s,
    """    cdp.on('Page.screencastFrame', ((e: {\n""",
    """    if (held.page !== targetPage) {\n      await cdp.detach().catch(() => {});\n      return null;\n    }\n\n    cdp.on('Page.screencastFrame', ((e: {\n""",
    'pre-handler target guard',
)
s = replace_once(
    s,
    """    // Recorded BEFORE this promise resolves, so a stop that awaited the attach\n    // finds the session rather than racing the assignment.\n    held.screencast = cdp;\n""",
    """    // The page may have been replaced while startScreencast itself was\n    // pending. Never publish that now-stale physical session as the new page's\n    // viewer.\n    if (held.page !== targetPage) {\n      if (!paused) await cdp.send('Page.stopScreencast').catch(() => {});\n      await cdp.detach().catch(() => {});\n      return null;\n    }\n    // Recorded BEFORE this promise resolves, so a stop that awaited the attach\n    // finds the session rather than racing the assignment.\n    held.screencast = cdp;\n    held.screencastPage = targetPage;\n""",
    'post-start target guard',
)

# Clear page ownership everywhere a physical screencast is cleared.
s = replace_once(
    s,
    """      held.screencast = undefined;\n      held.capturing = false;\n      this.announceControl(runId);\n""",
    """      held.screencast = undefined;\n      held.screencastPage = undefined;\n      held.capturing = false;\n      this.announceControl(runId);\n""",
    'stopWatching screencast page clear',
)
s = replace_once(
    s,
    """    const watching = held.screencast;\n    held.screencast = undefined;\n    if (watching) {\n""",
    """    const watching = held.screencast;\n    held.screencast = undefined;\n    held.screencastPage = undefined;\n    if (watching) {\n""",
    'dispose screencast page clear',
)
s = replace_once(
    s,
    """          held.onFrame = undefined;\n          held.screencast = undefined;\n          // The privacy pause was ended by the successful restore.\n""",
    """          held.onFrame = undefined;\n          held.screencast = undefined;\n          held.screencastPage = undefined;\n          // The privacy pause was ended by the successful restore.\n""",
    'temporary capture screencast page clear',
)

# Navigation tracking is now reusable for a popup that becomes the run's page.
old_nav = """      page.on('framenavigated', ((frame: unknown) => {\n        if (frame !== page.mainFrame()) return;\n        held.generation += 1;\n      }) as never);\n      this.runs.set(runId, held);\n"""
new_nav = """      this.trackPageNavigation(held, page);\n      this.runs.set(runId, held);\n"""
s = replace_once(s, old_nav, new_nav, 'initial navigation listener')

# Insert page-follow helpers before perform().
anchor = """  private async perform(held: RunBrowser, action: BrowserAction, planned: number): Promise<BrowserActionOutcome> {\n"""
helpers = """  /** Count main-frame navigation only while this page is the run's active page. */\n  private trackPageNavigation(held: RunBrowser, page: Page): void {\n    page.on('framenavigated', ((frame: unknown) => {\n      if (held.page !== page || frame !== page.mainFrame()) return;\n      held.generation += 1;\n    }) as never);\n  }\n\n  /**\n   * Follow a page opened by the action that just finished.\n   *\n   * A popup/new tab is part of the same user gesture (OAuth is the common\n   * example). Keeping `held.page` and the screencast on its opener makes the\n   * new page both invisible and impossible to drive. This runs while the SAME\n   * action slot is still held, after the opening click/key has fully landed, so\n   * no later human/agent event can slip between detecting the popup and moving\n   * the view to it.\n   */\n  private async followOpenedPage(runId: string, held: RunBrowser, before: Set<Page>): Promise<void> {\n    if (this.runs.get(runId) !== held || held.abort.signal.aborted) return;\n    const candidates = held.page.context().pages().filter((p) => !p.isClosed() && !before.has(p));\n    const next = candidates.at(-1);\n    if (!next || next === held.page) return;\n\n    held.page = next;\n    held.generation += 1;\n    held.viewport = undefined;\n    held.metricsStale = true;\n    this.trackPageNavigation(held, next);\n\n    const deliver = held.onFrame;\n    if (deliver) {\n      // The old JPEG is about the opener. Invalidate it BEFORE any awaited\n      // detach/attach and give the popup its own watch generation, so neither a\n      // late old frame nor a late old receipt can authorise input into the new\n      // page. A fresh frame will clear visibilityUnconfirmed; the client's\n      // receipt separately opens Hide/blind input.\n      held.watchGen = (held.watchGen ?? 0) + 1;\n      held.visibilityUnconfirmed = true;\n      held.capturing = false;\n      this.announceControl(runId);\n      await this.attachScreencast(runId, held, deliver);\n      return;\n    }\n\n    // No viewer is mounted. A temporary/old physical stream is useless after\n    // the target moved, so make sure it cannot keep encoding the opener. Do not\n    // manufacture a privacy pause: without `hiddenByHolder`, provider fallback\n    // remains a valid supervision surface when somebody comes back later.\n    const pending = held.attaching;\n    if (pending) await pending.catch(() => null);\n    if (held.screencast && held.screencastPage !== next) {\n      const stale = held.screencast;\n      held.screencast = undefined;\n      held.screencastPage = undefined;\n      await stale.send('Page.stopScreencast').catch(() => {});\n      await stale.detach().catch(() => {});\n    }\n    held.visibilityUnconfirmed = false;\n    held.capturing = held.hiddenByHolder !== true;\n    this.announceControl(runId);\n  }\n\n  private async perform(runId: string, held: RunBrowser, action: BrowserAction, planned: number): Promise<BrowserActionOutcome> {\n"""
s = replace_once(s, anchor, helpers, 'follow popup helpers')

# Human input snapshots context pages and follows anything opened by that event.
s = replace_once(
    s,
    """      await this.dispatch(cdp, held, event);\n    } catch (err) {\n""",
    """      const pagesBefore = new Set(held.page.context().pages());\n      await this.dispatch(cdp, held, event);\n      await this.followOpenedPage(runId, held, pagesBefore);\n    } catch (err) {\n""",
    'human popup follow',
)

# Bound only the discrete human-input queue; sampled moves still never queue.
s = replace_once(
    s,
    """    const sampled = event.kind === 'move';\n    const token = sampled ? lease.tryActionSlot() : await lease.acquireActionSlot(null);\n""",
    """    const sampled = event.kind === 'move';\n    const token = sampled\n      ? lease.tryActionSlot()\n      : await lease.acquireActionSlot(null, true, MAX_HUMAN_INPUT_QUEUE);\n""",
    'bounded human input queue',
)
s = replace_once(
    s,
    """      return { ok: false, detail: 'The last thing you did is still finishing. Try again.' };\n""",
    """      return { ok: false, detail: 'Too many browser inputs are already waiting. Let the page catch up, then try again.' };\n""",
    'queue full refusal',
)
# Update stale comment claiming the queue itself is unbounded.
s = replace_once(
    s,
    """    // intentionally unbounded HERE: once a click, key or committed text event\n    // has been accepted into the FIFO, expiring it because earlier accepted\n    // input took two seconds would silently truncate what the person typed.\n    // Agent handoff/takeover waits remain bounded at their own call sites.\n""",
    """    // intentionally unbounded in TIME once accepted: expiring a click, key or\n    // committed text because earlier accepted input took two seconds silently\n    // truncates what the person typed. The NUMBER accepted is bounded instead,\n    // so a stalled endpoint cannot turn this FIFO into an unbounded memory\n    // queue. Agent handoff/takeover waits remain time-bounded at their call sites.\n""",
    'queue policy comment',
)

# Act passes runId to perform so a popup can migrate the run's view.
s = replace_once(s, "return await this.perform(held, action, planned);", "return await this.perform(runId, held, action, planned);", 'perform call')

# Make where() report whichever page is current after a popup handoff.
s = replace_once(
    s,
    """    const where = async (): Promise<{ url: string; title: string }> => ({\n      url: page.url(),\n      title: await page.title().catch(() => ''),\n    });\n""",
    """    const where = async (): Promise<{ url: string; title: string }> => {\n      const current = held.page;\n      return { url: current.url(), title: await current.title().catch(() => '') };\n    };\n""",
    'dynamic action outcome page',
)
# Agent click/press can also open OAuth/new-tab flows. Follow before returning.
s = replace_once(
    s,
    """      case 'click':\n        await stoppable(page.click(action.selector!, { timeout }));\n        return { ok: true, detail: `Clicked ${action.selector}`, ...(await where()) };\n""",
    """      case 'click': {\n        const pagesBefore = new Set(page.context().pages());\n        await stoppable(page.click(action.selector!, { timeout }));\n        await this.followOpenedPage(runId, held, pagesBefore);\n        return { ok: true, detail: `Clicked ${action.selector}`, ...(await where()) };\n      }\n""",
    'agent click popup follow',
)
s = replace_once(
    s,
    """      case 'press': {\n        // A selector focuses first; without one the key goes to whatever has\n        // focus, which is what \"press Escape\" usually means.\n        if (action.selector) await stoppable(page.press(action.selector, action.key!, { timeout }));\n        else await stoppable(page.keyboard.press(action.key!));\n        return { ok: true, detail: `Pressed ${action.key}`, ...(await where()) };\n      }\n""",
    """      case 'press': {\n        // A selector focuses first; without one the key goes to whatever has\n        // focus, which is what \"press Escape\" usually means.\n        const pagesBefore = new Set(page.context().pages());\n        if (action.selector) await stoppable(page.press(action.selector, action.key!, { timeout }));\n        else await stoppable(page.keyboard.press(action.key!));\n        await this.followOpenedPage(runId, held, pagesBefore);\n        return { ok: true, detail: `Pressed ${action.key}`, ...(await where()) };\n      }\n""",
    'agent press popup follow',
)
p.write_text(s)


# ---------------------------------------------------------------------------
# BrowserLiveView: a trailing scroll is an earlier user decision than handback.
# ---------------------------------------------------------------------------
p = Path('cloud/web/src/chat/BrowserLiveView.tsx')
s = p.read_text()
s = replace_once(
    s,
    '/** Flush sampled wheel distance before a later click. */',
    '/** Flush sampled wheel distance before a later discrete decision. */',
    'flush scroll comment',
)
old = """            onClick={() => (driving ? onHandBack?.() : onTakeOver?.())}\n"""
new = """            onClick={() => {\n              if (driving) {\n                // A wheel delta sampled before Give it back is still part of\n                // the person's gesture. Send it first; the server's action slot\n                // then makes handback wait until that scroll has actually\n                // landed instead of releasing ownership and refusing it later.\n                flushPendingScroll();\n                onHandBack?.();\n              } else {\n                onTakeOver?.();\n              }\n            }}\n"""
s = replace_once(s, old, new, 'handback scroll flush')
p.write_text(s)


# ---------------------------------------------------------------------------
# Tests: queue cap, popup adoption, and handback scroll ordering.
# ---------------------------------------------------------------------------
p = Path('src/browser/remote/controller.test.ts')
s = p.read_text()
# Make context page lists mutable so a test can model target=_blank/new Page.
old = """function fakeContext(pageForThisContext: typeof page) {\n  const c = {\n    closed: false,\n    pages: () => [pageForThisContext],\n"""
new = """function fakeContext(pageForThisContext: typeof page) {\n  const c = {\n    closed: false,\n    pageList: [pageForThisContext] as Array<typeof page>,\n    pages: () => c.pageList,\n"""
s = replace_once(s, old, new, 'mutable fake page list')
s = replace_once(
    s,
    """  defaultContext.closed = false;\n  createdContexts.length = 0;\n""",
    """  defaultContext.closed = false;\n  defaultContext.pageList = [page];\n  createdContexts.length = 0;\n""",
    'reset fake page list',
)

# Add regressions near takeover/input tests before the coordinate click test.
anchor = """  it('places a click on the page it was clicked on', async () => {\n"""
tests = r"""  it('bounds accepted human input without expiring the inputs already in line', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    const blocked = deferred();
    const entered = deferred();
    const good = cdp.send;
    let first = true;
    cdp.send = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.insertText' && first) {
        first = false;
        entered.resolve();
        await blocked.promise;
      }
      return good.call(cdp, method, params);
    };

    const head = c.input('run-A', { kind: 'text', text: '0' });
    await entered.promise;
    // 64 may wait losslessly; anything beyond the finite admission bound is
    // refused immediately rather than retaining promises forever behind a
    // stalled endpoint.
    const tail = Array.from({ length: 70 }, (_, i) =>
      c.input('run-A', { kind: 'text', text: String((i + 1) % 10) }));
    const overflow = await Promise.race([
      tail.at(-1)!,
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 100)),
    ]);
    expect(overflow, 'queue overflow is refused rather than retained').not.toBe('hung');
    expect((overflow as { ok: boolean }).ok).toBe(false);
    expect((overflow as { detail?: string }).detail).toMatch(/too many browser inputs/i);

    blocked.resolve();
    const results = await Promise.all([head, ...tail]);
    expect(results.filter((r) => r.ok), 'active input plus the 64 admitted waiters all drain').toHaveLength(65);
    expect(results.filter((r) => !r.ok), 'only overflow is refused').toHaveLength(6);
    cdp.send = good;
  });

  it('moves control and the screencast to a page opened by the human click', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    cdpPerAttach = true;
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    const openerCdp = cdp;
    const popup = {
      ...page,
      closed: false,
      currentUrl: 'https://login.test/popup',
      navHandlers: [] as Array<(frame: unknown) => void>,
      calls: [] as string[],
      closeCount: 0,
      keyboard: { press: async (k: string) => { popup.calls.push(`key:${k}`); } },
      context() { return pageContext; },
    };
    const send = openerCdp.send;
    let opened = false;
    openerCdp.send = async (method: string, params?: Record<string, unknown>) => {
      const out = await send.call(openerCdp, method, params);
      if (!opened && method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseReleased') {
        opened = true;
        defaultContext.pageList.push(popup as typeof page);
      }
      return out;
    };

    expect((await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 })).ok).toBe(true);
    expect(openerCdp.detached, 'the opener stream is no longer the controlled view').toBe(true);
    expect(cdp, 'a new physical stream was attached to the popup').not.toBe(openerCdp);

    // The hold stays with the person, and subsequent human CDP input goes to
    // the replacement session rather than the opener.
    expect(c.humanHolds('run-A')).toBe(true);
    expect((await c.input('run-A', { kind: 'text', text: 'otp' })).ok).toBe(true);
    expect(cdp.calls.filter((x) => x.method === 'Input.insertText').map((x) => x.params?.['text']))
      .toContain('otp');
    expect(openerCdp.calls.filter((x) => x.method === 'Input.insertText').map((x) => x.params?.['text']))
      .not.toContain('otp');

    // And once control is returned, the agent works on that same popup.
    expect(c.handBack('run-A')).toBe(true);
    const agent = await c.controller({ kind: 'click', selector: '#continue' }, ctx('run-A', 'w2'));
    expect(agent.ok).toBe(true);
    expect(popup.calls).toContain('click:#continue');
    expect(page.calls).not.toContain('click:#continue');
  });

""" + anchor
s = replace_once(s, anchor, tests, 'controller round31 regressions')
p.write_text(s)

p = Path('cloud/web/src/chat/BrowserLiveView.test.tsx')
s = p.read_text()
# Insert near other trailing-input lifecycle tests.
anchor = """  it('does not send a held-back move after the page is handed back', async () => {\n"""
test = r"""  it('flushes wheel distance before giving the browser back', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const onInput = vi.fn(() => { order.push('scroll'); });
      const onHandBack = vi.fn(() => { order.push('handback'); });
      render(
        <BrowserLiveView active liveViewUrl={undefined} frame={frame} human confirmed
          onStop={() => {}} onInput={onInput} onHandBack={onHandBack} />,
      );
      const img = screen.getByRole('img') as HTMLImageElement;
      Object.defineProperty(img, 'naturalWidth', { value: 1280 });
      Object.defineProperty(img, 'naturalHeight', { value: 800 });
      img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;

      // First sample goes immediately; the second is waiting in the 60 ms
      // accumulator when Give it back is pressed.
      fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 10, deltaMode: 0 });
      onInput.mockClear();
      order.length = 0;
      fireEvent.wheel(img, { clientX: 200, clientY: 200, deltaY: 25, deltaMode: 0 });
      expect(onInput).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /give it back/i }));
      expect(order, 'the earlier wheel decision reaches the FIFO before handback').toEqual(['scroll', 'handback']);
      expect(onInput).toHaveBeenCalledWith({ kind: 'scroll', x: 0.5, y: 0.5, deltaY: 25 });
      expect(onHandBack).toHaveBeenCalledOnce();

      await act(async () => { vi.advanceTimersByTime(SCROLL_INTERVAL * 2); });
      expect(onInput, 'the cancelled timer does not send the distance twice').toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

""" + anchor
s = replace_once(s, anchor, test, 'handback scroll regression')
p.write_text(s)
