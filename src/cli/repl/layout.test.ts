import { describe, expect, it } from 'vitest';
import { computeLiveAreaBudget } from './layout.js';

const allPanels = { isTypingCommand: false, showCost: true, showDetails: true };

describe('computeLiveAreaBudget', () => {
  it('grants full sizes on a tall terminal', () => {
    const b = computeLiveAreaBudget(60, allPanels);
    expect(b).toEqual({ treeMaxRows: 10, showTimeline: true, costCompact: false, collapsed: false });
  });

  it('compacts the cost panel before shrinking the tree', () => {
    const b = computeLiveAreaBudget(40, allPanels);
    expect(b.costCompact).toBe(true);
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
    expect(b.collapsed).toBe(true);
  });

  it('reserves space for the slash suggestion panel while typing a command', () => {
    const tall = computeLiveAreaBudget(45, { ...allPanels, isTypingCommand: false });
    const typing = computeLiveAreaBudget(45, { ...allPanels, isTypingCommand: true });
    expect(typing.treeMaxRows).toBeLessThanOrEqual(tall.treeMaxRows);
  });

  it('handles non-finite row counts (no TTY) with a sane default', () => {
    const b = computeLiveAreaBudget(NaN, allPanels);
    expect(b.treeMaxRows).toBeGreaterThan(0);
  });

  it('keeps the worst-case live area within the terminal height', () => {
    // fixed chrome (5) + stream tail (9) + slash panel (11) = 25 reserved
    for (const rows of [15, 20, 24, 30, 35, 40, 50, 80]) {
      const b = computeLiveAreaBudget(rows, { isTypingCommand: true, showCost: true, showDetails: true });
      const panels = b.treeMaxRows
        + (b.showTimeline ? 4 : 0)
        + (b.costCompact ? 6 : 18);
      // On terminals tall enough to fit the minimum layout, the total must fit.
      if (rows >= 25 + 2 + 2 + 6) {
        expect(panels + 25, `rows=${rows}`).toBeLessThanOrEqual(rows);
      }
    }
  });
});
