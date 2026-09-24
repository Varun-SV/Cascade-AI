// ─────────────────────────────────────────────
//  Cascade AI — Rendering a streamed answer at the pace it allows
// ─────────────────────────────────────────────
//
//  Every token of a streamed answer re-renders it, and every render parses
//  the whole answer again: react-markdown has no incremental mode, and the
//  maths step re-reads only what follows its last final block — of which an
//  answer that is one long block has none. A 14 KB tight list, streamed in
//  8-character chunks, spent 27 s in the maths step alone.
//
//  usePacedText shows the newest text as often as rendering it allows: after
//  a render that took t, the next waits until PACE × t has passed since that
//  render ended. Rendering then takes at most a fifth of the main thread
//  however long the answer grows, and the total over a stream is linear in
//  its length rather than quadratic. A short answer renders in a millisecond
//  or two and so still updates on every token. The newest text is always
//  shown in the end, once its wait is over.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How many times a render's own cost to wait before the next. */
const PACE = 4;

/**
 * `text`, or an earlier value of it while rendering the newest would take
 * more than its share of the main thread. The component calling it should
 * render only from the value returned, and memoise that render on it: the
 * renders in between, one per token, must reuse it rather than repeat it.
 */
export function usePacedText(text: string): string {
  const [shown, setShown] = useState(text);
  // When the text shown last changed, and what rendering it cost.
  const last = useRef({ at: 0, cost: 0 });
  const renderStarted = performance.now();

  // Once per text shown: from the start of that render to its commit, which
  // includes everything the caller's subtree did with it.
  useLayoutEffect(() => {
    const at = performance.now();
    last.current = { at, cost: at - renderStarted };
    // renderStarted is read from the render that showed this text, on purpose.
  }, [shown]);

  useEffect(() => {
    if (text === shown) return undefined;
    const wait = last.current.at + PACE * last.current.cost - performance.now();
    if (wait <= 0) {
      setShown(text);
      return undefined;
    }
    // A newer token replaces this timer with one for the same moment.
    const timer = setTimeout(() => setShown(text), wait);
    return () => clearTimeout(timer);
  }, [text, shown]);

  return shown;
}
