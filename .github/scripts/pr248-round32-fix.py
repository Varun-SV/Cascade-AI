from pathlib import Path

view_path = Path('cloud/web/src/chat/BrowserLiveView.tsx')
test_path = Path('cloud/web/src/chat/BrowserLiveView.test.tsx')

view = view_path.read_text()

old = """const MOVE_INTERVAL_MS = 60;\n"""
new = """const MOVE_INTERVAL_MS = 60;\n\n/**\n * Maximum local pointer travel that still counts as the same click gesture.\n *\n * Mouse-down and mouse-up are deliberately separate so a drag can cancel a\n * destructive click. Leaving the image already cancels the candidate, but a\n * drag can stay entirely inside the frame; without a distance check that would\n * turn a press on one remote element into a click on whatever is under release.\n * A few CSS pixels keeps ordinary hand jitter usable without treating a real\n * drag as a click.\n */\nconst CLICK_SLOP_PX = 5;\n"""
if view.count(old) != 1:
    raise SystemExit(f'MOVE marker count: {view.count(old)}')
view = view.replace(old, new)

old = """  const pendingClickRef = useRef<{ button: number; clicks: number } | null>(null);\n"""
new = """  const pendingClickRef = useRef<{\n    button: number; clicks: number; clientX: number; clientY: number;\n  } | null>(null);\n"""
if view.count(old) != 1:
    raise SystemExit(f'pending click marker count: {view.count(old)}')
view = view.replace(old, new)

old = """            if (e.button > 2) return;\n            if (!at(e.clientX, e.clientY)) return;\n            pendingClickRef.current = { button: e.button, clicks: e.detail || 1 };\n"""
new = """            if (e.button > 2) return;\n            if (!at(e.clientX, e.clientY)) return;\n            pendingClickRef.current = {\n              button: e.button, clicks: e.detail || 1,\n              clientX: e.clientX, clientY: e.clientY,\n            };\n"""
if view.count(old) != 1:
    raise SystemExit(f'mousedown marker count: {view.count(old)}')
view = view.replace(old, new)

old = """            if (!press || press.button !== e.button) return;\n            const p = at(e.clientX, e.clientY);\n            if (!p) return;\n"""
new = """            if (!press || press.button !== e.button) return;\n            const dx = e.clientX - press.clientX;\n            const dy = e.clientY - press.clientY;\n            if ((dx * dx) + (dy * dy) > CLICK_SLOP_PX * CLICK_SLOP_PX) return;\n            const p = at(e.clientX, e.clientY);\n            if (!p) return;\n"""
if view.count(old) != 1:
    raise SystemExit(f'mouseup marker count: {view.count(old)}')
view = view.replace(old, new)

view_path.write_text(view)

test = test_path.read_text()
marker = """  it('scrolls by pixels whatever units the wheel reported', () => {\n"""
addition = """  it('cancels a pointer drag that stays inside the frame', () => {\n    // Mouse-leave already cancels a pending click, but that is not enough: a\n    // person can press on blank space, drag across the SAME image and release\n    // over a destructive control. A normal click gesture is cancelled by that\n    // travel; committing at release coordinates would manufacture a click the\n    // person never completed. Small hand jitter remains a click.\n    const onInput = vi.fn();\n    render(\n      <BrowserLiveView active liveViewUrl={undefined} frame={frame} human confirmed onStop={() => {}} onInput={onInput} />,\n    );\n    const img = screen.getByRole('img') as HTMLImageElement;\n    Object.defineProperty(img, 'naturalWidth', { value: 1280 });\n    Object.defineProperty(img, 'naturalHeight', { value: 800 });\n    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;\n\n    fireEvent.mouseDown(img, { clientX: 100, clientY: 200, button: 0, detail: 1 });\n    fireEvent.mouseMove(img, { clientX: 300, clientY: 200, buttons: 1 });\n    fireEvent.mouseUp(img, { clientX: 300, clientY: 200, button: 0, detail: 1 });\n    expect(\n      onInput.mock.calls.filter(([event]) => event.kind === 'click'),\n      'dragging within the image does not click whatever is under the release',\n    ).toHaveLength(0);\n\n    onInput.mockClear();\n    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 0, detail: 1 });\n    fireEvent.mouseUp(img, { clientX: 203, clientY: 202, button: 0, detail: 1 });\n    expect(\n      onInput.mock.calls.filter(([event]) => event.kind === 'click'),\n      'ordinary pointer jitter still completes one click',\n    ).toHaveLength(1);\n  });\n\n"""
if test.count(marker) != 1:
    raise SystemExit(f'test insertion marker count: {test.count(marker)}')
test = test.replace(marker, addition + marker)
test_path.write_text(test)
