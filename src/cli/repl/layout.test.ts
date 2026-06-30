import { describe, expect, it } from 'vitest';
import { computeAdaptiveLayoutMode, computeLiveAreaBudget, computeTranscriptRows, flattenTranscript, windowTranscript } from './layout.js';

const allPanels = { isTypingCommand: false, showCost: true, showDetails: true, showComms: true };

describe('computeLiveAreaBudget', () => {
  it('grants full sizes on a tall terminal', () => {
    const b = computeLiveAreaBudget(65, allPanels);
    expect(b).toEqual({ treeMaxRows: 10, showTimeline: true, costCompact: false, commsMaxEvents: 4, collapsed: false });
  });

  it('compacts the cost panel and comms feed before shrinking the tree', () => {
    const b = computeLiveAreaBudget(43, allPanels);
    expect(b.costCompact).toBe(true);
    expect(b.commsMaxEvents).toBe(2);
    expect(b.treeMaxRows).toBe(10);
    expect(b.collapsed).toBe(true);
  });

  it('shrinks the tree and drops the timeline on small terminals', () => {
    const b = computeLiveAreaBudget(28, allPanels);
    expect(b.treeMaxRows).toBeLessThanOrEqual(4);
    expect(b.showTimeline).toBe(false);
  });

  it('never returns a tree budget below 2 rows, even on tiny terminals', () => {
    const b = computeLiveAreaBudget(10, allPanels);
    expect(b.treeMaxRows).toBeGreaterThanOrEqual(2);
    expect(b.commsMaxEvents).toBe(0);
    expect(b.collapsed).toBe(true);
  });

  it('reserves space for the slash suggestion panel while typing a command', () => {
    const tall = computeLiveAreaBudget(45, { ...allPanels, isTypingCommand: false });
    const typing = computeLiveAreaBudget(45, { ...allPanels, isTypingCommand: true });
    expect(typing.treeMaxRows).toBeLessThanOrEqual(tall.treeMaxRows);
  });

  it('grants no comms rows when the feed is not requested', () => {
    const b = computeLiveAreaBudget(65, { ...allPanels, showComms: false });
    expect(b.commsMaxEvents).toBe(0);
    expect(b.treeMaxRows).toBe(10);
  });

  it('handles non-finite row counts (no TTY) with a sane default', () => {
    const b = computeLiveAreaBudget(NaN, allPanels);
    expect(b.treeMaxRows).toBeGreaterThan(0);
  });

  it('keeps the worst-case live area within the terminal height', () => {
    // fixed chrome (5) + stream tail (9) + slash panel (11) = 25 reserved
    for (const rows of [15, 20, 24, 30, 35, 40, 50, 80]) {
      const b = computeLiveAreaBudget(rows, { isTypingCommand: true, showCost: true, showDetails: true, showComms: true });
      const panels = b.treeMaxRows
        + (b.showTimeline ? 4 : 0)
        + (b.costCompact ? 6 : 18)
        + (b.commsMaxEvents > 0 ? b.commsMaxEvents + 1 : 0);
      // On terminals tall enough to fit the minimum layout, the total must fit.
      if (rows >= 25 + 2 + 2 + 6) {
        expect(panels + 25, `rows=${rows}`).toBeLessThanOrEqual(rows);
      }
    }
  });
});

describe('computeAdaptiveLayoutMode', () => {
  it('uses the full orchestration layout only on wide, tall terminals', () => {
    expect(computeAdaptiveLayoutMode(120, 32)).toBe('wide');
    expect(computeAdaptiveLayoutMode(160, 50)).toBe('wide');
  });

  it('uses the compact tree layout for medium terminals', () => {
    expect(computeAdaptiveLayoutMode(100, 40)).toBe('medium');
    expect(computeAdaptiveLayoutMode(140, 28)).toBe('medium');
  });

  it('uses a single execution summary on narrow or short terminals', () => {
    expect(computeAdaptiveLayoutMode(79, 40)).toBe('narrow');
    expect(computeAdaptiveLayoutMode(120, 23)).toBe('narrow');
  });
});

describe('alt-screen transcript', () => {
  const messages = [
    { role: 'user' as const, content: 'hello' },
    { role: 'assistant' as const, content: 'line one\nline two' },
  ];

  it('flattens messages into header + body + separator lines', () => {
    const lines = flattenTranscript(messages);
    expect(lines.map((l) => l.text)).toEqual(['USER', 'hello', '', 'ASSISTANT', 'line one', 'line two', '']);
    expect(lines[0]!.headerRole).toBe('user');
    expect(lines[1]!.headerRole).toBeUndefined();
  });

  it('pins the window to the newest lines at offset 0', () => {
    const w = windowTranscript([1, 2, 3, 4, 5], 0, 3);
    expect(w.visible).toEqual([3, 4, 5]);
    expect(w.above).toBe(2);
    expect(w.below).toBe(0);
  });

  it('scrolls up by the offset and reports lines below', () => {
    const w = windowTranscript([1, 2, 3, 4, 5], 2, 3);
    expect(w.visible).toEqual([1, 2, 3]);
    expect(w.above).toBe(0);
    expect(w.below).toBe(2);
  });

  it('clamps the offset so the window never runs past the top', () => {
    const w = windowTranscript([1, 2, 3, 4, 5], 99, 3);
    expect(w.visible).toEqual([1, 2, 3]);
    expect(w.clampedOffset).toBe(2);
  });

  it('shows everything when the window is larger than the list', () => {
    const w = windowTranscript([1, 2], 0, 10);
    expect(w.visible).toEqual([1, 2]);
    expect(w.above).toBe(0);
    expect(w.below).toBe(0);
  });

  it('gives the transcript the rows the live panels leave over', () => {
    const opts = { isTypingCommand: false, showCost: false, showDetails: false, showComms: false };
    const budget = computeLiveAreaBudget(50, opts);
    const rows = computeTranscriptRows(50, budget, { ...opts, treeVisible: false });
    // fixed (5) + stream (9) + indicators (2) + margin (2) = 18 used
    expect(rows).toBe(50 - 18);
    // And it never goes below the readable minimum.
    expect(computeTranscriptRows(12, budget, { ...opts, treeVisible: true })).toBe(4);
  });
});
