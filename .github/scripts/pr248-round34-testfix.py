from pathlib import Path

p = Path('cloud/web/src/chat/BrowserLiveView.test.tsx')
text = p.read_text()

old = """describe('BrowserLiveView — touch takeover gestures', () => {\n  const frame = { data: 'TOUCH', width: 1280, height: 800, generation: 1 };\n"""
new = """describe('BrowserLiveView — touch takeover gestures', () => {\n  const frame = { data: 'TOUCH', width: 1280, height: 800, generation: 1 };\n\n  // jsdom does not currently expose PointerEvent, so Testing Library's\n  // pointer convenience falls back to an event without pointerType/pointerId.\n  // Build the same DOM event React receives in a browser and add the pointer\n  // fields explicitly; this tests our gesture code rather than jsdom support.\n  const touchPointer = (\n    target: Element, type: string,\n    init: { pointerId: number; clientX: number; clientY: number },\n  ) => {\n    const event = new MouseEvent(type, {\n      bubbles: true, cancelable: true, clientX: init.clientX, clientY: init.clientY,\n    });\n    Object.defineProperties(event, {\n      pointerId: { value: init.pointerId },\n      pointerType: { value: 'touch' },\n      isPrimary: { value: true },\n    });\n    fireEvent(target, event);\n  };\n"""
if text.count(old) != 1:
    raise SystemExit(f'describe anchor count={text.count(old)}')
text = text.replace(old, new, 1)

old = "expect(img).toHaveStyle({ touchAction: 'none' });"
new = "expect((img.style as CSSStyleDeclaration & { touchAction?: string }).touchAction).toBe('none');"
if text.count(old) != 1:
    raise SystemExit(f'touchAction assertion count={text.count(old)}')
text = text.replace(old, new, 1)

repls = {
"fireEvent.pointerDown(img, { pointerId: 4, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 300 });":
"touchPointer(img, 'pointerdown', { pointerId: 4, clientX: 320, clientY: 300 });",
"fireEvent.pointerMove(img, { pointerId: 4, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 220 });":
"touchPointer(img, 'pointermove', { pointerId: 4, clientX: 320, clientY: 220 });",
"fireEvent.pointerUp(img, { pointerId: 4, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 220 });":
"touchPointer(img, 'pointerup', { pointerId: 4, clientX: 320, clientY: 220 });",
"fireEvent.pointerDown(img, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 200 });":
"touchPointer(img, 'pointerdown', { pointerId: 9, clientX: 320, clientY: 200 });",
"fireEvent.pointerUp(img, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: 322, clientY: 201 });":
"touchPointer(img, 'pointerup', { pointerId: 9, clientX: 322, clientY: 201 });",
}
for old, new in repls.items():
    if text.count(old) != 1:
        raise SystemExit(f'pointer line count={text.count(old)}: {old}')
    text = text.replace(old, new, 1)

p.write_text(text)
print('round34 touch harness patched')
