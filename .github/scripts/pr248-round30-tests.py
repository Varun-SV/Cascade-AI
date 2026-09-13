from pathlib import Path

p = Path('cloud/web/src/chat/BrowserLiveView.test.tsx')
s = p.read_text()

replacements = [
    (
'''    // The three that ARE buttons still work.
    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 2, detail: 1 });
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', x: 0.5, y: 0.5, button: 'right', clicks: 1 });
''',
'''    // The three that ARE buttons still work — once the matching button is
    // released. Mouse-down alone is deliberately only a cancellable candidate.
    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 2, detail: 1 });
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.mouseUp(img, { clientX: 200, clientY: 200, button: 2, detail: 1 });
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', x: 0.5, y: 0.5, button: 'right', clicks: 1 });
''',
'right-click test',
    ),
    (
'''      fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 0, detail: 1 });
      expect(onInput.mock.calls.map((c) => c[0])).toEqual([
        { kind: 'scroll', x: 0.5, y: 0.5, deltaY: 20 },
        { kind: 'click', x: 0.5, y: 0.5, button: 'left', clicks: 1 },
      ]);
''',
'''      fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 0, detail: 1 });
      expect(onInput, 'pressing has not committed either gesture yet').not.toHaveBeenCalled();
      fireEvent.mouseUp(img, { clientX: 200, clientY: 200, button: 0, detail: 1 });
      expect(onInput.mock.calls.map((c) => c[0])).toEqual([
        { kind: 'scroll', x: 0.5, y: 0.5, deltaY: 20 },
        { kind: 'click', x: 0.5, y: 0.5, button: 'left', clicks: 1 },
      ]);
''',
'wheel-before-click test',
    ),
    (
'''    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 0, detail: 1 });
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', x: 0.5, y: 0.5, button: 'left', clicks: 1 });

    // In the letterbox, which is not the page at all.
    onInput.mockClear();
    fireEvent.mouseDown(img, { clientX: 200, clientY: 10, button: 0, detail: 1 });
    expect(onInput, 'a click on a black bar is not a click on anything').not.toHaveBeenCalled();
''',
'''    fireEvent.mouseDown(img, { clientX: 200, clientY: 200, button: 0, detail: 1 });
    expect(onInput, 'mouse-down is only the candidate').not.toHaveBeenCalled();
    fireEvent.mouseUp(img, { clientX: 200, clientY: 200, button: 0, detail: 1 });
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', x: 0.5, y: 0.5, button: 'left', clicks: 1 });

    // In the letterbox, which is not the page at all. It cannot even create a
    // candidate, so the later release cannot turn the black bar into a click.
    onInput.mockClear();
    fireEvent.mouseDown(img, { clientX: 200, clientY: 10, button: 0, detail: 1 });
    fireEvent.mouseUp(img, { clientX: 200, clientY: 10, button: 0, detail: 1 });
    expect(onInput, 'a click on a black bar is not a click on anything').not.toHaveBeenCalled();
''',
'fractional click test',
    ),
]

for old, new, label in replacements:
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    s = s.replace(old, new, 1)

p.write_text(s)
