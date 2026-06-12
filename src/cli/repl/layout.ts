// ─────────────────────────────────────────────
//  Cascade AI — REPL live-area layout budget
// ─────────────────────────────────────────────
//
//  Ink falls back to clearing and redrawing the ENTIRE screen whenever the
//  live region grows taller than the terminal — that full-screen redraw is
//  the flicker users see on small or busy terminals, and it also destroys
//  any in-progress mouse selection. This module computes how many rows each
//  live panel may use so the live region always fits in the viewport.
//
//  Pure functions only — unit-testable without a TTY.

/** Rows always present in the live area regardless of panels. */
const FIXED_CHROME_ROWS =
  1 + // StatusBar
  1 + // HintBar
  3;  // input box (border top + line + border bottom)

/** Rows the streaming tail can occupy while a response is generating. */
const STREAM_TAIL_ROWS = 9; // header line + 8 tail lines

/** Slash suggestion panel fixed height (header + 8 entries + indicators). */
const SLASH_PANEL_ROWS = 11;

export interface LiveAreaBudget {
  /** Max rows the AgentTree may render (its internal scroll handles overflow). */
  treeMaxRows: number;
  /** Whether the TimelinePanel fits at all. */
  showTimeline: boolean;
  /** Render CostTracker in compact (summary-only) mode. */
  costCompact: boolean;
  /** Events the PeerFeed may show (panel adds 1 header row); 0 hides it. */
  commsMaxEvents: number;
  /** True when panels were shrunk/hidden because the terminal is small. */
  collapsed: boolean;
}

export interface LiveAreaOptions {
  isTypingCommand: boolean;
  showCost: boolean;
  showDetails: boolean;
  /** Whether the agent-to-agent comms feed wants to render. */
  showComms: boolean;
}

const TREE_ROWS_FULL = 10;
const TREE_ROWS_COMPACT = 4;
const TIMELINE_ROWS = 4;
const COST_ROWS_FULL = 18;
const COST_ROWS_COMPACT = 6;
const COMMS_EVENTS_FULL = 4;    // + 1 header row
const COMMS_EVENTS_COMPACT = 2; // + 1 header row

/**
 * Compute per-panel row budgets so the worst-case live area stays within
 * `rows - 2` (leave a couple of rows of breathing room for wraps).
 */
export function computeLiveAreaBudget(rows: number, opts: LiveAreaOptions): LiveAreaBudget {
  const safeRows = Number.isFinite(rows) && rows > 0 ? rows : 40;

  const fixed = FIXED_CHROME_ROWS
    + STREAM_TAIL_ROWS
    + (opts.isTypingCommand ? SLASH_PANEL_ROWS : 0);

  let available = safeRows - 2 - fixed;

  const fullCost = opts.showCost ? COST_ROWS_FULL : 0;
  const compactCost = opts.showCost ? COST_ROWS_COMPACT : 0;
  const fullTimeline = opts.showDetails ? TIMELINE_ROWS : 0;
  const fullComms = opts.showComms ? COMMS_EVENTS_FULL + 1 : 0;
  const compactComms = opts.showComms ? COMMS_EVENTS_COMPACT + 1 : 0;

  // Generous terminal: everything at full size.
  if (available >= TREE_ROWS_FULL + fullTimeline + fullCost + fullComms) {
    return {
      treeMaxRows: TREE_ROWS_FULL,
      showTimeline: opts.showDetails,
      costCompact: false,
      commsMaxEvents: opts.showComms ? COMMS_EVENTS_FULL : 0,
      collapsed: false,
    };
  }

  // Shrink in priority order: compact the cost panel, then the comms feed,
  // then the tree, then drop the timeline, and finally drop the comms feed.
  // Tree and comms are the signature visuals — keep them the longest.
  if (available >= TREE_ROWS_FULL + fullTimeline + compactCost + compactComms) {
    return { treeMaxRows: TREE_ROWS_FULL, showTimeline: opts.showDetails, costCompact: true, commsMaxEvents: opts.showComms ? COMMS_EVENTS_COMPACT : 0, collapsed: true };
  }
  if (available >= TREE_ROWS_COMPACT + fullTimeline + compactCost + compactComms) {
    return { treeMaxRows: TREE_ROWS_COMPACT, showTimeline: opts.showDetails, costCompact: true, commsMaxEvents: opts.showComms ? COMMS_EVENTS_COMPACT : 0, collapsed: true };
  }
  if (available >= TREE_ROWS_COMPACT + compactCost + compactComms) {
    return { treeMaxRows: TREE_ROWS_COMPACT, showTimeline: false, costCompact: true, commsMaxEvents: opts.showComms ? COMMS_EVENTS_COMPACT : 0, collapsed: true };
  }
  if (available >= TREE_ROWS_COMPACT + compactCost) {
    return { treeMaxRows: TREE_ROWS_COMPACT, showTimeline: false, costCompact: true, commsMaxEvents: 0, collapsed: true };
  }

  // Tiny terminal: minimum viable layout.
  available = Math.max(available, 0);
  return {
    treeMaxRows: Math.max(2, Math.min(TREE_ROWS_COMPACT, available)),
    showTimeline: false,
    costCompact: true,
    commsMaxEvents: 0,
    collapsed: true,
  };
}
