from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def sub_once(text: str, pattern: str, repl: str, label: str) -> str:
    out, count = re.subn(pattern, repl, text, count=1, flags=re.S | re.M)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return out


# ---------------------------------------------------------------------------
# controller.ts: teardown deadlock + safe editing shortcuts
# ---------------------------------------------------------------------------
p = Path('src/browser/remote/controller.ts')
s = p.read_text()

s = replace_once(
    s,
    "  | { kind: 'key'; key: string };",
    "  | { kind: 'key'; key: string; modifiers?: Array<'Control' | 'Meta' | 'Shift'> };",
    'controller key modifiers type',
)

old_release = '''  private async releaseIfIdle(runId: string): Promise<void> {
    const held = this.runs.get(runId);
    if (!held) return;
    this.runs.delete(runId);
    // Awaited, not fired and forgotten: the caller is about to report the
    // refusal, and the session should be gone by the time it does. Otherwise
    // "stopped" and "still paying for a browser" are true at the same moment.
    await this.teardown(runId, held);
  }
'''
new_release = '''  private async releaseIfIdle(runId: string, waitForTeardown = true): Promise<void> {
    const held = this.runs.get(runId);
    if (!held) return;
    this.runs.delete(runId);
    const teardown = this.teardown(runId, held);
    // Ordinarily the refusal waits until the provider session is actually gone.
    // There is one deliberate exception: `act()` still owns the action slot.
    // An unwatch may already be in `held.watchQueue` waiting for THAT slot, and
    // teardown waits for watchQueue before detaching. Awaiting it from the slot
    // holder makes a cycle: act -> teardown -> unwatch -> action slot -> act.
    // Start/record teardown now, but let the action's finally release the slot;
    // the queued unwatch then finishes and the recorded teardown follows it.
    if (waitForTeardown) await teardown;
  }
'''
s = replace_once(s, old_release, new_release, 'nonblocking teardown option')

# Every releaseIfIdle call is inside act() after the action slot has been taken.
s = s.replace('await this.releaseIfIdle(runId);', 'await this.releaseIfIdle(runId, false);')
if s.count('releaseIfIdle(runId, false)') != 4:
    raise SystemExit(f'expected 4 slot-held releaseIfIdle calls, found {s.count("releaseIfIdle(runId, false)")}')

key_pattern = r"      case 'key': \{.*?\n      \}\n      case 'move':"
key_repl = '''      case 'key': {
        const modifiers = event.modifiers;
        if (modifiers !== undefined) {
          if (!Array.isArray(modifiers)
            || modifiers.some((m) => m !== 'Control' && m !== 'Meta' && m !== 'Shift')
            || new Set(modifiers).size !== modifiers.length) {
            throw new Error('That editing shortcut has invalid modifiers.');
          }
          const primary = modifiers.filter((m) => m === 'Control' || m === 'Meta');
          const shifted = modifiers.includes('Shift');
          if (primary.length !== 1) {
            throw new Error('That editing shortcut cannot be sent to the page.');
          }
          const key = typeof event.key === 'string' ? event.key : '';
          const lower = key.toLowerCase();
          const shortcut = lower === 'a' && !shifted
            ? { key: 'a', code: 'KeyA', vk: 65 }
            : lower === 'z'
              ? { key: 'z', code: 'KeyZ', vk: 90 }
              : lower === 'y' && !shifted
                ? { key: 'y', code: 'KeyY', vk: 89 }
                : key === 'Backspace' && !shifted
                  ? { key: 'Backspace', code: 'Backspace', vk: 8 }
                  : key === 'Delete' && !shifted
                    ? { key: 'Delete', code: 'Delete', vk: 46 }
                    : undefined;
          if (!shortcut) {
            // Copy/cut cannot honestly be implemented by a remote key chord:
            // Chrome would copy into the REMOTE machine's clipboard, not the
            // local clipboard the person expects. Refuse those (and any future
            // editing chord) explicitly rather than letting it mutate only the
            // hidden textarea and then forwarding the person's next text as a
            // different remote edit.
            throw new Error(`That editing shortcut is not supported for the remote page: ${key}`);
          }
          const modifierBits = (primary[0] === 'Control' ? 2 : 4) | (shifted ? 8 : 0);
          const base = {
            key: shortcut.key,
            code: shortcut.code,
            windowsVirtualKeyCode: shortcut.vk,
            nativeVirtualKeyCode: shortcut.vk,
            modifiers: modifierBits,
          };
          await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
          await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
          return;
        }

        // `Object.hasOwn`, not a bare lookup. `KEYS['__proto__']` is
        // `Object.prototype` — truthy — so a bare `if (!spec)` let it through
        // and then read `spec.code` as undefined, dispatching a key event with
        // no virtual key code. `constructor` and `toString` do the same. An
        // allowlist that answers for keys nobody put in it is not an allowlist.
        const spec = typeof event.key === 'string' && Object.hasOwn(KEYS, event.key)
          ? KEYS[event.key]
          : undefined;
        if (!spec) throw new Error(`That key cannot be sent to the page: ${String(event.key)}`);
        const base = {
          key: event.key,
          code: event.key,
          windowsVirtualKeyCode: spec.code,
          nativeVirtualKeyCode: spec.code,
          ...(spec.text ? { text: spec.text } : {}),
        };
        await cdp.send('Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown' });
        await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
        return;
      }
      case 'move':'''
s = sub_once(s, key_pattern, key_repl, 'controller key dispatch')
p.write_text(s)


# ---------------------------------------------------------------------------
# lease.ts: one grace interval per in-flight human action
# ---------------------------------------------------------------------------
p = Path('src/browser/lease.ts')
s = p.read_text()

field_anchor = '''  /** Whether the current action slot represents activity by its holder. */
  private actionCountsAsHumanActivity = false;
'''
field_new = '''  /** Whether the current action slot represents activity by its holder. */
  private actionCountsAsHumanActivity = false;
  /**
   * The human action that has already consumed its one idle-deadline grace.
   * A single wedged CDP request must not look like fresh activity every two
   * minutes forever. The first deadline may yield to an event that began before
   * it; a second deadline for that SAME event becomes a pending lapse instead.
   */
  private idleGraceAction: symbol | null = null;
  /** Release the human hold as soon as this overlong action finally unwinds. */
  private idleLapseAfterAction: symbol | null = null;
'''
s = replace_once(s, field_anchor, field_new, 'lease idle action fields')

old_lapse = '''    if (this.action && this.actionCountsAsHumanActivity) {
      // An event the person started before the deadline is evidence they are
      // still here, so that interaction earns a fresh idle interval.
      this.armIdle();
      return;
    }
'''
new_lapse = '''    if (this.action && this.actionCountsAsHumanActivity) {
      // An event that began before the FIRST deadline is evidence the person
      // was there, so it gets one fresh interval. But the same still-running
      // request at the NEXT deadline is not new activity. Mark the lapse as
      // pending and stop arming timers; when that exact action unwinds,
      // `endAction` releases the hold before any queued event can take its slot.
      if (this.idleGraceAction !== this.action) {
        this.idleGraceAction = this.action;
        this.armIdle();
      } else {
        this.idleLapseAfterAction = this.action;
        this.clearHumanIdle();
      }
      return;
    }
'''
s = replace_once(s, old_lapse, new_lapse, 'lease lapse one grace')

old_release_bits = '''    this.clearHumanIdle();
    this.handBackWanted = false;
    this.actor = null;
'''
new_release_bits = '''    this.clearHumanIdle();
    this.handBackWanted = false;
    this.idleGraceAction = null;
    this.idleLapseAfterAction = null;
    this.actor = null;
'''
s = replace_once(s, old_release_bits, new_release_bits, 'clear pending idle action on release')

old_end = '''  endAction(token: symbol): boolean {
    if (this.action !== token) return false;
    this.action = null;
    this.actionCountsAsHumanActivity = false;
    this.actionQueue.shift()?.();
    return true;
  }
'''
new_end = '''  endAction(token: symbol): boolean {
    if (this.action !== token) return false;
    const lapseNow = this.actor === HUMAN_ACTOR && this.idleLapseAfterAction === token;
    this.action = null;
    this.actionCountsAsHumanActivity = false;
    if (this.idleGraceAction === token) this.idleGraceAction = null;
    if (this.idleLapseAfterAction === token) this.idleLapseAfterAction = null;
    // Release BEFORE handing the action slot to the next queued operation. A
    // later human event that was queued behind a request which consumed two
    // complete idle intervals is stale by definition; it may take the slot but
    // its post-wait ownership check will refuse it. This also preserves the
    // core rule that the old event itself finishes before ownership changes.
    if (lapseNow) this.release();
    this.actionQueue.shift()?.();
    return true;
  }
'''
s = replace_once(s, old_end, new_end, 'release pending idle lapse on endAction')
p.write_text(s)


# ---------------------------------------------------------------------------
# BrowserLiveView.tsx: editing chords + release-committed clicks
# ---------------------------------------------------------------------------
p = Path('cloud/web/src/chat/BrowserLiveView.tsx')
s = p.read_text()

s = replace_once(
    s,
    "  | { kind: 'key'; key: string };",
    "  | { kind: 'key'; key: string; modifiers?: Array<'Control' | 'Meta' | 'Shift'> };",
    'web key modifiers type',
)

# Ref for an uncommitted pointer press.
anchor = '''  const keyboardRef = useRef<HTMLTextAreaElement>(null);
'''
replacement = '''  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  /**
   * A pointer press is only a candidate click until the matching release.
   * Sending a complete remote click from mouse-down made dragging away unable
   * to cancel a destructive action: the server had already pressed AND
   * released before the local button came back up.
   */
  const pendingClickRef = useRef<{ button: number; clicks: number } | null>(null);
'''
s = replace_once(s, anchor, replacement, 'pending click ref')

# Clear press on task/control cleanup too.
old_cleanup = '''      pendingScrollRef.current = null;
      // Text accumulated by an IME belongs to the same view as the pointer
'''
new_cleanup = '''      pendingScrollRef.current = null;
      pendingClickRef.current = null;
      // Text accumulated by an IME belongs to the same view as the pointer
'''
s = replace_once(s, old_cleanup, new_cleanup, 'clear pending click on view cleanup')

old_onkey = '''  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let local browser shortcuts and AltGr do their normal thing. If they
    // produce text, the textarea's `input` event below is what forwards it.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // During composition, physical key names (`Process`, Enter, arrows) belong
    // to the IME, not to the remote page. The committed text arrives via input.
    if (e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Dead') return;
    if (!COMMAND_KEYS.has(e.key)) return;
    e.preventDefault();
    // No modifier representation in BrowserInput yet. Fail closed instead of
    // turning Shift+Tab/Arrow/Enter into an unshifted remote mutation.
    if (e.shiftKey) return;
    // A command must not leave editable residue in the sink.
    e.currentTarget.value = '';
    flushPendingScroll();
    onInput?.({ kind: 'key', key: e.key });
  };
'''
new_onkey = '''  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
'''
s = replace_once(s, old_onkey, new_onkey, 'web editing chord handling')

old_mouse = '''          onMouseDown={driving ? (e) => {
            // Keep the keyboard on the editable sink, where the browser can
            // perform real layout/IME composition instead of us guessing from
            // keydown. Pointer input still belongs to the image underneath.
            e.preventDefault();
            keyboardRef.current?.focus();
            if (e.button > 2) return;
            const p = at(e.clientX, e.clientY);
            if (p) {
              // The sampled wheel happened before this click. Flush it
              // now so its timer cannot reverse their remote order.
              flushPendingScroll();
              onInput?.({ kind: 'click', ...p, button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left', clicks: e.detail || 1 });
            }
          } : undefined}
'''
new_mouse = '''          draggable={false}
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
            pendingClickRef.current = { button: e.button, clicks: e.detail || 1 };
          } : undefined}
          onMouseUp={driving ? (e) => {
            e.preventDefault();
            const press = pendingClickRef.current;
            pendingClickRef.current = null;
            if (!press || press.button !== e.button) return;
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
'''
s = replace_once(s, old_mouse, new_mouse, 'commit click on release')
p.write_text(s)


# ---------------------------------------------------------------------------
# Regression tests — append self-contained cases using existing fakes/imports.
# ---------------------------------------------------------------------------
p = Path('src/browser/remote/controller.test.ts')
s = p.read_text()
marker = "describe('round 30 review regressions'"
if marker not in s:
    s += r'''

describe('round 30 review regressions', () => {
  async function openWatchedHuman(c: InstanceType<typeof RemoteBrowserController>, runId = 'run-r30') {
    await c.controller({ kind: 'click', selector: '#open' }, ctx(runId, 'worker-r30'));
    let generation: number | undefined;
    await c.startWatching(runId, (f) => { generation = f.generation; });
    await Promise.resolve();
    if (generation === undefined) {
      cdp.pushFrame(301);
      await Promise.resolve();
    }
    if (generation === undefined) throw new Error('watch produced no generation');
    c.frameSeen(runId, generation);
    c.actorEnded('worker-r30');
    expect((await c.takeOver(runId)).ok).toBe(true);
  }

  it('does not deadlock cancellation behind an unwatch waiting for the action slot', async () => {
    const { provider, ended } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await openWatchedHuman(c);
    expect(await c.setCapture('run-r30', false)).toBe(false);
    expect(c.handBack('run-r30')).toBe(true);

    const restoreStarted = deferred();
    const allowRestore = deferred();
    const realSend = cdp.send;
    cdp.send = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.startScreencast') {
        restoreStarted.resolve();
        await allowRestore.promise;
      }
      return realSend.call(cdp, method, params);
    };

    const abort = new AbortController();
    const acting = c.controller(
      { kind: 'click', selector: '#after-hidden' },
      ctx('run-r30', 'worker-after', abort.signal),
    );
    await restoreStarted.promise;

    // The unwatch invalidates the view and then waits for the action slot which
    // `acting` still owns. Cancellation must not await teardown/watchQueue from
    // inside that same slot, or the three promises form a permanent cycle.
    const unwatching = c.stopWatching('run-r30');
    await Promise.resolve();
    abort.abort();
    allowRestore.resolve();

    const settled = await Promise.race([
      acting,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    expect(settled, 'cancellation releases its slot instead of waiting on its own unwatch').not.toBe('hung');
    expect((settled as { ok?: boolean }).ok).toBe(false);
    await unwatching;
    await c.dispose();
    expect(ended, 'the provider session is eventually returned').toContain('sess-1');
  });

  it('forwards safe editing chords and refuses clipboard chords explicitly', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await openWatchedHuman(c);

    const selected = await c.input('run-r30', {
      kind: 'key', key: 'a', modifiers: ['Control'],
    });
    expect(selected.ok).toBe(true);
    const keyCalls = cdp.calls.filter((call) => call.method === 'Input.dispatchKeyEvent');
    expect(keyCalls.at(-2)?.params).toMatchObject({
      type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
    });
    expect(keyCalls.at(-1)?.params).toMatchObject({ type: 'keyUp', modifiers: 2 });

    const before = cdp.calls.length;
    const copy = await c.input('run-r30', {
      kind: 'key', key: 'c', modifiers: ['Control'],
    });
    expect(copy.ok, 'remote copy would target the remote clipboard, so it is refused rather than faked').toBe(false);
    expect(copy.detail).toMatch(/shortcut.*not supported/i);
    expect(cdp.calls.length, 'a refused editing chord sends no CDP key event').toBe(before);
  });

  it('lets one long human event defer idle once, then lapses as soon as that same event unwinds', async () => {
    vi.useFakeTimers();
    try {
      const { provider } = fakeProvider();
      const c = new RemoteBrowserController({ provider });
      await openWatchedHuman(c);

      const gate = deferred();
      const realSend = cdp.send;
      cdp.send = async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Input.insertText') await gate.promise;
        return realSend.call(cdp, method, params);
      };

      const typing = c.input('run-r30', { kind: 'text', text: 'x' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(c.humanHolds('run-r30'), 'the event that crossed the first deadline gets one grace interval').toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(c.humanHolds('run-r30'), 'ownership is not torn away while the CDP event is still landing').toBe(true);

      gate.resolve();
      await typing;
      await Promise.resolve();
      expect(c.humanHolds('run-r30'), 'the second deadline was pending, not renewed for another two minutes').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
'''
p.write_text(s)

p = Path('cloud/web/src/chat/BrowserLiveView.test.tsx')
s = p.read_text()
marker = "describe('BrowserLiveView — round 30 review regressions'"
if marker not in s:
    s += r'''

describe('BrowserLiveView — round 30 review regressions', () => {
  const frame = { data: 'ROUND30', width: 1280, height: 800, generation: 30 };

  function driving(onInput: ReturnType<typeof vi.fn>) {
    return render(
      <BrowserLiveView
        active liveViewUrl={undefined} frame={frame} human confirmed
        onStop={() => {}} onInput={onInput}
      />,
    );
  }

  it('sends editing chords to the remote boundary instead of editing only the hidden textarea', () => {
    const onInput = vi.fn();
    driving(onInput);
    const image = screen.getByRole('img') as HTMLImageElement;
    fireEvent.mouseDown(image, { clientX: 10, clientY: 10, button: 0 });
    const keyboard = screen.getByLabelText(/type into the agent browser/i) as HTMLTextAreaElement;

    fireEvent.keyDown(keyboard, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(keyboard, { key: 'z', metaKey: true });
    fireEvent.keyDown(keyboard, { key: 'c', ctrlKey: true });

    expect(onInput.mock.calls.map((call) => call[0])).toEqual([
      { kind: 'key', key: 'a', modifiers: ['Control'] },
      { kind: 'key', key: 'z', modifiers: ['Meta'] },
      { kind: 'key', key: 'c', modifiers: ['Control'] },
    ]);
  });

  it('does not commit a remote click until the matching mouse button is released', () => {
    const onInput = vi.fn();
    driving(onInput);
    const image = screen.getByRole('img') as HTMLImageElement;
    Object.defineProperty(image, 'naturalWidth', { value: 1280 });
    Object.defineProperty(image, 'naturalHeight', { value: 800 });
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800 }) as DOMRect;

    fireEvent.mouseDown(image, { clientX: 320, clientY: 200, button: 0, detail: 1 });
    expect(onInput.mock.calls.some((call) => call[0]?.kind === 'click'), 'mouse-down is only a candidate').toBe(false);

    fireEvent.mouseUp(image, { clientX: 320, clientY: 200, button: 0, detail: 1 });
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', x: 0.25, y: 0.25, button: 'left', clicks: 1 });
  });

  it('lets dragging away cancel a candidate remote click', () => {
    const onInput = vi.fn();
    driving(onInput);
    const image = screen.getByRole('img') as HTMLImageElement;
    Object.defineProperty(image, 'naturalWidth', { value: 1280 });
    Object.defineProperty(image, 'naturalHeight', { value: 800 });
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800 }) as DOMRect;

    fireEvent.mouseDown(image, { clientX: 320, clientY: 200, button: 0, buttons: 1 });
    fireEvent.mouseLeave(image, { clientX: 1400, clientY: 900, button: 0, buttons: 1 });
    fireEvent.mouseUp(image, { clientX: 400, clientY: 250, button: 0, buttons: 0 });
    expect(onInput.mock.calls.some((call) => call[0]?.kind === 'click'), 'release after leaving is a cancellation').toBe(false);
  });
});
'''
p.write_text(s)
