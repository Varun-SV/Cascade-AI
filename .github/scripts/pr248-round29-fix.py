from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def sub_once(text: str, pattern: str, new: str, label: str) -> str:
    out, count = re.subn(pattern, new, text, count=1, flags=re.S | re.M)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return out


# --- useChatSession: track every active browser task in a conversation ---
path = Path("cloud/web/src/chat/useChatSession.ts")
s = path.read_text()

s = replace_once(
    s,
    "    Record<string, {\n      taskId?: string;\n",
    "    Record<string, Array<{\n      taskId: string;\n",
    "browser views become per-task arrays",
)
s = replace_once(
    s,
    "      notice?: string;\n    }>\n  >({});\n  const browserView = browserViews[activeConversationId() ?? ''];\n",
    "      notice?: string;\n    }>>\n  >({});\n  const browserView = browserViews[activeConversationId() ?? '']?.at(-1);\n",
    "browser view selects newest active task",
)

old_clear = """  const clearBrowserNotice = useCallback((taskId: string) => {
    setBrowserViews((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, view] of Object.entries(prev)) {
        if (view.taskId === taskId && view.notice !== undefined) {
          changed = true;
          next[key] = { ...view, notice: undefined };
        } else {
          next[key] = view;
        }
      }
      return changed ? next : prev;
    });
  }, []);
"""
new_clear = """  const clearBrowserNotice = useCallback((taskId: string) => {
    setBrowserViews((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, views] of Object.entries(prev)) {
        next[key] = views.map((view) => {
          if (view.taskId === taskId && view.notice !== undefined) {
            changed = true;
            return { ...view, notice: undefined };
          }
          return view;
        });
      }
      return changed ? next : prev;
    });
  }, []);
"""
s = replace_once(s, old_clear, new_clear, "clear notice across per-task views")

old_stop = """  const stopBrowser = useCallback(() => {
    // The task id, which the server requires to match exactly. Without it the
    // Stop is ignored — which is the correct failure: better a button that does
    // nothing than one that stops somebody else's run.
    if (!browserTaskIdRef.current) return;
    socket?.emit('browser:stop', { taskId: browserTaskIdRef.current });
    // This conversation's panel only. Another chat's browser is not something
    // this button withdraws.
    const key = activeConversationId() ?? '';
    setBrowserViews(({ [key]: _gone, ...rest }) => rest);
  }, [socket]);
"""
new_stop = """  const stopBrowser = useCallback(() => {
    // The task id, which the server requires to match exactly. Without it the
    // Stop is ignored — which is the correct failure: better a button that does
    // nothing than one that stops somebody else's run.
    const taskId = browserTaskIdRef.current;
    if (!taskId) return;
    socket?.emit('browser:stop', { taskId });
    // Withdraw THIS task optimistically. If an older browser is still active in
    // the same conversation it becomes the displayed one immediately, keeping
    // its own Stop control reachable instead of deleting the whole conversation
    // slot along with the task the user actually stopped.
    const key = activeConversationId() ?? '';
    setBrowserViews((prev) => {
      const views = prev[key];
      if (!views) return prev;
      const kept = views.filter((view) => view.taskId !== taskId);
      if (kept.length === views.length) return prev;
      if (kept.length === 0) {
        const { [key]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: kept };
    });
  }, [socket]);
"""
s = replace_once(s, old_stop, new_stop, "stop only current task")

old_begin_set = """    setBrowserViews((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, view] of Object.entries(prev)) {
        if (view.taskId === taskId && (view.frame || view.streaming || view.confirmed)) {
          changed = true;
          next[key] = { ...view, frame: undefined, streaming: false, confirmed: false };
        } else {
          next[key] = view;
        }
      }
      return changed ? next : prev;
    });
"""
new_begin_set = """    setBrowserViews((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, views] of Object.entries(prev)) {
        next[key] = views.map((view) => {
          if (view.taskId === taskId && (view.frame || view.streaming || view.confirmed)) {
            changed = true;
            return { ...view, frame: undefined, streaming: false, confirmed: false };
          }
          return view;
        });
      }
      return changed ? next : prev;
    });
"""
s = replace_once(s, old_begin_set, new_begin_set, "begin watch clears selected task sight")

old_disconnect_set = """      setBrowserViews((prev) => {
        let changed = false;
        const next: typeof prev = {};
        for (const [key, view] of Object.entries(prev)) {
          if (view.frame || view.streaming || view.confirmed) {
            changed = true;
            next[key] = { ...view, frame: undefined, streaming: false, confirmed: false };
          } else {
            next[key] = view;
          }
        }
        return changed ? next : prev;
      });
"""
new_disconnect_set = """      setBrowserViews((prev) => {
        let changed = false;
        const next: typeof prev = {};
        for (const [key, views] of Object.entries(prev)) {
          next[key] = views.map((view) => {
            if (view.frame || view.streaming || view.confirmed) {
              changed = true;
              return { ...view, frame: undefined, streaming: false, confirmed: false };
            }
            return view;
          });
        }
        return changed ? next : prev;
      });
"""
s = replace_once(s, old_disconnect_set, new_disconnect_set, "disconnect clears all task sight")

on_live_pattern = r"""    const onLiveView = \(e: \{ conversationId\?: string; taskId\?: string; liveViewUrl\?: string; active\?: boolean \}\) => \{.*?^    \};\n    /\*\*\n     \* A rendered frame of a run's browser\."""
on_live_new = """    const onLiveView = (e: { conversationId?: string; taskId?: string; liveViewUrl?: string; active?: boolean }) => {
      // Recorded AGAINST its conversation rather than into one shared slot. One
      // socket carries several runs, and a single slot meant switching chats
      // left another run's bearer-capability URL rendered in the pane you moved
      // to, while a late withdrawal from the run you left cleared the view of
      // the one you were on.
      adoptConversationId(e?.conversationId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      const taskId = typeof e?.taskId === 'string' && e.taskId ? e.taskId : undefined;
      // Every server live-view message is task-addressed. An untagged message
      // cannot safely create, replace or withdraw any browser in a conversation.
      if (!taskId) return;
      setBrowserViews((prev) => {
        const views = prev[key] ?? [];
        if (e?.active !== true) {
          // Remove exactly the run that gave its browser up. The newest active
          // task is the panel, so if THAT task ends the previous still-active
          // browser is promoted rather than disappearing with it.
          const kept = views.filter((view) => view.taskId !== taskId);
          if (kept.length === views.length) return prev;
          if (kept.length === 0) {
            const { [key]: _done, ...rest } = prev;
            return rest;
          }
          return { ...prev, [key]: kept };
        }

        const existing = views.findIndex((view) => view.taskId === taskId);
        if (existing >= 0) {
          const current = views[existing]!;
          if (current.liveViewUrl === e?.liveViewUrl) return prev;
          const next = [...views];
          next[existing] = { ...current, liveViewUrl: e?.liveViewUrl };
          // A replay for an already-active task updates its capability URL but
          // does not make an older run jump in front of a newer one.
          return { ...prev, [key]: next };
        }

        // A newly-active browser becomes the visible panel. The task it covers
        // remains active underneath, but its old picture is no longer evidence
        // of sight: if it is promoted later it must establish a fresh watch
        // before any image or blind keyboard can be interactive.
        const hidden = views.map((view, index) => (
          index === views.length - 1
            ? { ...view, frame: undefined, streaming: false, confirmed: false }
            : view
        ));
        return { ...prev, [key]: [...hidden, { taskId, liveViewUrl: e?.liveViewUrl }] };
      });
    };
    /**
     * A rendered frame of a run's browser."""
s = sub_once(s, on_live_pattern, on_live_new, "live-view per-task stack")

on_frame_pattern = r"""    const onBrowserFrame = \(e: \{\n      conversationId\?: string; taskId\?: string; data\?: string; width\?: number; height\?: number;\n      generation\?: number;\n    \}\) => \{.*?^    \};\n    /\*\* The server answering whether a stream actually started\. \*/"""
on_frame_new = """    const onBrowserFrame = (e: {
      conversationId?: string; taskId?: string; data?: string; width?: number; height?: number;
      generation?: number;
    }) => {
      if (typeof e?.data !== 'string' || !e.taskId) return;
      adoptConversationId(e?.conversationId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      setBrowserViews((prev) => {
        const views = prev[key];
        if (!views) return prev;
        const index = views.findIndex((view) => view.taskId === e.taskId);
        if (index < 0) return prev;
        // Only the displayed task is watched. Anything arriving for a hidden
        // task is a late frame from the watch we just replaced; retaining it
        // would make promotion briefly show an old, possibly interactive JPEG
        // before the new viewing boundary has produced its own picture.
        if (index !== views.length - 1) return prev;
        const view = views[index]!;
        const next = [...views];
        next[index] = {
          ...view,
          frame: {
            data: e.data!, width: e.width ?? 0, height: e.height ?? 0,
            generation: typeof e.generation === 'number' ? e.generation : 0,
          },
        };
        return { ...prev, [key]: next };
      });
    };
    /** The server answering whether a stream actually started. */"""
s = sub_once(s, on_frame_pattern, on_frame_new, "frame updates displayed task only")

on_watching_pattern = r"""    const onBrowserWatching = \(e: \{ conversationId\?: string; taskId\?: string; streaming\?: boolean \}\) => \{.*?^    \};\n    /\*\*\n     \* Who holds the page"""
on_watching_new = """    const onBrowserWatching = (e: { conversationId?: string; taskId?: string; streaming?: boolean }) => {
      if (!e.taskId) return;
      adoptConversationId(e?.conversationId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      setBrowserViews((prev) => {
        const views = prev[key];
        if (!views) return prev;
        const index = views.findIndex((view) => view.taskId === e.taskId);
        if (index < 0 || index !== views.length - 1) return prev;
        const next = [...views];
        next[index] = { ...views[index]!, streaming: e?.streaming === true };
        return { ...prev, [key]: next };
      });
    };
    /**
     * Who holds the page"""
s = sub_once(s, on_watching_pattern, on_watching_new, "watching updates displayed task")

on_control_pattern = r"""    const onBrowserControl = \(e: \{\n      conversationId\?: string; taskId\?: string; human\?: boolean; capturing\?: boolean;\n      confirmed\?: boolean; detail\?: string;\n    \}\) => \{.*?^    \};\n    socket\.on\('browser:control'"""
on_control_new = """    const onBrowserControl = (e: {
      conversationId?: string; taskId?: string; human?: boolean; capturing?: boolean;
      confirmed?: boolean; detail?: string;
    }) => {
      if (!e.taskId) return;
      adoptConversationId(e?.conversationId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      setBrowserViews((prev) => {
        const views = prev[key];
        if (!views) return prev;
        const index = views.findIndex((view) => view.taskId === e.taskId);
        if (index < 0) return prev;
        const view = views[index]!;
        const hidden = index !== views.length - 1;
        const nextView = {
          ...view,
          ...(typeof e.human === 'boolean' ? { human: e.human } : {}),
          ...(typeof e.capturing === 'boolean' ? { capturing: e.capturing } : {}),
          ...(!hidden && typeof e.confirmed === 'boolean' ? { confirmed: e.confirmed } : {}),
          ...(e.capturing === false ? { frame: undefined } : {}),
          ...(typeof e.detail === 'string' ? { notice: e.detail } : { notice: undefined }),
          // Ownership can legitimately change while another run is in front,
          // but visibility proof cannot survive being hidden/unwatched.
          ...(hidden ? { frame: undefined, streaming: false, confirmed: false } : {}),
        };
        const next = [...views];
        next[index] = nextView;
        return { ...prev, [key]: next };
      });
    };
    socket.on('browser:control'"""
s = sub_once(s, on_control_pattern, on_control_new, "control updates task identity")

old_mark = """  const markBrowserFrameShown = useCallback((generation: number) => {
    const taskId = browserTaskIdRef.current;
    if (!socket || !taskId) return;
    // Keyed by TASK as well as generation. A watch generation counts from zero
"""
new_mark = """  const markBrowserFrameShown = useCallback((taskId: string, generation: number) => {
    // The image that loaded names the task it came from. If the pane switched
    // while that JPEG was decoding, its receipt is stale and must not be
    // retargeted at the browser that happens to be current now.
    if (!socket || browserTaskIdRef.current !== taskId) return;
    // Keyed by TASK as well as generation. A watch generation counts from zero
"""
s = replace_once(s, old_mark, new_mark, "receipt binds originating task")
path.write_text(s)

# --- ChatPanel: bind image callback to the render/task that produced it ---
path = Path("cloud/web/src/chat/ChatPanel.tsx")
c = path.read_text()
c = replace_once(
    c,
    "  onBrowserFrameShown?: (generation: number) => void;\n",
    "  onBrowserFrameShown?: (taskId: string, generation: number) => void;\n",
    "ChatPanel receipt type",
)
c = replace_once(
    c,
    "        <BrowserLiveView\n          active={browserActive === true}\n",
    "        <BrowserLiveView\n          key={browserTaskId ?? 'no-browser-task'}\n          active={browserActive === true}\n",
    "BrowserLiveView keyed by task",
)
c = replace_once(
    c,
    "          onFrameShown={(g) => onBrowserFrameShown?.(g)}\n",
    "          onFrameShown={(g) => { if (browserTaskId) onBrowserFrameShown?.(browserTaskId, g); }}\n",
    "receipt passes originating task",
)
path.write_text(c)

# --- Conversation-scope regressions and updated receipt API ---
path = Path("cloud/web/src/chat/useChatSession.conversationScope.test.tsx")
t = path.read_text()
# Most existing receipt assertions are task-a.
t = t.replace("view.result.current.markBrowserFrameShown(", "view.result.current.markBrowserFrameShown('task-a', ")
# The one existing task-b receipt follows this exact switch block.
old_b = """    act(() => { fake.fire('browser:frame', frame('conv-b', 'task-b', 'BBBB', 1)); });
    act(() => { view.result.current.markBrowserFrameShown('task-a', 1); });
"""
new_b = """    act(() => { fake.fire('browser:frame', frame('conv-b', 'task-b', 'BBBB', 1)); });
    act(() => { view.result.current.markBrowserFrameShown('task-b', 1); });
"""
t = replace_once(t, old_b, new_b, "existing task-b receipt")

anchor = """  it('keeps the newer run\\'s panel when the older one gives its browser up', () => {
"""
new_overlap_test = r"""  it('promotes the older active browser when the newer run gives its browser up', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-old', 'https://viewer.example/old'));
    });
    act(() => {
      fake.fire('browser:frame', frame('conv-a', 'task-old', 'OLD-BEFORE', 3));
      fake.fire('browser:control', {
        conversationId: 'conv-a', taskId: 'task-old', human: true, capturing: true, confirmed: true,
      });
      fake.fire('browser:live-view', liveView('conv-a', 'task-new', 'https://viewer.example/new'));
    });
    expect(view.result.current.browserTaskId).toBe('task-new');

    // A late picture from the old watch must not be banked while its task is
    // hidden. Promotion needs a new viewing boundary, not a cached JPEG.
    act(() => { fake.fire('browser:frame', frame('conv-a', 'task-old', 'LATE-OLD', 3)); });

    act(() => {
      fake.fire('browser:live-view', { conversationId: 'conv-a', taskId: 'task-new', active: false });
    });

    expect(view.result.current.browserActive, 'the older browser is still active').toBe(true);
    expect(view.result.current.browserTaskId).toBe('task-old');
    expect(view.result.current.browserLiveView).toBe('https://viewer.example/old');
    expect(view.result.current.browserHuman, 'ownership state survives while the task is hidden').toBe(true);
    expect(view.result.current.browserFrame, 'but stale sight evidence does not').toBeUndefined();
    expect(view.result.current.browserConfirmed).toBe(false);

    // The promoted task is watched again and can supply a fresh picture.
    act(() => {
      fake.fire('browser:watching', { conversationId: 'conv-a', taskId: 'task-old', streaming: true });
      fake.fire('browser:frame', frame('conv-a', 'task-old', 'OLD-FRESH', 4));
    });
    expect(view.result.current.browserStreaming).toBe(true);
    expect(view.result.current.browserFrame?.data).toBe('OLD-FRESH');
  });

"""
t = replace_once(t, anchor, new_overlap_test + anchor, "older task promotion regression")

receipt_anchor = """  it('confirms each run\\'s own first watch, even though they are numbered alike', () => {
"""
new_receipt_test = r"""  it('does not retarget a delayed image receipt to the browser now on screen', () => {
    const fake = fakeSocket();
    const view = renderHook(() => useChatSession(fake.socket, [], 'general', undefined, 'conv-a'));

    act(() => {
      fake.fire('browser:live-view', liveView('conv-a', 'task-a'));
      fake.fire('browser:frame', frame('conv-a', 'task-a', 'AAAA', 1));
      fake.fire('browser:live-view', liveView('conv-a', 'task-b'));
      fake.fire('browser:frame', frame('conv-a', 'task-b', 'BBBB', 1));
    });
    expect(view.result.current.browserTaskId).toBe('task-b');

    // A's <img> finished decoding after B replaced it. Both first watches use
    // generation 1, so reading only the CURRENT task here would falsely confirm
    // B even though B's JPEG has never loaded.
    act(() => { view.result.current.markBrowserFrameShown('task-a', 1); });
    expect(fake.sent.filter((m) => m.event === 'browser:frame-seen')).toHaveLength(0);

    // B's own image load is the first thing allowed to confirm B.
    act(() => { view.result.current.markBrowserFrameShown('task-b', 1); });
    expect(fake.sent.filter((m) => m.event === 'browser:frame-seen').map((m) => m.payload))
      .toEqual([{ taskId: 'task-b', generation: 1 }]);
  });

"""
t = replace_once(t, receipt_anchor, new_receipt_test + receipt_anchor, "delayed receipt regression")
path.write_text(t)
